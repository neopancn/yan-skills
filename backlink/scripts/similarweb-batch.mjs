#!/usr/bin/env node
/**
 * similarweb-batch.mjs —— 一次登录，批量**采集**流量证据。只采集，不判断。
 *
 * 数据来源是**用户自己的 pro.similarweb.com**（同源 JSON API
 * `/api/WebsiteOverview/getheader`），不再是哥飞的共享面板 sim.3ue.co。
 * 理由与踩过的坑写在 lib-similarweb-pro.mjs 顶部；一句话：面板登录态已失效，
 * 而官方站上这条路返回结构化 JSON——不渲染、不解析虚拟表格、不受面板档位与
 * 共享配额影响，字段还更多（主流量国、公司规模、站点标题）。
 *
 * **输出是证据，不是判决。** 每域一行 JSONL：
 *   { domain, status, parse, stopReason, monthlyVisits, globalRank,
 *     country, countryRank, employeeRange, title, source,
 *     evidence: { screenshot, raw, screenshotError }, error, checkedAt }
 * `pass/fail/below-floor` 不产出——「查不到数据」只是 API 明说了空态
 * （stopReason: empty-state），是不是低流量由 AI 拿证据下判。
 * 行契约与完成语义见 lib-batch-evidence.mjs。
 *
 * **没有渲染，就没有「延迟加载 / 窗口被改写 / 这个标签页到底选没选中」这一整类问题。**
 * 面板时代那些字段（windowLabel / windowRequested / windowMatchesRequest /
 * scope-mismatch / unconfirmed*）随面板一起删掉了：Pro 的 `monthlyVisits` 是
 * Similarweb 自己算的月度值，跟 UI 上看到的同源，不存在「请求 28d 落地成 6 个月」。
 *
 * 三条硬约束，照抄别改：
 *   1. **同步前台跑，不许后台化。** 这是一长串网络调用，后台化之后没有任何东西会叫醒
 *      调用方，任务会在写下零行输出的情况下"完成"。要跑很久就调大超时，不要放后台。
 *   2. **每测完一个域名立刻追加写盘（JSONL）**，该域这次的 API 原始头部 JSON 落进
 *      `<out>.evidence/`。中途挂掉时已测的部分必须留下现场。
 *   3. **可续跑。** 启动时读一遍输出文件，stopReason 已完成（stable/empty-state）的
 *      域名直接跳过；未完成（exception）的重测。旧格式行（verdict 字段）按 legacy
 *      规则识别，verdict=error 视为未完成。
 *
 * 「没有数据」的空态由 API 自己说明：未被收录的站在 getheader 上返回
 * `globalRanking: 0` 且不带 `monthlyVisits`——那是「SimilarWeb 无数据」，
 * 不是流量为 0，落盘写成 status=no-data / 字段 null。
 *
 * 用法：
 *   node scripts/similarweb-batch.mjs --domains-file d.txt --out traffic.jsonl
 *   node scripts/similarweb-batch.mjs --domains a.com,b.com --out traffic.jsonl
 *   # 证据落在 traffic.jsonl.evidence/<domain>.txt（该域 API 头部 JSON 原文）
 *   可选：--chunk 10 --wait 6 --session x --profile <id> --window background
 *        --timeout 180000 --keep-open --self-test
 *
 * 【必须知道的两条】
 * 1. **登录态在独立的 opencli profile 里**（默认 msht4gxm），脚本会显式钉住它。
 *    用错档 / 登录态失效的症状是「页面落到登录页，每个请求都返回 HTML」——
 *    脚本在落地那一刻就断言域名，不让它一路伪装成「这些域名都没数据」。
 * 2. **每 chunk 一次 CLI 调用、页内循环**：一个 chunk 的域名在同一个页面上下文里
 *    逐个发请求，省掉每域名一次进程启动。整块失败 = 会话/登录态死了，不是域名的问题。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { closeSession, parseFlags, required, resolveSession, showHelpIfRequested } from './opencli-core.mjs';
import {
  openSimilarwebPro, proEval, resolveSimilarwebProProfile, SW_PRO_HEADERS_JS,
} from './lib-similarweb-pro.mjs';
import { isRowComplete, writeRawEvidence } from './lib-batch-evidence.mjs';

const SOURCE = 'similarweb-pro getheader';

const flags = parseFlags(process.argv.slice(2));
showHelpIfRequested(flags, import.meta.url);

function normalizeDomain(value) {
  const c = value.includes('://') ? new URL(value).hostname : value.split('/')[0];
  const n = c.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,63}$/.test(n) ? n : null;
}

/** 一个 chunk 的取数表达式：在页面上下文里对每个域名发一次 getheader，逐域兜住异常。 */
function fetchExpr(domains) {
  return `(async () => {
  const ds = ${JSON.stringify(domains)};
  const H = ${SW_PRO_HEADERS_JS};
  const out = [];
  for (const d of ds) {
    try {
      const r = await fetch("/api/WebsiteOverview/getheader?keys=" + encodeURIComponent(d) + "&mainDomainOnly=true&includeCrossData=true", { credentials: "include", headers: H });
      const t = await r.text();
      if (!r.ok) { out.push({ domain: d, error: "HTTP " + r.status + ": " + t.slice(0, 150) }); continue; }
      let j;
      try { j = JSON.parse(t); } catch { out.push({ domain: d, error: "non-JSON body: " + t.slice(0, 150) }); continue; }
      out.push({ domain: d, data: j[d] || Object.values(j)[0] || {} });
    } catch (e) { out.push({ domain: d, error: String(e).slice(0, 200) }); }
  }
  return JSON.stringify(out);
})()`;
}

function exceptionRow(domain, message) {
  return {
    domain,
    status: 'exception',
    parse: 'none',
    stopReason: 'exception',
    monthlyVisits: null, globalRank: null, country: null, countryRank: null,
    employeeRange: null, title: null,
    source: SOURCE,
    evidence: { screenshot: null, raw: null, screenshotError: null },
    error: String(message).slice(0, 300),
    checkedAt: new Date().toISOString(),
  };
}

/** API 头部记录 → 本仓库的批量行（**纯函数，不碰 IO**：evidence 由调用方补）。 */
export function headerRow(entry) {
  if (entry?.error) return exceptionRow(entry.domain, entry.error);
  const data = entry?.data || {};
  // 只认真的数字：null 经 Number() 会变成 0，那样「没有数据」会被写成「流量 0」。
  const visits = Number.isFinite(data.monthlyVisits) ? Math.round(data.monthlyVisits) : null;
  const rank = Number.isFinite(data.globalRanking) && data.globalRanking > 0 ? data.globalRanking : null;
  const noData = visits === null && rank === null;
  return {
    domain: entry.domain,
    status: noData ? 'no-data' : 'ok',
    parse: noData ? 'no-data-marker' : 'parsed',
    stopReason: noData ? 'empty-state' : 'stable',
    monthlyVisits: visits,
    globalRank: rank,
    country: data.highestTrafficCountry || null,
    countryRank: Number.isFinite(data.highestTrafficCountryRanking) ? data.highestTrafficCountryRanking : null,
    employeeRange: data.employeeRange || null,
    title: data.title || null,
    source: SOURCE,
    evidence: { screenshot: null, raw: null, screenshotError: null },
    error: null,
    checkedAt: new Date().toISOString(),
  };
}

if (flags['self-test']) {
  // 1) 数字判定：0 与缺失必须分得开——`globalRanking: 0` 是「无数据」（真的有这个数），
  //    而 `monthlyVisits: null` 是「没有这个值」，两者都不能被写成 0。
  const rows = [
    { domain: 'a.com', data: { monthlyVisits: 350000, globalRanking: 1234, highestTrafficCountry: 'US', highestTrafficCountryRanking: 567 } },
    { domain: 'b.com', data: { globalRanking: 0 } },
    { domain: 'c.com', error: 'HTTP 500: boom' },
  ].map(headerRow);
  const ok = rows[0].stopReason === 'stable' && rows[0].parse === 'parsed' && rows[0].monthlyVisits === 350000
    && rows[0].globalRank === 1234 && rows[0].country === 'US' && rows[0].countryRank === 567
    && rows[1].stopReason === 'empty-state' && rows[1].monthlyVisits === null && rows[1].globalRank === null
    && rows[1].status === 'no-data'
    && rows[2].stopReason === 'exception' && rows[2].parse === 'none';
  if (!ok) throw new Error(`similarweb-batch self-test failed [map]: ${JSON.stringify(rows)}`);
  // 2) 续跑语义：完成的行跳过，未完成的（exception）重测。
  if (!isRowComplete({ stopReason: 'stable' }) || !isRowComplete({ stopReason: 'empty-state' })) {
    throw new Error('similarweb-batch self-test failed [resume]: stable/empty-state must count as complete');
  }
  if (isRowComplete({ stopReason: 'exception' })) {
    throw new Error('similarweb-batch self-test failed [resume]: exception must be retried');
  }
  console.log('similarweb-batch self-test: PASS');
  process.exit(0);
}

const outPath = required(flags, 'out');
// 配额站纪律：会话名固定 similarweb-nav（见 opencli-core 的 QUOTA_SITES）。
const session = resolveSession(flags, 'sw-batch', 'similarweb');
const profile = resolveSimilarwebProProfile(flags);
// 每个 chunk 的域名在同一个页面上下文里逐个发请求——一次 CLI 往返摊到 N 个域名。
const chunkSize = Math.max(1, Number(flags.chunk || 10));
const openWait = Number(flags.wait || 6);
const evalTimeoutMs = Number(flags.timeout || 180_000);
// 同源 fetch 不依赖页面渲染，所以默认用不抢焦点的 background。
const windowMode = typeof flags.window === 'string' && flags.window ? flags.window : 'background';

const wanted = [];
{
  const raw = flags['domains-file']
    ? readFileSync(flags['domains-file'], 'utf8')
    : required(flags, 'domains').split(',').join('\n');
  for (const line of raw.split('\n')) {
    const d = normalizeDomain(line.trim());
    if (d && !wanted.includes(d)) wanted.push(d);
  }
}
if (!wanted.length) { console.error('[batch] 域名列表为空'); process.exit(1); }

// 续跑：已完成的域名不再测。**未完成不算跑过**——它是「这次没测成」，不是结论。
const done = new Set();
if (existsSync(outPath)) {
  for (const line of readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (isRowComplete(r)) done.add(r.domain);
    } catch { /* 半行，忽略 */ }
  }
}
const todo = wanted.filter((d) => !done.has(d));
console.error(`[batch] ${wanted.length} requested, ${done.size} already done, ${todo.length} to go`);
if (!todo.length) process.exit(0);

/**
 * 该域这次的现场：API 头部 JSON 原文落 evidence 目录。尽力而为——写不出证据
 * 不能反过来毁掉这一行采集，所以失败只记 screenshotError 字段。
 */
function rawEvidencePath(domain, data) {
  try {
    return writeRawEvidence({ outPath, domain, text: JSON.stringify(data, null, 2) });
  } catch (e) {
    console.error(`[batch] raw evidence failed for ${domain}: ${String(e.message || e).slice(0, 200)}`);
    return null;
  }
}

const chunks = [];
for (let i = 0; i < todo.length; i += chunkSize) chunks.push(todo.slice(i, i + chunkSize));

let stable = 0; let noData = 0; let failed = 0;
try {
  // 落地一次 + 断言落点在官方站：profile 用错 / 登录态失效会在这里当场抛，
  // 不用等整张表都返回 HTML 才发现。
  await openSimilarwebPro(session, null, { profile, windowMode, wait: openWait, timeoutMs: evalTimeoutMs });

  let consecutiveChunkFailures = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let payload;
    try {
      payload = await proEval(session, fetchExpr(chunk), { profile, windowMode, timeoutMs: evalTimeoutMs });
      if (!Array.isArray(payload)) throw new Error(`eval 返回形状不认识：${JSON.stringify(payload).slice(0, 200)}`);
    } catch (error) {
      consecutiveChunkFailures += 1;
      const message = String(error?.message || error).slice(0, 300);
      console.error(`[batch] chunk ${i + 1}/${chunks.length} 整块失败：${message}`);
      for (const domain of chunk) {
        appendFileSync(outPath, `${JSON.stringify(exceptionRow(domain, `chunk_failed: ${message}`))}\n`, 'utf8');
        failed += 1;
      }
      // 熔断：会话/登录态一旦死了，后面每个 chunk 都要付满一整个超时，而且全部记成未完成。
      // **连续整块失败就停下换新会话，不要跑完整张表。**
      if (consecutiveChunkFailures >= 3) {
        console.error(`[batch] ABORT: ${consecutiveChunkFailures} 个连续整块失败——是会话/登录态死了，不是这些域名的问题。`
          + '换新会话或重新登录 pro.similarweb.com 后重跑；exception 行会自动重测。');
        process.exit(3);
      }
      continue;
    }
    consecutiveChunkFailures = 0;
    for (const entry of payload) {
      const row = headerRow(entry);
      if (row.stopReason !== 'exception') row.evidence.raw = rawEvidencePath(row.domain, entry?.data || {});
      appendFileSync(outPath, `${JSON.stringify(row)}\n`, 'utf8');
      if (row.stopReason === 'stable') stable += 1;
      else if (row.stopReason === 'empty-state') noData += 1;
      else failed += 1;
      console.error(`[batch] ${row.domain} → ${row.stopReason}${row.monthlyVisits !== null ? ` (${row.monthlyVisits})` : ''}`);
    }
  }
} finally {
  if (!flags['keep-open']) await closeSession(session);
}

console.error(`[batch] done: ${stable} stable, ${noData} no-data, ${failed} incomplete → ${outPath}`);
if (failed) process.exitCode = 1;
