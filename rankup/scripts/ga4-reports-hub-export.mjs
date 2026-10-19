#!/usr/bin/env node
/**
 * ga4-reports-hub-export.mjs —— 从 Google Analytics 4「报告概况」导出过去 28 天
 * 的活跃用户/新用户/渠道会话/国家/Top 页面/事件计数全文落盘。
 * 驱动用户自己已登录的浏览器（opencli），不需要 API key / OAuth。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/ga4-reports-hub-export.mjs \
 *        --property a318660632p485492510 --out <目录> [--session 名]
 *
 * --property：GA4 的「账号+媒体资源」组合 ID（URL 里 /a<p>/p<...>，格式 a<accountId>p<propertyId>）。
 *   找法见下面坑 2。neopan = a318660632p485492510（账号「其他国内项目」/属性 Neopan）。
 *
 * 依赖：opencli + 用户浏览器已登录 analytics.google.com 且该账号有此资源权限。
 *
 * ── 实测的坑（2026-10-17 首跑验证）────────────────────────────
 *
 * 1. **登录后落在「上次用的媒体资源」**，不一定是目标。切资源别点下拉菜单
 *    （账号行点开是平铺列表、不是树，实测点不展开）。
 *
 * 2. **找 property ID 的快路**：进「查看所有数据分析」（insights/hub）→ 页面
 *    底部搜索框（placeholder「搜索」）→ 输入资源名 → 结果列出「账号 | 资源 | 数字ID」。
 *    拿到 ID 后直接拼 URL：/#/a<account>p<property>/reports/reportinghub。
 *
 * 3. **reportinghub 默认就是过去 28 天**（标题显示日期范围），不用动日期选择器。
 *    首页（intelligenthome）的卡片才是各用各的 7 天/本月范围——别在首页取数。
 *
 * 4. **eval 必须包 IIFE**：裸 `return x` 报 SyntaxError: Illegal return statement。
 *
 * 5. 页面懒加载：轮询等「活跃用户」卡片数字出现再读。
 *
 * 已验证：2026-10-17（a318660632p485492510 / Neopan，过去28天 9/19-10/16 全卡出数）
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { pollUntil } from "./lib-scene.mjs"
import { opencliRun } from "./lib-opencli.mjs"

const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help")) { usage(); process.exit(0) }
let property = null, out = null, session = `ga4-hub-${Math.random().toString(36).slice(2, 8)}`
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--property" && argv[i + 1]) property = argv[++i]
  else if (a === "--out" && argv[i + 1]) out = argv[++i]
  else if (a === "--session" && argv[i + 1]) session = argv[++i]
  else { console.error(`未知参数: ${a}`); usage(); process.exit(1) }
}
function usage() {
  console.log(`用法:
  node ga4-reports-hub-export.mjs --property a<accountId>p<propertyId> --out <目录> [--session 名]`)
}
if (!property || !out) { console.error("错误：需要 --property 和 --out"); usage(); process.exit(1) }
if (!/^a\d+p\d+$/.test(property)) { console.error(`错误：--property 格式应为 a<accountId>p<propertyId>，收到 ${property}`); process.exit(1) }

function cli(sub, payload = null, { timeout = 90000 } = {}) {
  const args = ["browser", session, "--window", "background", sub]
  if (payload !== null) args.push(payload)
  try {
    return opencliRun(args, { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || "").trim()
    throw new Error(`opencli 失败: ${sub}${payload ? " " + payload : ""}\n  输出: ${err || "(空)"}`)
  }
}
function pageText() {
  return cli("eval", `(()=>{return (document.querySelector('main')||document.body).innerText.replace(/\\n{2,}/g,'\\n')})()`)
}

const url = `https://analytics.google.com/analytics/web/#/${property}/reports/reportinghub`
console.log(`GA4 报告概况导出（默认过去 28 天）`)
console.log(`  资源: ${property}`)
console.log(`  会话: ${session}`)

try {
  cli("open", url)
  const ok = pollUntil(() => {
    try { return /活跃用户\n[\d.,]+/.test(pageText()) } catch { return false }
  }, { timeoutMs: 60000, intervalMs: 2000 })
  if (!ok) {
    const sample = (() => { try { return pageText().slice(0, 600) } catch { return "（取不到）" } })()
    throw new Error(`60 秒内没等到「活跃用户」卡片。未登录 / 无权限 / 资源 ID 错都长这样——页面文本前 600 字：\n${sample}\nproperty ID 的找法：insights/hub 页底部搜索框搜资源名，结果里「账号 | 资源 | 数字ID」。`)
  }
  const text = pageText()
  const dir = resolve(out)
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/reporting-hub-28d.txt`
  writeFileSync(file, `# GA4 ${property} 报告概况（默认过去28天） · 抓取 ${new Date().toISOString()}\n# ${url}\n\n${text}`)
  console.log(`已落盘: ${file}（${text.length} 字符）`)
} finally {
  try { cli("close") } catch { /* ignore */ }
}
