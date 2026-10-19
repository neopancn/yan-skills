#!/usr/bin/env node
/**
 * clarity-dashboard-export.mjs —— 从 Microsoft Clarity 仪表板导出项目概览
 * （会话数、用户、死点/快退/愤怒点击、智能事件、引用渠道、Top 页面）全文落盘。
 * 驱动用户自己已登录的浏览器（opencli），不需要 API key。
 *
 * 用法：
 *   node <rankup-skill-dir>/scripts/clarity-dashboard-export.mjs \
 *        --project <projectId> --out <目录> [--date "Last 30 days"] [--session 名]
 *
 * --project：Clarity 项目 ID（URL /projects/view/<id> 里的那段，如 t8gf6kwzff）。
 * --date：仪表板日期参数，原样拼进 URL，默认 "Last 30 days"（有空格要引号）。
 *
 * 依赖：opencli + 用户浏览器已登录 clarity.microsoft.com（与 GSC/Bing 同 profile 实测可用）。
 *
 * ── 实测的坑（2026-10-17 首跑验证）────────────────────────────
 *
 * 1. **直接进项目 URL，不要从项目列表页找**：/projects 是「上次用的项目」的
 *    仪表板（实测落在 yxjgh5hutw 而不是目标项目），必须导航
 *    /projects/view/<id>/dashboard?date=...。
 *
 * 2. **默认日期范围是「过去 3 天」**，只看 3 天会以为站子没流量。date 参数
 *    用 %20 编码空格：?date=Last%2030%20days。
 *
 * 3. **页面懒加载**：仪表板分区异步渲染，轮询等「会话」汇总数字出现再读，
 *    固定 sleep 在冷启动时会读到半截。
 *
 * 4. Top 页面/引用者列表默认只渲染前 10 条（滚动加载更多），本文只取首屏，
 *    要全量去后台手动导出。
 *
 * 已验证：2026-10-17（t8gf6kwzff / neopan，Last 30 days，全文 1997 字符出数）
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { pollUntil } from "./lib-scene.mjs"
import { opencliRun } from "./lib-opencli.mjs"

const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help")) { usage(); process.exit(0) }
let project = null, out = null, date = "Last 30 days", session = `clarity-dash-${Math.random().toString(36).slice(2, 8)}`
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--project" && argv[i + 1]) project = argv[++i]
  else if (a === "--out" && argv[i + 1]) out = argv[++i]
  else if (a === "--date" && argv[i + 1]) date = argv[++i]
  else if (a === "--session" && argv[i + 1]) session = argv[++i]
  else { console.error(`未知参数: ${a}`); usage(); process.exit(1) }
}
function usage() {
  console.log(`用法:
  node clarity-dashboard-export.mjs --project <id> --out <目录> [--date "Last 30 days"] [--session 名]`)
}
if (!project || !out) { console.error("错误：需要 --project 和 --out"); usage(); process.exit(1) }

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

const url = `https://clarity.microsoft.com/projects/view/${project}/dashboard?date=${encodeURIComponent(date)}`
console.log(`Clarity 仪表板导出`)
console.log(`  项目: ${project}  范围: ${date}`)
console.log(`  会话: ${session}`)

try {
  cli("open", url)
  // 等「会话」汇总数字渲染出来（懒加载；锚点=仪表板第一张卡）
  const ok = pollUntil(() => {
    try { return /会话\n[\d.,]+/.test(pageText()) } catch { return false }
  }, { timeoutMs: 45000, intervalMs: 2000 })
  if (!ok) {
    const sample = (() => { try { return pageText().slice(0, 600) } catch { return "（取不到）" } })()
    throw new Error(`45 秒内没等到会话汇总数字。项目 ID 不对 / 未登录 / 项目无数据都长这样——页面文本前 600 字：\n${sample}`)
  }
  const text = pageText()
  const dir = resolve(out)
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/dashboard-${date.toLowerCase().replace(/\s+/g, "-")}.txt`
  writeFileSync(file, `# Clarity ${project} dashboard · ${date} · 抓取 ${new Date().toISOString()}\n# ${url}\n\n${text}`)
  console.log(`已落盘: ${file}（${text.length} 字符）`)
} finally {
  try { cli("close") } catch { /* ignore */ }
}
