#!/usr/bin/env node
/**
 * 用途：用 serper.dev（Google SERP 的 JSON API）取一个关键词的谷歌第一页，
 *       输出 organic 前 N 条 + relatedSearches + peopleAlsoAsk，
 *       并派生两个供回读的计数：
 *         (a) 前十里有几个站是**拿这个词当主域名**的（域名主标签命中词素）；
 *         (b) 前十里有几个是首页、有几个是内页。
 *       relatedSearches / peopleAlsoAsk 用于问法补漏，再喂回本脚本取 Google 证据；
 *       下游读法见 references/seo-serp.md「逐问法 Google 读法」，不自动给出裁决。
 *
 * 示例：
 *   node serp-query.mjs "ai photo editor"
 *   node serp-query.mjs "pdf to markdown" --gl us --hl en --num 20
 *   node serp-query.mjs "invoice generator" --json --out out/serp.json
 *   node serp-query.mjs "logo maker" --expand          # 只打印可拿去继续挖的词
 *
 * 依赖：serper.dev 的 API key。读取顺序：环境变量 SERPER_API_KEY → rankup/.env
 *       的 `SERPER_API_KEY=` 那一行。自助注册领 key：https://serper.dev/
 *       （本脚本不会、也不应该代替你注册账号。）
 *
 * 已验证日期：2026-08-23
 *   - 无 key / 错 key 的行为已实测（见「已知坑」），端点与鉴权头名确认无误；
 *   - 带 key 的成功响应**未实测**：本机没有 key，且注册账号属于禁止动作。
 *     响应字段按官方文档与多个开源客户端的读法写，解析全部做了防御（缺字段不崩）。
 *
 * 已知坑：
 *   - 鉴权头是 `X-API-KEY`，不是 Authorization。缺头和错 key 的报错**不一样**，
 *     两条都实测过：缺头 403 {"message":"Unauthorized. Sign up for a free account."}，
 *     错 key 403 {"message":"Unauthorized."}。看到后者说明 key 装上了但是无效，
 *     别再去查环境变量有没有读到。
 *   - `num` 超过 10 时**一次查询扣 2 个额度**（11–100 都算 2）。默认 10 是省钱的。
 *   - relatedSearches / peopleAlsoAsk / answerBox / knowledgeGraph **不保证出现**，
 *     谷歌该词的 SERP 没有这些模块时字段直接缺失，不是空数组。全部按可缺处理。
 *   - 「主域名命中」是启发式，不是事实：它只看域名主标签里有没有关键词的实义词素。
 *     怎么判读（连同首页/内页构成）移进了 references/seo-serp.md「逐问法 Google 读法」——
 *     脚本只出计数，结论归读结果的人（2026-08-30 重构第二波）。
 *   - 原始 serper 响应**每次运行都会**原样落进证据目录（成功也落），
 *     解析或派生字段哪天错了，raw JSON 还能对质。
 */

import { parseArgs, readToken, writeOut, printTable, die, initEvidence, saveEvidence, writeManifest, recordSource } from './_lib.mjs';

const ENDPOINT = 'https://google.serper.dev/search';
const KEY_NAME = 'SERPER_API_KEY';

/** 域名匹配时要忽略的词：几乎每个域名都能"命中"它们，留着只会虚高 */
const STOP = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'by',
  'free', 'online', 'best', 'top', 'my', 'your', 'how', 'what', 'is', 'are',
  'vs', 'app', 'tool', 'tools', 'website', 'site',
]);

const HELP = `serp-query.mjs —— serper.dev Google SERP 查询 + 问法补漏计数

用法:
  node serp-query.mjs <keyword> [选项]

选项:
  --gl <cc>       国家码，默认 us
  --hl <lang>     语言码，默认 en
  --num <n>       organic 条数，默认 10。**大于 10 会扣 2 个额度而不是 1 个**
  --page <n>      第几页，默认 1
  --location <s>  城市级地理位置，如 "New York, United States"（可选）
  --expand        只输出可继续挖的词（relatedSearches + peopleAlsoAsk 的问题），一行一个
  --json          输出结构化 JSON（含派生计数）
  --out <file>    落盘；.jsonl 走 JSON Lines，其它走 pretty JSON
  --help          本帮助

鉴权:
  环境变量 ${KEY_NAME}，或写进 rankup/.env 的一行 \`${KEY_NAME}=...\`。
  自助领 key：https://serper.dev/ （免费额度 2500 次查询，无需信用卡）。

派生计数（表格底部会打印，只是计数不是结论）:
  · 精确域名命中 / 部分域名命中：前十里有几个站把这个词做进了主域名
  · 首页数 / 内页数
  这些数怎么读（domainMatch 是启发式、首页/内页构成意味着什么），
  见 rankup/references/seo-serp.md「逐问法 Google 读法」。
  relatedSearches / peopleAlsoAsk 用于问法补漏，每条长尾问法分别取 Google 证据。
  原始 serper 响应每次都会落进证据目录（--evidence-dir 可指定落点）。
`;

/** 从 URL 取「主标签」：www.foo-bar.co.uk → foobar（去掉 www / 公共后缀 / 非字母数字） */
function mainLabel(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  // 二级公共后缀（co.uk / com.cn ...）时主标签往前挪一位
  const twoLevel = parts.length >= 3 && /^(co|com|net|org|gov|edu|ac)$/.test(parts[parts.length - 2]);
  const label = parts[parts.length - (twoLevel ? 3 : 2)] || parts[0] || '';
  return label.replace(/[^a-z0-9]/g, '');
}

function tokens(keyword) {
  return String(keyword)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

/** 路径是 / 或空、且没有 query，才算首页 */
function isHomepage(link) {
  try {
    const u = new URL(link);
    return (u.pathname === '/' || u.pathname === '') && !u.search;
  } catch {
    return false;
  }
}

function classify(link, toks) {
  let host = '';
  try { host = new URL(link).hostname; } catch { /* 非法 URL 就当没有 host */ }
  const label = mainLabel(host);
  const hits = toks.filter((t) => label.includes(t));
  return {
    host: host.replace(/^www\./, ''),
    label,
    homepage: isHomepage(link),
    // 全部实义词素都在主标签里 = 精确；命中一部分 = 部分
    domainMatch: toks.length && hits.length === toks.length ? 'exact' : hits.length ? 'partial' : 'none',
    matchedTokens: hits,
  };
}

async function query(key, body) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  // 恒 dump 原始响应（成功也 dump）：解析/字段派生哪天错了，原始 JSON 还在。
  const rawFile = saveEvidence(`serper-raw-${Date.now()}-${res.status}.json`, txt);
  recordSource({ source: `serper:${body.q}`, status: res.ok ? 'ok' : `http_${res.status}`, raw: rawFile });
  let data = null;
  try { data = JSON.parse(txt); } catch { /* 保持 null，下面统一报 */ }
  if (res.status === 403) {
    die(
      `serper.dev 拒绝了这次调用（403 ${data?.message ?? txt.slice(0, 120)}）。\n` +
      (/Sign up/i.test(txt)
        ? `  服务端说的是「没带 key」——${KEY_NAME} 没读到，或者头名写错了（必须是 X-API-KEY）。`
        : `  服务端说的是「key 无效」——key 装上了但不被认可，去 https://serper.dev/ 核对或重置。`),
    );
  }
  if (!res.ok || !data) {
    die(`serper.dev HTTP ${res.status}：${txt.slice(0, 200)}`);
  }
  return data;
}

async function main() {
  const args = parseArgs();
  if (args.help || !args._.length) { console.log(HELP); process.exit(args.help ? 0 : 1); }

  const keyword = args._.join(' ').trim();
  const num = Number(args.num ?? 10);
  if (!Number.isFinite(num) || num < 1 || num > 100) die('--num 必须是 1–100 的整数');
  initEvidence('serp-query', { dir: args['evidence-dir'] ?? null });

  const key = readToken(KEY_NAME);
  if (!key) {
    die(
      `没有 serper.dev 的 API key，仅此可选 API 兜底不可用；公开 SERP 继续走浏览器。\n` +
      `  1) 用浏览器：opencli google search ${JSON.stringify(keyword)} --lang en --limit 10 -f json\n` +
      `     其他浏览器路线见 references/seo-serp.md「SERP 取数路线」；不要停下问用户要 key。\n` +
      `  2) 可选兜底：已有授权与额度时，用 serper.dev（${KEY_NAME}）或官方 gefei CLI 的 serp；\n` +
      `     serper key 可放环境变量或 rankup/.env；它不是 SERP 取数的前置条件。`,
    );
  }

  const body = { q: keyword, gl: args.gl || 'us', hl: args.hl || 'en', num, page: Number(args.page ?? 1) };
  if (args.location) body.location = args.location;

  const data = await query(key, body);

  const toks = tokens(keyword);
  const organic = (data.organic || []).map((r, i) => {
    const c = classify(r.link, toks);
    return {
      position: r.position ?? i + 1,
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
      date: r.date ?? null,
      domain: c.host,
      pageType: c.homepage ? '首页' : '内页',
      domainMatch: c.domainMatch,
      matchedTokens: c.matchedTokens,
    };
  });

  const related = (data.relatedSearches || []).map((r) => (typeof r === 'string' ? r : r.query)).filter(Boolean);
  const paa = (data.peopleAlsoAsk || []).map((r) => ({
    question: r.question ?? '',
    snippet: r.snippet ?? '',
    link: r.link ?? '',
  }));

  // 派生判断只看前十——第二页之后的盘面对「这个词好不好切」没有解释力
  const top = organic.slice(0, 10);
  const derived = {
    consideredTop: top.length,
    exactDomainMatch: top.filter((r) => r.domainMatch === 'exact').length,
    partialDomainMatch: top.filter((r) => r.domainMatch === 'partial').length,
    homepages: top.filter((r) => r.pageType === '首页').length,
    innerPages: top.filter((r) => r.pageType === '内页').length,
    hasAnswerBox: Boolean(data.answerBox),
    hasKnowledgeGraph: Boolean(data.knowledgeGraph),
    relatedCount: related.length,
    paaCount: paa.length,
  };

  const result = {
    keyword,
    searchParameters: data.searchParameters ?? body,
    credits: data.credits ?? null, // serper 在响应里回传本次扣了几个额度
    derived,
    organic,
    relatedSearches: related,
    peopleAlsoAsk: paa,
  };

  if (args.out) {
    const p = writeOut(args.out, args.out.endsWith('.jsonl') ? [result] : result);
    if (!args.json && !args.expand) console.error(`已写入 ${p}`);
  }

  console.error(`manifest：${writeManifest('completed')}`);

  if (args.expand) {
    // 纯词表，方便 `| xargs -I{} node ~/.claude/skills/gefei/scripts/webcafe.mjs keyword_difficulty --keyword {}` 直接串起来
    for (const q of [...related, ...paa.map((p) => p.question)]) if (q) console.log(q);
    return;
  }
  if (args.json) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log(`关键词：${keyword}（gl=${body.gl} hl=${body.hl} num=${num}）` +
    (result.credits != null ? ` · 本次扣 ${result.credits} 额度` : ''));
  printTable(organic, [
    { key: 'position', label: '#', max: 3 },
    { key: 'domain', label: '域名', max: 28 },
    { key: 'pageType', label: '页型', max: 4 },
    { key: 'domainMatch', label: '域名命中', max: 8 },
    { key: 'title', label: '标题', max: 46 },
  ]);
  console.log(
    `\n前 ${derived.consideredTop} 名盘面：` +
    `域名精确命中 ${derived.exactDomainMatch} / 部分命中 ${derived.partialDomainMatch}` +
    ` · 首页 ${derived.homepages} / 内页 ${derived.innerPages}` +
    (derived.hasAnswerBox ? ' · 有答案框' : '') +
    (derived.hasKnowledgeGraph ? ' · 有知识图谱' : ''),
  );
  if (related.length) console.log(`\n相关搜索（${related.length}）：\n  ` + related.join('\n  '));
  if (paa.length) console.log(`\n大家还在问（${paa.length}）：\n  ` + paa.map((p) => p.question).join('\n  '));
  if (!related.length && !paa.length) {
    console.log('\n（这个词的 SERP 没有相关搜索/大家还在问模块——不是脚本没解析到，是谷歌没给。）');
  }
}

main().catch((e) => die(e?.message || String(e)));
