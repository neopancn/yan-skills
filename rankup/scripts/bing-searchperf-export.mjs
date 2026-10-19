#!/usr/bin/env node
/**
 * bing-searchperf-export.mjs —— 从 Bing Webmaster Tools「搜索性能」页导出
 * 汇总数字、逐日点击/展现序列、以及 关键字/页面/设备/国家 四个维度的 Top 表。
 * 驱动用户自己已登录的浏览器（opencli），不需要 API key。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/bing-searchperf-export.mjs \
 *        --site https://app.neopan.cn --out .rankup/evidence/bing-searchperf-<ts> \
 *        [--range 90d] [--session 名] [--keep-session]
 *
 * --range：7d|30d|90d|180d|365d（映射 Bing 日期筛选 7 天/30 天/3 个月/…；默认 90d=3 个月，即页面默认档）
 *
 * 依赖：opencli + 用户浏览器已登录 Bing Webmaster（登录态与 GSC 同一个 profile）。
 *
 * ── 实测的坑（2026-10-17 首跑验证）────────────────────────────
 *
 * 1. **真实路由是 /webmasters/searchperf，不是 searchperformance。**
 *    旧 URL `/webmasters/searchperformance?siteUrl=…` 会渲染出完整导航但内容区
 *    只有「未找到任何页面」，不报 404 —— 像登录失效，其实是路由 404。
 *    判据：导航链接 a[href] 里「搜索性能」指向 /webmasters/searchperf。
 *
 * 2. **不要用 extract 读这个页面**（同 webmaster-sitemap 的坑）：内嵌 base64
 *    会把输出撑到百万字符级。一律 eval 取 innerText 切片。
 *
 * 3. **数据是异步加载的**：open 后 innerText 只有导航，需轮询等「总点击次数」
 *    出现；点日期筛选/tab 后同样要轮询，不能固定 sleep。
 *
 * 4. **数字是 K 缩写**（2.2K = 2200），解析时换算成数字，原始串同时保留。
 *
 * 5. 查询表里的字符串（如「没有账号？ 立即注册」）是真实用户搜索串，不是 UI
 *    文案泄漏，别过滤。表格按「5 行一组」解析：名称/展现/点击/点击率/排名，
 *    组内字段类型校验失败即停（防把分页器/页脚当数据行）。
 *
 * 6. **加载是「先骨架后数据」**：标签（总点击次数/日期行）先渲染、数值后填。
 *    锚点若只等标签文字，会在骨架态提前通过，读到全套空数据——表现就是
 *    「汇总空白、序列 0 天、四个维度 0 行」，全程零报错。必须等
 *    「汇总值能解析出来 && 序列有日期」才算加载完。
 *
 * 7. **Fluent UI 图标字形（U+E946 等私有区字符）在 innerText 里各占一行**，
 *    肉眼完全不可见。汇总标签和值之间、表头四连之间都夹着图标行——
 *    「标签的下一行就是值」「表头四行相邻」这两个解析前提全被它打断。
 *    pageText 必须先剥私有区/零宽字符再折叠空行（字符级实测：codes 10,59718,10）。
 *
 * 8. **维度 tab 切换有中间态**：表头先挂载、数据行后渲染。切完 tab 等到
 *    「表头出现」就读，会抓到 0 行假象。必须等 rows.length > 0。
 *
 * 已验证：2026-10-17（app.neopan.cn，90d+30d 两档，4 维度 + 逐日序列全出数）
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { newEvidenceDir, pollUntil } from "./lib-scene.mjs"
import { opencliRun } from "./lib-opencli.mjs"

// ── 参数 ──────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help")) { usage(); process.exit(0) }
let site = null, out = null, range = "90d", session = `bing-searchperf-${Math.random().toString(36).slice(2, 8)}`, keepSession = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--site" && argv[i + 1]) site = argv[++i].replace(/\/+$/, "")
  else if (a === "--out" && argv[i + 1]) out = argv[++i]
  else if (a === "--range" && argv[i + 1]) range = argv[++i]
  else if (a === "--session" && argv[i + 1]) session = argv[++i]
  else if (a === "--keep-session") keepSession = true
  else { console.error(`未知参数: ${a}`); usage(); process.exit(1) }
}
function usage() {
  console.log(`用法:
  node bing-searchperf-export.mjs --site <url> --out <目录> [--range 7d|30d|90d|180d|365d] [--session 名] [--keep-session]`)
}
if (!site || !out) { console.error("错误：需要 --site 和 --out"); usage(); process.exit(1) }

const RANGE = {
  "7d":   { zh: "7 天",    en: "7 days",    days: 7 },
  "30d":  { zh: "30 天",   en: "30 days",   days: 30 },
  "90d":  { zh: "3 个月",  en: "3 months",  days: 90 },
  "180d": { zh: "6 个月",  en: "6 months",  days: 180 },
  "365d": { zh: "12 个月", en: "12 months", days: 365 },
}
const rangeSpec = RANGE[range]
if (!rangeSpec) { console.error(`错误：--range 只支持 ${Object.keys(RANGE).join("/")}`); process.exit(1) }

// 文案表（界面语言跟账号走，zh 优先，en 兜底）
const L = {
  summary: {
    clicks:    ["总点击次数", "Total clicks"],
    impressions: ["总印象数", "Total impressions"],
    ctr:       ["平均 点击率", "平均点击率", "Average CTR"],
  },
  dims: [
    { key: "queries",  zh: "关键字",  en: "Queries" },
    { key: "pages",    zh: "页面",    en: "Pages" },
    { key: "devices",  zh: "设备",    en: "Devices" },
    { key: "countries", zh: "国家/地区", en: "Countries" },
  ],
  tableHeader: {
    imp: ["印象数", "Impressions"],
    clicks: ["点击次数", "Clicks"],
    ctr: ["点击率", "CTR"],
    pos: ["平均排名", "Avg. position", "Position"],
  },
  stopTokens: ["每个页面的行数", "Rows per page", "导出外链", "Download"],
}

// ── OpenCLI 封装（同 webmaster-sitemap：argv 直传，不走 shell 拼接）──
function cli(sub, payload = null, { timeout = 90000 } = {}) {
  const args = ["browser", session, "--window", "background", sub]
  if (payload !== null) args.push(payload)
  try {
    return opencliRun(args, { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const timedOut = e.killed || e.signal === "SIGTERM" || e.code === "ETIMEDOUT"
    const err = (e.stderr?.toString() || e.stdout?.toString() || "").trim()
      .split("\n").filter((l) => l.trim() && !/^\(node:\d+\)/.test(l)).join("\n")
    throw new Error(`opencli 失败: ${sub}${payload ? " " + payload : ""}\n  成因: ${timedOut ? `超时(>${timeout}ms)` : `退出码 ${e.status ?? "?"}`}${err ? `\n  输出: ${err}` : ""}`)
  }
}
/** eval 的 JS 一律包成 IIFE：eval 上下文跨调用持续，重复声明会抛错。 */
function evalJs(js, opts) { return cli("eval", `(()=>{${js}})()`, opts) }
// Fluent UI 图标字形占私有区（如 U+E946），innerText 里各占一行、肉眼不可见。
// 不剥掉的话：汇总标签的下一行是图标行（值取不到）、表头四连被图标行隔开（表格解析全灭）。
// 必须在折叠空行**之前**剥，图标行才会变成空行被一并折叠掉。
function pageText(max = 30000) {
  return evalJs(`return (document.querySelector('main')||document.body).innerText.replace(/[\\uE000-\\uF8FF\\u200B-\\u200F\\uFEFF\\uFE00-\\uFE0F]/g,'').replace(/\\n{2,}/g,'\\n').slice(0,${max})`)
}

/** 点一个 button[role=tab]（按精确文本，zh/en 候选逐个试）。 */
function clickTab(texts) {
  const js = `
    const want=${JSON.stringify(texts)};
    document.querySelectorAll('[data-rankup-tab]').forEach(e=>e.removeAttribute('data-rankup-tab'));
    const tabs=[...document.querySelectorAll('button[role=tab]')];
    const norm=e=>(e.innerText||'').trim();
    const el=tabs.find(e=>want.includes(norm(e)));
    if(!el) return 'NOT_FOUND:'+tabs.map(norm).filter(Boolean).slice(0,20).join('|');
    el.setAttribute('data-rankup-tab','1');
    return 'OK:'+norm(el);`
  const r = evalJs(js)
  if (r.startsWith("NOT_FOUND")) return { ok: false, available: r.slice("NOT_FOUND:".length) }
  cli("click", '[data-rankup-tab="1"]')
  return { ok: true, clicked: r.slice("OK:".length) }
}

// ── 解析 ──────────────────────────────────────────────────
const num = (s) => {
  if (s == null) return null
  const m = String(s).trim().match(/^([\d.,]+)\s*([KMB])?$/i)
  if (!m) return null
  let v = parseFloat(m[1].replace(/,/g, ""))
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()]
  return mult ? Math.round(v * mult) : v
}

/** 找「表头四连」（印象数/点击次数/点击率/平均排名）最后一次出现的位置。 */
function findHeader(lines) {
  const { imp, clicks, ctr, pos } = L.tableHeader
  for (let i = lines.length - 4; i >= 0; i--) {
    if (imp.includes(lines[i]) && clicks.includes(lines[i + 1]) && ctr.includes(lines[i + 2]) && pos.includes(lines[i + 3])) return i
  }
  return -1
}

/** 维度表：表头后按 5 行一组（名称/展现/点击/点击率/排名），类型校验失败即停。 */
function parseTable(lines) {
  const h = findHeader(lines)
  if (h < 0) return { rows: [], headerFound: false }
  const rows = []
  for (let i = h + 4; i + 4 < lines.length; i += 5) {
    const [name, imp, clicks, ctr, pos] = lines.slice(i, i + 5)
    if (L.stopTokens.includes(name)) break
    if (num(imp) == null || num(clicks) == null || !/%$/.test(ctr || "") || num(pos) == null) break
    rows.push({ name, impressions: num(imp), clicks: num(clicks), ctr: parseFloat(ctr) / 100, position: num(pos), raw: [imp, clicks, ctr, pos] })
  }
  return { rows, headerFound: true }
}

/** 逐日序列：找以「日期\t」开头的行 + 「总点击次数\t」「总印象数\t」两行。 */
function parseSeries(lines) {
  const dateLine = lines.find((l) => /^(日期|Date)\t/.test(l))
  if (!dateLine) return null
  const dates = dateLine.split("\t").slice(1)
  const row = (label) => {
    const line = lines.find((l) => l.startsWith(label + "\t"))
    if (!line) return null
    return line.split("\t").slice(1).map(num)
  }
  const clicks = row(L.summary.clicks[0]) ?? row(L.summary.clicks[1])
  const imps = row(L.summary.impressions[0]) ?? row(L.summary.impressions[1])
  // 骨架态：标签行渲染了但值还是空（dates=[""]、clicks=[null]）。当没加载完处理。
  if (!dates.length || !dates[0]) return null
  if (!clicks || !imps || clicks.length !== dates.length || imps.length !== dates.length) {
    return { dates, clicks, impressions: imps, aligned: false }
  }
  return {
    aligned: true,
    dates,
    clicks,
    impressions: imps,
    points: dates.map((d, i) => ({ date: d, clicks: clicks[i], impressions: imps[i] })),
  }
}

/** 汇总块：标签行独立成行，值在其下一行。 */
function parseSummary(lines) {
  const get = (labels) => {
    const idx = lines.findIndex((l) => labels.includes(l.trim()))
    return idx >= 0 ? { label: lines[idx], raw: lines[idx + 1], value: num(lines[idx + 1]) } : null
  }
  return {
    clicks: get(L.summary.clicks),
    impressions: get(L.summary.impressions),
    ctr: (() => {
      const idx = lines.findIndex((l) => L.summary.ctr.includes(l.trim().replace(/\s+/g, " ")))
      if (idx < 0) return null
      const raw = (lines[idx + 1] || "").replace("%", "")
      return { raw: lines[idx + 1], value: parseFloat(raw) / 100 }
    })(),
  }
}

// ── 主流程 ────────────────────────────────────────────────
const url = `https://www.bing.com/webmasters/searchperf?siteUrl=${encodeURIComponent(site + "/")}`
console.log(`Bing 搜索性能导出`)
console.log(`  站点: ${site}`)
console.log(`  范围: ${range}（${rangeSpec.zh}）`)
console.log(`  会话: ${session}`)
console.log(`  URL: ${url}`)

try {
  cli("open", url)
  // 坑 3（+骨架态坑 6）：异步加载分两段——先渲染标签骨架（总点击次数/日期行都在但值为空），
  // 后填数据。锚点必须等「汇总值能解析出来」，只等标签会在骨架态提前通过。
  const loaded = pollUntil(() => {
    try {
      const lines = pageText(6000).split("\n")
      const s = parseSummary(lines)
      const d = parseSeries(lines)
      return s?.clicks?.value != null && d?.dates?.length > 0
    } catch { return false }
  }, { timeoutMs: 60000, intervalMs: 2000 })
  if (!loaded) {
    const sample = (() => { try { return pageText(800) } catch { return "（取不到）" } })()
    throw new Error(`60 秒内没等到汇总块有值。登录态失效、站点不对、或路由 404 都长这样——页面文本前 800 字：\n${sample}\n注意：真实路由是 /webmasters/searchperf，不是 searchperformance。`)
  }

  // 日期筛选：默认 3 个月；非默认先点再等序列天数变化
  const wantDays = rangeSpec.days
  const seriesNow = () => { try { return parseSeries(pageText(30000).split("\n")) } catch { return null } }
  const dayCount = (s) => (s?.dates?.length) ?? 0
  if (range !== "90d") {
    const r = clickTab([rangeSpec.zh, rangeSpec.en])
    if (!r.ok) throw new Error(`找不到日期筛选「${rangeSpec.zh}/${rangeSpec.en}」，页面上的 tab：${r.available}`)
    const changed = pollUntil(() => {
      const s = seriesNow()
      return s?.dates?.length && Math.abs(s.dates.length - wantDays) <= 2
    }, { timeoutMs: 30000, intervalMs: 2000 })
    if (!changed) console.error(`警告：点击日期筛选后 ${30}s 内序列天数没变成 ~${wantDays}（当前 ${dayCount(seriesNow())}），数据可能是旧档`)
  }

  const text = pageText(30000)
  const lines = text.split("\n")
  const summary = parseSummary(lines)
  const series = seriesNow()

  // 四个维度逐个点、逐个读。关键字是默认 tab，第一个不用点。
  // 坑 8：tab 切换有中间态——表头已挂载、数据行还没渲染，等到表头就读会得到
  // 「0 行假象」（全程零报错）。必须等到 rows.length > 0，并复用那次解析结果。
  const dims = {}
  for (let d = 0; d < L.dims.length; d++) {
    const dim = L.dims[d]
    if (d > 0) {
      const r = clickTab([dim.zh, dim.en])
      if (!r.ok) { console.error(`警告：找不到维度 tab「${dim.zh}」，跳过该维度（可用：${r.available}）`); continue }
    }
    const parsed = pollUntil(() => {
      try {
        const p = parseTable(pageText(30000).split("\n"))
        return p.rows.length > 0 ? p : false
      } catch { return false }
    }, { timeoutMs: 20000, intervalMs: 1500 })
    if (!parsed) {
      const p = parseTable(pageText(30000).split("\n"))
      dims[dim.key] = p.rows
      console.log(`  ${dim.zh}: ${p.rows.length} 行${p.headerFound ? "" : "（⚠️ 未找到表头，可能解析失配）"}`)
      continue
    }
    dims[dim.key] = parsed.rows
    console.log(`  ${dim.zh}: ${parsed.rows.length} 行`)
  }

  console.log(`  汇总: 点击 ${summary.clicks?.raw} / 展现 ${summary.impressions?.raw} / CTR ${summary.ctr?.raw}`)
  console.log(`  序列: ${series?.dates?.length ?? 0} 天，对齐 ${series?.aligned ? "✅" : "⚠️ 长度不一致"}`)

  // ── 落盘 JSON + MD ──
  const dir = resolve(out)
  mkdirSync(dir, { recursive: true })
  const json = {
    source: url,
    site,
    range,
    rangeLabel: rangeSpec.zh,
    fetchedAt: new Date().toISOString(),
    summary: {
      clicks: summary.clicks?.value ?? null,
      impressions: summary.impressions?.value ?? null,
      ctr: summary.ctr?.value ?? null,
    },
    series,
    dimensions: dims,
  }
  writeFileSync(`${dir}/searchperf.json`, JSON.stringify(json, null, 2))

  const md = []
  md.push(`# Bing 搜索性能导出（${rangeSpec.zh}）`)
  md.push("")
  md.push(`- 数据来源：${url}`)
  md.push(`- 抓取时间：${json.fetchedAt}`)
  md.push(`- 汇总：点击 ${summary.clicks?.raw ?? "?"} · 展现 ${summary.impressions?.raw ?? "?"} · CTR ${summary.ctr?.raw ?? "?"}`)
  md.push(`- 序列：${series?.dates?.length ?? 0} 天${series?.aligned ? "" : "（⚠️ 点击/展现序列长度与日期不一致，见 JSON）"}`)
  md.push("")
  if (series?.points) {
    md.push(`## 逐日序列`)
    md.push("")
    md.push(`| 日期 | 点击 | 展现 |`)
    md.push(`|---|---|---|`)
    for (const p of series.points) md.push(`| ${p.date} | ${p.clicks} | ${p.impressions} |`)
    md.push("")
  }
  for (const dim of L.dims) {
    const rows = dims[dim.key]
    if (!rows) continue
    md.push(`## ${dim.zh}（Top ${rows.length}）`)
    md.push("")
    md.push(`| ${dim.zh} | 展现 | 点击 | CTR | 平均排名 |`)
    md.push(`|---|---|---|---|---|`)
    for (const r of rows) md.push(`| ${r.name} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(2)}% | ${r.position} |`)
    md.push("")
  }
  md.push(`> 表格只含每页默认 25 行（页面分页器之后的行未翻页）。维度行数合计见 Bing 后台分页器（如「1 — 25 502」）。`)
  writeFileSync(`${dir}/searchperf.md`, md.join("\n"))
  console.log(`已落盘: ${dir}/searchperf.json + searchperf.md`)
} finally {
  if (!keepSession) { try { cli("close") } catch { /* ignore */ } }
}
