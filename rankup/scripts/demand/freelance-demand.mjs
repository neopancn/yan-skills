#!/usr/bin/env node
/**
 * freelance-demand.mjs —— 从「已经有人在为这件事付钱」里挖需求。
 *
 * 核心假设：搜索量只证明「有人在找」，外包订单证明「有人在付」。
 * 一个关键词下如果有大量重复的、单价不高的外包需求，
 * 说明这件事标准化程度够高、痛点够普遍 —— 那正是可以做成 SaaS 去承接的活。
 *
 * 支持的源：
 *   freelancer  Freelancer.com 公开 REST API（零配置、可进 CI，最好用）
 *               拿到：标题 / 预算区间 / 币种 / 竞标数 / 平均报价 / 技能标签
 *   fiverr      Fiverr 服务列表（Cloudflare 挡 curl，必须走 opencli）
 *               拿到：服务标题 / 起步价 / 评分 / 评价数（评价数≈成交量）
 *   upwork      Upwork 职位列表（Cloudflare 挡 curl，必须走 opencli）
 *               拿到：职位标题 / 计价方式 / 预算 / 描述片段
 *   xianyu      闲鱼搜索（必须走 opencli；不需要登录）
 *               拿到：商品标题 / 价格 / 「N 人想要」——想要数/商品数就是供需比
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/demand/freelance-demand.mjs --source freelancer --query "<关键词>" --limit 20
 *   node <rankup-skill-dir>/scripts/demand/freelance-demand.mjs --source fiverr --query "<关键词>" --json
 *   node <rankup-skill-dir>/scripts/demand/freelance-demand.mjs --source upwork --query "<关键词>"
 *   node <rankup-skill-dir>/scripts/demand/freelance-demand.mjs --source xianyu --query "<关键词>" --out demand.jsonl
 *
 * 标志：
 *   --source <名>     freelancer|fiverr|upwork|xianyu（必须）
 *   --query <词>      搜索关键词（必须）
 *   --limit <n>       最多输出多少条，默认 30
 *   --pages <n>       翻几页，默认 1（freelancer 用 offset，其余用站点分页参数）
 *   --session <名>    opencli 会话名（默认 demand-freelance-<source>）
 *   --keep-session    跑完不关闭 opencli 会话
 *   --json            输出 JSON 数组
 *   --out <file>      落盘（.jsonl 写 JSON Lines，其它写 JSON）
 *   --evidence-dir <d> 失败现场与 manifest 落点，默认 .rankup/evidence/demand/freelance-demand-<ts>/
 *
 * 失败留现场（2026-08-30）：每页采集状态记进 manifest.json，失败页原始响应落进
 * 证据目录。空结果时逐源报状态——「0 条 + 页失败」不是「没人为这事付钱」。
 *
 * 依赖：
 *   - freelancer：无，纯 HTTP，无需 token
 *   - fiverr / upwork / xianyu：需要本机 opencli + 真实 Chrome（都不需要登录）
 *
 * 统一输出字段：{source, query, title, url, price, currency, orders, rating}
 *   price   起步价 / 预算下限（数字）
 *   orders  成交量代理指标：freelancer=竞标数，fiverr=评价数，xianyu=想要人数，upwork=null
 *
 * 已验证日期：2026-08-24
 *
 * 已知坑：
 *   - Freelancer API 单次 limit 上限约 100；返回的 budget 是「发布者填的预算区间」，
 *     币种五花八门（INR/USD/EUR 混在一起），跨项目比价前必须先换算。
 *     bid_stats.bid_avg 才是市场真实报价，比 budget 更可信。
 *   - Fiverr / Upwork / 闲鱼纯 curl 一律 403 或空页；Fiverr 的 __INITIAL_DATA__ 在
 *     新版页面里是空对象，只能读 DOM 卡片，class 名会变，用的是 [data-gig-id] 属性选择器。
 *   - Fiverr 卡片里的「(946)」是评价数不是订单数，只能当成交量的下限代理。
 *   - 闲鱼（goofish.com）**未登录时搜索恒返回「小闲鱼没有找到你想要的宝贝~」**，
 *     页面会静默降级成「猜你喜欢」的随机商品。2026-08-23 实测 iPhone、手持云台
 *     这类必然有货的词都是如此，所以「闲鱼搜索」这条路实际需要登录态。
 *     脚本检测到这个降级会在 stderr 打 [note] 并照常输出（方便你确认是不是登录问题），
 *     但那批数据跟你的关键词无关，**不要拿去做判断**。
 *     人工替代动作：先在用户自己的 Chrome 里登录闲鱼，再跑本脚本；
 *     DOM 结构（a[href*="item?id="]、¥价格、「N人想要」）已实测可解析，登录后即可用。
 *   - 闲鱼搜索结果是异步渲染，open 之后至少要等 10-15 秒。
 */
import { execFileSync } from "node:child_process"
import { opencliRun } from "../lib-opencli.mjs"
import { writeFileSync } from "node:fs"
import { requireBrowserBridge, initEvidence, recordSource, writeManifest, saveEvidence, sourceStatusSummary, captureBrowserScene } from "./_lib.mjs"

const SOURCES = ["freelancer", "fiverr", "upwork", "xianyu"]
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
  usage()
  process.exit(argv.length === 0 ? 1 : 0)
}
const opt = { source: null, query: null, limit: 30, pages: 1, session: null, keepSession: false, json: false, out: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--source" && argv[i + 1]) { opt.source = argv[++i]; continue }
  if (a === "--query" && argv[i + 1]) { opt.query = argv[++i]; continue }
  if (a === "--limit" && argv[i + 1]) { opt.limit = Number(argv[++i]); continue }
  if (a === "--pages" && argv[i + 1]) { opt.pages = Number(argv[++i]); continue }
  if (a === "--session" && argv[i + 1]) { opt.session = argv[++i]; continue }
  if (a === "--keep-session") { opt.keepSession = true; continue }
  if (a === "--json") { opt.json = true; continue }
  if (a === "--out" && argv[i + 1]) { opt.out = argv[++i]; continue }
  if (a === "--evidence-dir" && argv[i + 1]) { opt.evidenceDir = argv[++i]; continue }
  fail(`未知参数：${a}`)
}
if (!opt.source) fail("缺少 --source")
if (!SOURCES.includes(opt.source)) fail(`--source 只能是 ${SOURCES.join("|")}`)
if (!opt.query) fail("缺少 --query")
if (!opt.session) opt.session = `demand-freelance-${opt.source}`
initEvidence("freelance-demand", { dir: opt.evidenceDir || null })

const rows = (opt.source === "freelancer" ? await freelancer() : browserSource()).slice(0, opt.limit)

if (opt.out) {
  const body = opt.out.endsWith(".jsonl")
    ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    : JSON.stringify(rows, null, 2)
  writeFileSync(opt.out, body)
  process.stderr.write(`已写入 ${opt.out}（${rows.length} 条）\n`)
}
const manifestPath = writeManifest("completed")
if (opt.json) console.log(JSON.stringify(rows, null, 2))
else printTable(rows)
if (!rows.length) {
  // 「0 条 + 源失败」和「0 条 + 源成功」必须长得不一样：逐源报状态。
  const s = sourceStatusSummary()
  if (s?.failed) {
    process.stderr.write(`没有取到条目——但 ${s.failed}/${s.total} 次采集失败，这不是「该关键词没有付费需求」的证据：\n`)
    for (const l of s.lines) process.stderr.write(`${l}\n`)
  } else {
    process.stderr.write("没有取到条目（采集本身成功）：换个 --query 再试\n")
  }
}
if (manifestPath) process.stderr.write(`manifest：${manifestPath}\n`)

// ── Freelancer.com 公开 API ──────────────────────────────
async function freelancer() {
  const out = []
  const per = Math.min(100, Math.max(10, opt.limit))
  for (let p = 0; p < opt.pages; p++) {
    const u =
      "https://www.freelancer.com/api/projects/0.1/projects/active/" +
      `?query=${encodeURIComponent(opt.query)}&limit=${per}&offset=${p * per}&job_details=true`
    let j
    try { j = await httpGetJSON(u) }
    catch (e) {
      // 以前是 warn+break：403/429/断网 和「该词没有外包订单」输出同形。
      // 现在把该页状态记进 manifest 再停，空结果就能读出「取数失败」。
      const f = saveEvidence(`freelancer-page${p}-${e.status ?? "neterr"}.json`, { url: u, status: e.status ?? null, error: String(e.message), body: e.body ?? null })
      recordSource({ source: `freelancer:page${p}`, status: e.status ? `http_${e.status}` : "network_error", rawCount: 0, error: `${e.message}（现场已留 ${f}）` })
      process.stderr.write(`[warn] freelancer 第 ${p + 1} 页取数失败，停止翻页：${e.message}\n`)
      break
    }
    const list = j?.result?.projects ?? []
    recordSource({ source: `freelancer:page${p}`, status: "ok", rawCount: list.length })
    if (!list.length) break
    for (const pr of list) {
      out.push({
        source: "freelancer",
        query: opt.query,
        title: pr.title ?? null,
        url: pr.seo_url ? `https://www.freelancer.com/projects/${pr.seo_url}` : null,
        price: pr.budget?.minimum ?? null,
        priceMax: pr.budget?.maximum ?? null,
        currency: pr.currency?.code ?? null,
        orders: pr.bid_stats?.bid_count ?? null,
        rating: null,
        bidAvg: pr.bid_stats?.bid_avg ?? null,
        type: pr.type ?? null,
        skills: (pr.jobs ?? []).map((x) => x.name),
        postedAt: pr.time_submitted ? new Date(pr.time_submitted * 1000).toISOString() : null,
      })
    }
  }
  return out
}

// ── 需要真实浏览器的三个源 ────────────────────────────────
function browserSource() {
  // fiverr / upwork / xianyu 都走这里；桥没连上时原来会在下面的 ocli() 上
  // 无声挂到 execFileSync 的 timeout（180s）才报错，还容易被当成「没有数据」。
  requireBrowserBridge()
  const s = opt.session
  const out = []
  try {
    for (let p = 1; p <= opt.pages; p++) {
      const u = pageUrl(p)
      try { ocli(["browser", s, "--window", "dedicated", "open", u]) }
      catch { process.stderr.write(`[warn] open 未确认完成，继续轮询：${u}\n`) }
      const raw = ocliEval(s, extractor(), 6)
      if (!raw || raw.error) {
        const f = saveEvidence(`${opt.source}-page${p}.json`, { url: u, error: raw?.error ?? "eval 无返回", raw })
        // 双证人：第一波记了状态（DOM 侧），本波补视觉证人——截图+页面全文在关 tab
        // 之前落盘（截图链路已实盘验证）。是 CF 挑战页/登录墙还是真没有供给，AI 看图判。
        const scene = captureBrowserScene(s, `${opt.source}-page${p}`)
        recordSource({ source: `${opt.source}:page${p}`, status: "extract_failed", rawCount: 0, error: `${raw?.error ?? "eval 无返回"}（现场已留 ${f}）`, scene })
        process.stderr.write(`[warn] ${u}: ${raw?.error ?? "无返回"}（截图 ${scene.shot ?? "未取到"}）\n`)
        continue
      }
      if (raw.note) process.stderr.write(`[note] ${raw.note}\n`)
      recordSource({ source: `${opt.source}:page${p}`, status: "ok", rawCount: (raw.items ?? []).length, note: raw.note ?? undefined })
      for (const r of raw.items ?? []) out.push({ source: opt.source, query: opt.query, ...r })
    }
  } finally {
    if (!opt.keepSession) try { ocli(["browser", s, "close"]) } catch {}
  }
  return out
}

function pageUrl(p) {
  const q = encodeURIComponent(opt.query)
  if (opt.source === "fiverr") return `https://www.fiverr.com/search/gigs?query=${q}&page=${p}`
  if (opt.source === "upwork") return `https://www.upwork.com/nx/search/jobs/?q=${q}&page=${p}`
  return `https://www.goofish.com/search?q=${q}&page=${p}`
}

function extractor() {
  if (opt.source === "fiverr") {
    return `(()=>{const cards=[...document.querySelectorAll('[data-gig-id]')];
      if(!cards.length) return {error:"页面上没有 [data-gig-id] 卡片（多半没过 Cloudflare 挑战）"};
      const items=cards.map(c=>{const t=c.innerText.replace(/\\s+/g," ").trim();
        const a=c.querySelector('a[href*="fiverr.com/"]')||c.querySelector("a");
        const price=t.match(/From\\s+([A-Z$€£]{1,3}\\$?)\\s?([\\d,.]+)/);
        const rate=t.match(/(\\d\\.\\d)\\s*\\((\\d[\\d,]*)\\)/);
        const title=(t.match(/I will [^\\d]{5,140}/)||[])[0];
        return {title:(title||t).trim().slice(0,160),
          url:a?a.href.split("?")[0]:null,
          price:price?Number(price[2].replace(/,/g,"")):null,
          currency:price?({"US$":"USD","$":"USD","€":"EUR","£":"GBP"}[price[1]]||price[1]):null,
          orders:rate?Number(rate[2].replace(/,/g,"")):null,
          rating:rate?Number(rate[1]):null};});
      return {items};})()`
  }
  if (opt.source === "upwork") {
    return `(()=>{const cards=[...document.querySelectorAll('[data-test="JobTile"], article[data-ev-label]')];
      if(!cards.length) return {error:"页面上没有职位卡片（多半没过 Cloudflare 挑战）"};
      const items=cards.map(c=>{const t=c.innerText.replace(/\\s+/g," ").trim();
        const a=c.querySelector('a[href*="/jobs/"]');
        const b=t.match(/Est\\. budget:\\s*\\$([\\d,.]+)/)||t.match(/\\$([\\d,.]+)\\s*-\\s*\\$[\\d,.]+/);
        const title=a?a.innerText.replace(/\\s+/g," ").trim():t.slice(0,120);
        return {title:title.slice(0,160),
          url:a?a.href.split("?")[0]:null,
          price:b?Number(b[1].replace(/,/g,"")):null,
          currency:b?"USD":null,orders:null,rating:null,
          payType:/Hourly/.test(t)?"hourly":(/Fixed price/.test(t)?"fixed":null),
          snippet:t.slice(0,300)};});
      return {items};})()`
  }
  return `(()=>{const body=document.body.innerText;
    if(/加载中/.test(body)) return {error:"结果还在加载（再等几秒重试）"};
    const a=[...document.querySelectorAll('a')].filter(x=>/item\\?id=/.test(x.href));
    if(!a.length) return {error:"页面上没有商品卡片"};
    const items=a.map(x=>{const t=x.innerText.replace(/\\s+/g," ").trim();
      const price=t.match(/¥\\s*([\\d,]+)\\s*(?:\\.\\s*(\\d+))?/);
      const want=t.match(/(\\d+)人想要/);
      return {title:t.split(/¥/)[0].trim().slice(0,120),
        url:x.href.split("&")[0],
        price:price?Number(price[1].replace(/,/g,"")+(price[2]?"."+price[2]:"")):null,
        currency:price?"CNY":null,
        orders:want?Number(want[1]):null,rating:null};});
    return {items, note:/没有找到/.test(body)?"闲鱼说没搜到，下面是「猜你喜欢」的兜底结果，不代表该关键词的真实供给":null};})()`
}

// ── 工具 ──────────────────────────────────────────────────
/**
 * 先用内置 fetch；若因为证书链问题失败（某些站点的中间证书 Node 自带 CA 库认不出，
 * 而系统 curl 认得出），自动降级到 curl。两者都失败才抛错。
 */
async function httpGetJSON(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA } })
    const text = await res.text()
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; err.body = text; throw err }
    try { return JSON.parse(text) } catch { const err = new Error(`响应不是 JSON（HTTP ${res.status}）`); err.status = res.status; err.body = text; throw err }
  } catch (e) {
    const code = e?.cause?.code ?? ""
    if (!/CERT|SSL|TLS/i.test(String(code))) throw e
    process.stderr.write(`[info] fetch 因证书链失败（${code}），降级用 curl\n`)
    const out = execFileSync("curl", ["-sS", "-m", "40", "-A", UA, url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(out)
  }
}

function ocli(args) {
  return opencliRun(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 })
}

function ocliEval(session, js, tries) {
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      const raw = ocli(["browser", session, "eval", js])
      const start = raw.indexOf("{")
      if (start >= 0) {
        const parsed = JSON.parse(raw.slice(start))
        if (!parsed.error) return parsed
        last = parsed
      }
    } catch (e) { last = { error: String(e.message || e).slice(0, 200) } }
    sleepSync(6000)
  }
  return last
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function printTable(rows) {
  if (!rows.length) return
  const w = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n).padEnd(n)
  console.log(`${w("标题", 58)}${w("价格", 14)}${w("成交代理", 9)}${w("评分", 5)}`)
  console.log("-".repeat(90))
  for (const r of rows) {
    const price = r.price == null ? "-" : `${r.price}${r.priceMax ? "-" + r.priceMax : ""} ${r.currency ?? ""}`
    console.log(`${w(r.title, 58)}${w(price, 14)}${w(r.orders, 9)}${w(r.rating, 5)}`)
  }
  const withOrders = rows.filter((r) => typeof r.orders === "number")
  const sum = withOrders.reduce((a, r) => a + r.orders, 0)
  console.log(`\n共 ${rows.length} 条 · source=${rows[0].source} query=${rows[0].query}` +
    (withOrders.length ? ` · 成交代理合计 ${sum}（均值 ${(sum / withOrders.length).toFixed(1)}）` : ""))
}

function fail(msg) {
  // 采集已经开始过的失败要先落 manifest（initEvidence 之前的参数错误不会建目录）。
  try {
    const f = writeManifest(`died: ${String(msg).replace(/\s+/g, " ").slice(0, 300)}`)
    if (f) process.stderr.write(`现场已留：${f}\n`)
  } catch {}
  process.stderr.write(`错误：${msg}\n\n`); usage(); process.exit(1)
}

function usage() {
  process.stdout.write(`freelance-demand.mjs —— 从「已经有人付钱」的外包/二手市场里挖需求

  --source freelancer|fiverr|upwork|xianyu   （必须）
  --query <关键词>                            （必须）
  --limit <n>      默认 30
  --pages <n>      默认 1
  --session <名>   opencli 会话名
  --keep-session   跑完不关会话
  --json           输出 JSON
  --out <file>     落盘（.jsonl 为 JSON Lines）
  --evidence-dir <d> 失败现场与 manifest 落点

统一字段：{source, query, title, url, price, currency, orders, rating}
  orders = 成交量代理（freelancer 竞标数 / fiverr 评价数 / 闲鱼想要人数）
`)
}
