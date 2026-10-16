#!/usr/bin/env node
/**
 * similarweb-keywords.mjs —— 从一个种子词批量扩词（官方 SimilarWeb Pro）。
 *
 * 数据来源是**用户自己的 pro.similarweb.com**（同源 JSON API
 * `/api/KeywordGenerator/google/suggest`），不再是哥飞的共享面板 sim.3ue.co。
 * 理由与踩过的坑写在 lib-similarweb-pro.mjs 顶部；一句话：面板登录态已失效，
 * 而官方站上这条路不渲染、不解析虚拟表格，字段还更多。
 *
 * 它补的是选词流水线的入口。`rankup/references/experiences/demand-discovery.md`
 * 记的规模是「1,309 个词根 → SimilarWeb 扩出 97,681 个关键词」，而这一步此前完全
 * 没有脚本，整条流水线卡在源头。
 *
 * 用法：
 *   node similarweb-keywords.mjs --seed "nonogram"
 *   node similarweb-keywords.mjs --seed "nonogram" --tab relatedKeywords --out kw.json
 *   node similarweb-keywords.mjs --seed-file roots.txt --tab relatedKeywords --out kw.jsonl --jsonl
 *
 * 参数：
 *   --seed <词>            种子词（与 --seed-file 二选一）
 *   --seed-file <file>     一行一个种子词，批量跑；复用同一个标签页
 *   --tab <t>              phraseMatch（默认，词组匹配 → API type=Broad）
 *                          | relatedKeywords（相关词 → API type=Related）
 *                          **只有这两个**：这条 API 只认 Broad/Related，传
 *                          trending/questions 会 400（2026-10-13 实测），
 *                          所以那两个 tab 直接从 CLI 里删掉了，不假装支持。
 *   --country <code>       国家代码，默认 999（Similarweb 的 Worldwide）
 *   --out <file>           落盘；配 --jsonl 时一行一个词
 *   --jsonl                以 JSON Lines 输出词行，便于几万行的批量
 *   --profile <id>         持有 Pro 登录态的 Browser Bridge profile
 *                          （默认 msht4gxm，见 lib-similarweb-pro.mjs）
 *   --session <name>       忽略：similarweb 是配额站，会话名固定为 similarweb-nav
 *   --window <mode>        标签页窗口模式（默认 background）。**同源 fetch 不依赖
 *                          页面渲染**，所以这里可以放心用不抢焦点的 background
 *   --wait <s>             打开落地页后等几秒（默认 8）
 *   --timeout <ms>         单次 eval 超时（默认 60000）
 *   --keep-open            跑完保留标签页
 *   --self-test            离线自检
 *   --help
 *
 * 【必须知道的两条】
 * 1. **窗口是 28 天，且不由我们指定**：请求带 `isWindow=true&latest=28d`，
 *    实测 from/to 传什么（含完全不合理的日期）结果都一样——28d 口径由 API 自己
 *    钉死，跟 UI 的「28 Days Volume (As of ...)」同源。所以脚本里没有日期运算，
 *    也不存在「渲染出来的窗口跟请求的不一致」这种面板时代的问题。
 * 2. **本脚本一次最多读 100 行**（API 的 rowsPerPage 上限）。页面自报的总量写进
 *    `totalRecords`，`complete` 明确告诉你读全了没有——不做静默截断。
 *
 * 关于 KD（`difficulty`）：0 表示 **SimilarWeb 数据不足，不等于「好排」**——
 * 新词/长尾词大量是 0，别拿它当选词结论。这一列是官方 API 才有的（面板时代的
 * DOM 表格这一列读不到），所以本脚本输出里的 kd 比 keywords.md 里的旧值更可信。
 */
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import {
  closeSession, parseFlags, printJson, resolveSession, showHelpIfRequested,
} from './opencli-core.mjs';
import {
  openSimilarwebPro, resolveSimilarwebProProfile, SIMILARWEB_PRO_ORIGIN, swProRequest,
} from './lib-similarweb-pro.mjs';

const flags = parseFlags(process.argv.slice(2));
showHelpIfRequested(flags, import.meta.url);

/**
 * 标签页决定扩词口径。**这张映射是从 API 实测出来的**（2026-10-13）：
 * `type=Broad` 返回的 5 条与 UI `tab=phraseMatch` 渲染出的 5 条逐字一致；
 * `type=Related` 对应 UI 的 relatedKeywords（页面自己写着 "Related Keywords (3)"）。
 * `trending` / `questions` 传进 API 一律 400（响应体 `{"Type":...}`），
 * 所以不支持——要那两档得另找端点，届时再加，不在 CLI 里留空的假开关。
 */
const TAB_TO_TYPE = { phraseMatch: 'Broad', relatedKeywords: 'Related' };
const tab = String(flags.tab || 'phraseMatch');
if (!(tab in TAB_TO_TYPE)) {
  console.error(`--tab must be one of: ${Object.keys(TAB_TO_TYPE).join(', ')}`
    + '（trending/questions 在这条 API 上不存在，实测 400）');
  process.exit(2);
}
const type = TAB_TO_TYPE[tab];
const country = String(flags.country || '999');
const profile = resolveSimilarwebProProfile(flags);
const evalTimeoutMs = Number(flags.timeout || 60_000);

/** API 的上限。超过这个数只拿前 100 条，`totalRecords` 会说清楚总共有多少。 */
const ROWS_PER_PAGE = 100;

export function suggestUrl(seed, { country: c = country, type: t = type } = {}) {
  const q = [
    `keyword=${encodeURIComponent(seed)}`,
    `country=${encodeURIComponent(c)}`,
    'from=1970%7C01%7C01', // 占位：见文件头「窗口是 28 天，且不由我们指定」
    'to=1970%7C01%7C01',
    'isWindow=true',
    'websource=Total',
    'sort=windowVolume',
    'asc=false',
    `rowsPerPage=${ROWS_PER_PAGE}`,
    `type=${encodeURIComponent(t)}`,
    'latest=28d',
  ].join('&');
  return `${SIMILARWEB_PRO_ORIGIN}/api/KeywordGenerator/google/suggest?${q}`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** API 记录 → 本仓库的词行。字段名沿用关键词表一直用的那一套。 */
export function mapSuggestRecords(records) {
  return (Array.isArray(records) ? records : []).map((r) => ({
    keyword: String(r?.keyword ?? '').trim(),
    volume28d: num(r?.windowVolume),
    avgVolume: num(r?.averageVolume),
    // difficulty 就是 UI 的 "Organic difficulty"；0 = 数据不足（≠好排）。
    kd: num(r?.difficulty),
    // latestZeroClicks 是 0~1 的比例，输出统一成百分比整数跟上表口径一致。
    zeroClickPercent: r?.latestZeroClicks == null ? null : Math.round(Number(r.latestZeroClicks) * 100),
    cpc: num(r?.cpc),
    clicks: num(r?.clicks),
    intent: [r?.primaryIntent, r?.secondaryIntent].map((x) => String(x ?? '').trim()).filter(Boolean),
    // 竞品线索：这个词当前排第一的站。站找词/竞品对照页的原料。
    leadingSite: r?.leadingSite ? String(r.leadingSite) : null,
    // "New" / "Up" / "Down" 之类的原始变动描述，以及逐月量，原样带出去。
    volumeChange: r?.volumeChangePresentation ? String(r.volumeChangePresentation) : null,
    volumeTrend: r?.volumeTrend && typeof r.volumeTrend === 'object' ? r.volumeTrend : null,
  })).filter((row) => row.keyword);
}

if (flags['self-test']) {
  // 1) tab → API type 只有实测确认的两档，其余必须在进浏览器之前就打住。
  if (TAB_TO_TYPE.phraseMatch !== 'Broad' || TAB_TO_TYPE.relatedKeywords !== 'Related') {
    throw new Error(`similarweb-keywords self-test failed: ${JSON.stringify(TAB_TO_TYPE)}`);
  }
  // 2) URL 拼装：关键字必须 URL 编码（种子词里空格/#/& 都很常见），窗口固定 28d。
  const url = suggestUrl('bolt to wordpress', { country: '999', type: 'Broad' });
  const urlOk = url.startsWith(`${SIMILARWEB_PRO_ORIGIN}/api/KeywordGenerator/google/suggest?`)
    && url.includes('keyword=bolt%20to%20wordpress')
    && url.includes('type=Broad')
    && url.includes('latest=28d')
    && url.includes('isWindow=true');
  if (!urlOk) throw new Error(`similarweb-keywords self-test failed [url]: ${url}`);

  // 3) 记录映射：0 与缺失必须分得开——`difficulty: 0` 是「数据不足」（真的有这个数），
  //    而 `latestZeroClicks: null` 是「没有这个值」，两者都不能被写成 0。
  const mapped = mapSuggestRecords([
    { keyword: 'bolt to wordpress', windowVolume: 180, averageVolume: 66, difficulty: 0, latestZeroClicks: 0.65, cpc: 0, clicks: 117.17, primaryIntent: 'NAV', secondaryIntent: 'INFO', leadingSite: 'uichemy.com', volumeChangePresentation: 'New', volumeTrend: { '2026-09': 147 } },
    { keyword: '', windowVolume: 5 },
    { keyword: 'no metrics' },
  ]);
  const mappedOk = mapped.length === 2
    && mapped[0].keyword === 'bolt to wordpress' && mapped[0].volume28d === 180
    && mapped[0].kd === 0 && mapped[0].zeroClickPercent === 65
    && mapped[0].intent.join('|') === 'NAV|INFO' && mapped[0].leadingSite === 'uichemy.com'
    && mapped[0].volumeTrend['2026-09'] === 147
    && mapped[1].volume28d === null && mapped[1].kd === null
    && mapped[1].zeroClickPercent === null && mapped[1].intent.length === 0;
  if (!mappedOk) throw new Error(`similarweb-keywords self-test failed [map]: ${JSON.stringify(mapped)}`);

  console.log('similarweb-keywords self-test: PASS');
  process.exit(0);
}

const seeds = flags['seed-file']
  ? readFileSync(String(flags['seed-file']), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : [String(flags.seed || '').trim()].filter(Boolean);
if (!seeds.length) {
  console.error('--seed or --seed-file is required.');
  process.exit(2);
}

// 配额站纪律：会话名固定 similarweb-nav（见 opencli-core 的 QUOTA_SITES）。
const session = resolveSession(flags, 'similarweb-keywords', 'similarweb');
const windowMode = typeof flags.window === 'string' && flags.window ? flags.window : 'background';
const results = [];
try {
  // 一次落地，之后每个种子词只发一次同源请求——省掉每个词重走一遍导航。
  await openSimilarwebPro(session, null, { profile, windowMode, timeoutMs: evalTimeoutMs, wait: Number(flags.wait || 8) });
  for (const seed of seeds) {
    try {
      const payload = await swProRequest(session, suggestUrl(seed), {
        method: 'POST', body: '[]', profile, timeoutMs: evalTimeoutMs, what: `similarweb suggest "${seed}"`,
      });
      const rows = mapSuggestRecords(payload.records);
      const total = Number.isFinite(Number(payload.totalRecords)) ? Number(payload.totalRecords) : null;
      results.push({
        seed, tab, type, country, status: 'ok',
        totalRecords: total,
        totalVolume: num(payload.totalVolume),
        rows,
        rowsRead: rows.length,
        // 少读了必须说出来，别让调用方以为这就是全部。
        complete: total === null ? null : rows.length >= total,
        truncated: total === null ? null : rows.length < total,
      });
      if (total !== null && rows.length < total) {
        console.error(`[partial] ${seed} (${tab}): API 自报 ${total} 个词，本次只取回 ${rows.length} 个（rowsPerPage=${ROWS_PER_PAGE} 上限）。`);
      }
      const zeroKd = rows.filter((r) => r.kd === 0).length;
      if (zeroKd) {
        console.error(`[difficulty=0] ${seed} (${tab}): ${zeroKd}/${rows.length} 个词的 KD 是 0——那是「SimilarWeb 数据不足」，不是「好排」。`);
      }
      console.error(`[keywords] ${seed} (${tab}) → ${rows.length} 词，seed 28d 量 ${rows[0]?.volume28d ?? '-'}`);
    } catch (error) {
      results.push({ seed, tab, type, country, status: 'unavailable', error: { code: 'query_failed', message: String(error?.message || error) } });
      console.error(`[keywords] ${seed} (${tab}) → 失败：${String(error?.message || error).slice(0, 300)}`);
    }
  }
} finally {
  if (!flags['keep-open']) await closeSession(session);
}

const output = {
  version: 2,
  source: 'SimilarWeb Pro KeywordGenerator /api/KeywordGenerator/google/suggest (own pro.similarweb.com account)',
  retrievedAt: new Date().toISOString(),
  tab, type, country, session, profile,
  seeds: results,
};

if (flags.jsonl) {
  const lines = results.flatMap((r) => (r.rows || []).map((row) => JSON.stringify({ seed: r.seed, tab, country, ...row })));
  if (typeof flags.out === 'string') await writeFile(String(flags.out), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  else console.log(lines.join('\n'));
} else {
  if (typeof flags.out === 'string') await writeFile(String(flags.out), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  printJson(output);
}
// 任一没跑成就是非 0。**不再有 ok-unverified / scope-mismatch 这些面板时代的档位**：
// 现在读到的就是 API 自己算的 28d，没有「页面渲染出来的窗口跟请求的不一致」这回事。
if (results.some((r) => r.status !== 'ok')) process.exitCode = 1;
