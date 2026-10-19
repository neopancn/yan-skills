#!/usr/bin/env node
/**
 * naver-setup.mjs —— 在 Naver Search Advisor 里注册站点、获取验证信息、提交 sitemap，
 * 驱动用户已登录的浏览器，不需要 API key。
 *
 * 用法：
 *   # 查看当前已注册的站点列表和验证状态
 *   node <rankup-skill-dir>/scripts/naver-setup.mjs status --site example.com
 *
 *   # 注册新站点并获取验证 meta 标签
 *   node <rankup-skill-dir>/scripts/naver-setup.mjs register --site example.com
 *
 *   # 为已验证的站点提交 sitemap
 *   node <rankup-skill-dir>/scripts/naver-setup.mjs submit-sitemap --site example.com
 *
 * 标志：
 *   --site <域名>          要追踪的域名（不带协议，例如 example.com）（必须）
 *   --sitemap-url <URL>    完整 sitemap 地址（默认 https://<site>/sitemap.xml）
 *   --session <名>         opencli 会话名（默认 naver-<site 简写>）
 *   --keep-session         完成后不关闭会话
 *   RANKUP_EVIDENCE_ROOT   可指定取证根目录
 *   verify                点击所有权验证；出现 CAPTCHA 返回 2，不代填。
 *   2026-10-07: 修复 Vuetify 无 placeholder 输入框、图标按钮与新版 fill 参数。
 *
 * 依赖：opencli，且用户浏览器已登录 searchadvisor.naver.com。
 *
 * ── 为什么是浏览器而不是 API ────────────────────────────────
 *
 * Naver Search Advisor 内部 API 存在但 CSRF 保护严格：
 * OAuth 重定向后 document.cookie 被 SecurityError 阻断，
 * 导致所有 POST 操作（注册、验证、提交 sitemap）走纯 HTTP 不可靠。
 * 注册和 sitemap 提交走 UI 更稳定。
 *
 * ── 关于所有权验证 ────────────────────────────────────────
 *
 * 所有权验证需要 CAPTCHA（人机验证），无法完全自动化。
 * `register` 子命令会取得验证 meta 标签的 content 值，
 * 用户部署标签后需要在浏览器中手动完成 CAPTCHA 验证。
 *
 * ── URL 格式（实测 2026-08-23）────────────────────────────
 *
 * - 站点列表：https://searchadvisor.naver.com/console/board
 * - 站点摘要：https://searchadvisor.naver.com/console/site/summary?site=<编码URL>
 * - Sitemap 提交：https://searchadvisor.naver.com/console/site/request/sitemap?site=<编码URL>
 *   注意：参数是 ?site= 不是 ?url=
 * - 设置：https://searchadvisor.naver.com/console/site/option?site=<编码URL>
 *
 * 已验证：2026-08-23（Nuxt.js/Vue SPA）
 *
 * ── 双证人化（2026-08-30，截图链路已实盘验证）────────────────
 * 每步（打开/点击后）截图落 `.rankup/evidence/naver-setup-<ts>/`；
 * `execSync("sleep")` 全部革除，换页内条件等待；**删除了
 * `resultText === ""` ⇒ 成功 那条断言**——eval 超时读不到页面 ≠ 提交成功，
 * submit-sitemap 现在只报事实 + suggested，判读以截图为准。
 */
import { execSync } from "node:child_process"
import { newEvidenceDir, captureScene, writeManifest } from "./lib-scene.mjs"

// ── 参数 ──────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") { usage(); process.exit(argv.length === 0 ? 1 : 0) }
const action = argv[0]
let site = null
let sitemapUrl = null
let session = null
let keepSession = false

for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--site" && argv[i + 1]) { site = argv[++i]; continue }
  if (a === "--sitemap-url" && argv[i + 1]) { sitemapUrl = argv[++i]; continue }
  if (a === "--session" && argv[i + 1]) { session = argv[++i]; continue }
  if (a === "--keep-session") { keepSession = true; continue }
  if (a === "-h" || a === "--help") { usage(); process.exit(0) }
  console.error(`未知参数: ${a}`); usage(); process.exit(1)
}

function usage() {
  console.log(`用法:
  node naver-setup.mjs status --site <域名>
  node naver-setup.mjs register --site <域名>
  node naver-setup.mjs verify --site <域名>
  node naver-setup.mjs submit-sitemap --site <域名> [--sitemap-url <URL>]`)
}

if (!["status", "register", "verify", "submit-sitemap"].includes(action)) { usage(); process.exit(1) }
if (!site) { console.error(`错误：${action} 需要 --site`); process.exit(1) }

// 会话名要描述工作，但**不能只靠站点名区分**：两个任务同时处理同一个站会撞进
// 同一个标签页，各自读回对方的页面，导航还照样报成功。所以再挂一个并发单位后缀
// （一次对话 = 一个 CLAUDE_CODE_SESSION_ID；HOST 级的是整个桌面端共用的，只能垫底）。
// node 脚本里 pid 全程不变可以兜底，但 Bash tool 里的 $$ 每次调用都变，绝不能用。
if (!session) {
  const slug = site.replace(/[^a-z0-9]/gi, "-").slice(0, 20)
  const suffix = (
    process.env.OPENCLI_SESSION_SUFFIX ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_CODE_HOST_SESSION_ID ||
    String(process.ppid)
  ).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local"
  session = `naver-${slug}-${suffix}`
}
// sitemap 默认值
if (!sitemapUrl) sitemapUrl = `https://${site}/sitemap.xml`

const siteUrl = `https://${site}`
const encodedSiteUrl = encodeURIComponent(siteUrl)

// ── OpenCLI 封装 ──────────────────────────────────────────
function cli(action_, { timeout = 30000 } = {}) {
  try {
    return execSync(`opencli browser "${session}" --window dedicated ${action_}`,
      { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim()
    throw new Error(`opencli 失败: ${action_}\n  ${err}`)
  }
}
// 2026-10-03：片段里含 await 时必须包 async IIFE，否则 SyntaxError（status 的 /api-board/list 读取一直报这个）。
function evalJs(js) { const head = /\bawait\b/.test(js) ? "(async()=>{" : "(()=>{"; return cli(`eval '${`${head}${js}})()`.replace(/'/g, "'\\''")}'`) }
function open(url) { cli(`open "${url}"`) }
function pageText(max = 4000) {
  return evalJs(`return (document.querySelector('main')||document.body).innerText.replace(/\\n{2,}/g,'\\n').slice(0,${max})`)
}
/** 页内定时器，替换 execSync("sleep")。 */
function settle(ms) {
  cli(`eval '(async()=>{await new Promise(r=>setTimeout(r,${ms}));return true})()'`, { timeout: ms + 30000 })
}
/** 条件轮询：js 返回真值或超时；导航期间 eval 失败按未就绪继续等。 */
function waitFor(js, seconds = 15) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try { if (String(evalJs(js)).includes("true")) return true } catch { /* 导航中 */ }
    settle(500)
  }
  return false
}
function waitPageReady(seconds = 20) {
  return waitFor(`return document.readyState==='complete' && ((document.body&&document.body.innerText)||'').length>50`, seconds)
}

/* ── 取证 ─────────────────────────────────────────────────── */
let evidence = null
function evidenceDir() {
  if (!evidence) evidence = newEvidenceDir("naver-setup", process.env.RANKUP_EVIDENCE_ROOT ? { root: process.env.RANKUP_EVIDENCE_ROOT } : {})
  return evidence
}
let sceneN = 0
function scene(tag, extra) {
  sceneN++
  return captureScene({
    dir: evidenceDir(),
    tag: `${String(sceneN).padStart(2, "0")}-${tag}`,
    screenshot: (p) => cli(`screenshot "${p}"`, { timeout: 90000 }),
    pageText: () => { try { return pageText(20000) } catch (e) { return `PAGE_TEXT_FAILED:${e.message}` } },
    extra,
  })
}
function bail(stopReason, msg, extra) {
  try {
    scene(`fail-${stopReason}`, extra)
    writeManifest(evidenceDir(), { script: "naver-setup", action, site, stopReason, finishedAt: new Date().toISOString() })
    console.error(`现场已落盘：${evidenceDir()}`)
  } catch (e) { console.error(`（取证失败：${String(e?.message || e).slice(0, 200)}）`) }
  console.error(msg)
  if (!keepSession) { try { cli("close") } catch { /* ignore */ } }
  process.exit(1)
}

function stampAndClick(js, label) {
  evalJs(`const el=${js};if(!el)throw new Error('找不到: ${label}');el.setAttribute('data-rankup-target','1')`)
  cli('click "[data-rankup-target=\\"1\\"]"')
  evalJs(`document.querySelector('[data-rankup-target]')?.removeAttribute('data-rankup-target')`)
  scene(`clicked-${label.replace(/[^\w가-힣一-鿿-]/g, "_")}`)
}

// ── status：检查站点注册状态 ─────────────────────────────
async function doStatus() {
  open("https://searchadvisor.naver.com/console/board")
  waitPageReady(20)

  const text = pageText(8000)
  if (text.includes("로그인") || text.includes("Log in") || text.includes("Sign in") || /ID或手机号|密码/.test(text)) {
    bail("login-text-seen", "页面文本命中 로그인/Log in——多半未登录 Naver（也可能是撞词，看截图）。请先在浏览器中登录 searchadvisor.naver.com")
  }

  scene("site-list")
  console.log("── Naver Search Advisor 站点列表 ──")

  // 尝试用内部 API 获取列表（不受 CSRF 限制的 GET 请求）
  const listResult = evalJs(`
    try {
      const resp = await fetch('/api-board/list', { credentials: 'include' });
      if (!resp.ok) return 'api_fail';
      const data = await resp.json();
      if (!data || !Array.isArray(data.result)) return 'api_fail';
      return JSON.stringify(data.result.map(s => ({
        url: s.siteUrl || s.site || '',
        verified: s.verified || s.isVerified || false,
        name: s.siteName || ''
      })));
    } catch { return 'api_fail'; }
  `)

  if (listResult !== "api_fail") {
    try {
      const sites = JSON.parse(listResult)
      if (sites.length === 0) {
        console.log("（暂无已注册站点）")
      } else {
        for (const s of sites) {
          const status = s.verified ? "✅ 已验证" : "⏳ 未验证"
          const found = s.url.includes(site) ? " ← 目标站点" : ""
          console.log(`  ${status}  ${s.url}${found}`)
        }
      }

      // 检查目标站点
      const target = sites.find(s => s.url.includes(site))
      if (target) {
        console.log(`\n目标站点 ${site}: ${target.verified ? "已验证" : "未验证"}`)
      } else {
        console.log(`\n目标站点 ${site}: 未注册`)
      }
      return
    } catch { /* fallthrough to page text */ }
  }

  // API 失败时回退到页面文本
  const hasSite = text.includes(site)
  console.log(text.slice(0, 3000))
  if (hasSite) {
    console.log(`\n目标站点 ${site}: 已注册（验证状态请查看上方列表）`)
  } else {
    console.log(`\n目标站点 ${site}: 未注册`)
  }
}

// ── register：注册新站点 ─────────────────────────────────
async function doRegister() {
  open("https://searchadvisor.naver.com/console/board")
  waitPageReady(20)

  const text = pageText(8000)
  if (text.includes("로그인") || text.includes("Log in") || text.includes("Sign in") || /ID或手机号|密码/.test(text)) {
    bail("login-text-seen", "页面文本命中 로그인/Log in——多半未登录 Naver（也可能是撞词，看截图）。请先在浏览器中登录 searchadvisor.naver.com")
  }

  // 检查是否已注册
  if (text.includes(site)) {
    console.log(`⚠️ ${site} 可能已注册。如需重新验证，请在浏览器中操作。`)
    // 尝试导航到验证页获取 meta 标签
    await tryGetVerificationMeta()
    return
  }

  // 找到"사이트 추가"（添加站点）按钮并点击
  try {
    stampAndClick(
      `[...document.querySelectorAll('button,a')].find(b=>/사이트.*추가|사이트 추가|Add site|添加站点/i.test(b.textContent))`,
      "사이트 추가 按钮"
    )
  } catch {
    // 也可能是输入框直接在页面上
    const hasInput = evalJs(`return !!document.querySelector('input[type="url"],input[type="text"][placeholder*="http"],input[placeholder*="사이트"],input[placeholder*="site"],input[type="text"]')`)
    if (hasInput !== "true") {
      bail("add-site-entry-not-found", "找不到添加站点的入口（按钮和输入框都没匹配到）。需要登录还是结构变了，看截图。")
    }
  }
  settle(2000)

  // 填写站点 URL —— 先尝试 https://example.com
  const inputSelector = `document.querySelector('input[type="url"],input[type="text"][placeholder*="http"],input[placeholder*="사이트"],input[placeholder*="site"],input[type="text"],input[placeholder*="URL"],input[placeholder*="url"],input[type="text"]')`
  evalJs(`const el=${inputSelector};if(!el)throw new Error('找不到 URL 输入框');el.setAttribute('data-rankup-url','1');`)
  cli(`fill "[data-rankup-url]" "${siteUrl}"`)
  settle(1000)

  // 点击确认/提交按钮
  try {
    stampAndClick(
      `[...document.querySelectorAll('button')].find(b=>/확인|추가|등록|OK|Add|Submit|exit_to_app/i.test(b.textContent.trim()))`,
      "확인 按钮"
    )
  } catch {
    // 有时按钮是 input[type=submit] 或其他形式
    stampAndClick(
      `document.querySelector('button[type="submit"],input[type="submit"]')`,
      "提交按钮"
    )
  }
  settle(5000)

  // 检查是否出现「호스트 단위」错误（需要不带协议的域名）
  const afterText = pageText(4000)
  if (afterText.includes("호스트") || afterText.includes("이미 등록")) {
    console.log("⚠️ 可能需要以不同格式注册。尝试不带协议的域名...")
    // 清空重填
    evalJs(`const el=${inputSelector};if(el){el.focus();el.value='';}`)
    cli(`fill "[data-rankup-url]" "${site}"`)
    settle(1000)
    try {
      stampAndClick(
        `[...document.querySelectorAll('button')].find(b=>/확인|추가|등록|OK|Add|Submit|exit_to_app/i.test(b.textContent.trim()))`,
        "확인 按钮（重试）"
      )
    } catch { /* ignore */ }
    settle(5000)
  }

  // 尝试获取验证 meta 标签
  await tryGetVerificationMeta()
}

// ── tryGetVerificationMeta：获取验证用 meta 标签 ─────────
async function tryGetVerificationMeta() {
  // 2026-10-07: 新注册直接停在 ownership 页；先读当前页面，不能跳去 option 丢失验证信息。
  const current = pageText(12000)
  if (/naver-site-verification|HTML 파일|HTML 태그/.test(current)) {
    scene("ownership-options")
    console.log(current)
    return
  }
  // 尝试通过 API 获取验证密钥
  const verifyResult = evalJs(`
    try {
      // 先获取 enc_id
      const listResp = await fetch('/api-board/list', { credentials: 'include' });
      if (!listResp.ok) return 'api_fail';
      const listData = await listResp.json();
      if (!listData?.result) return 'api_fail';
      const entry = listData.result.find(s => (s.siteUrl||s.site||'').includes('${site}'));
      if (!entry) return 'not_found';
      const encId = entry.encId || entry.enc_id || entry.id;
      if (!encId) return 'no_enc_id';
      // 用 enc_id 获取验证密钥
      const verResp = await fetch('/api-board/verify/' + encId + '?site=' + encodeURIComponent('${siteUrl}'), { credentials: 'include' });
      if (!verResp.ok) return 'api_fail';
      const verData = await verResp.json();
      return JSON.stringify(verData);
    } catch(e) { return 'api_fail:' + e.message; }
  `)

  let metaContent = null
  if (verifyResult && !verifyResult.startsWith("api_fail") && verifyResult !== "not_found" && verifyResult !== "no_enc_id") {
    try {
      const data = JSON.parse(verifyResult)
      // 从验证数据中提取 meta 标签内容
      metaContent = data.result?.metaTag || data.result?.content || data.metaTag || data.content
      if (metaContent) {
        // 如果拿到的是完整的 meta 标签，提取 content 值
        const match = metaContent.match(/content="([^"]+)"/)
        if (match) metaContent = match[1]
      }
    } catch { /* fallthrough */ }
  }

  // 如果 API 失败，尝试从页面读取
  if (!metaContent) {
    // 导航到站点设置页面查看验证选项
    open(`https://searchadvisor.naver.com/console/site/option?site=${encodedSiteUrl}`)
    waitPageReady(20)
    const optionText = pageText(6000)

    // 尝试从页面中找到 naver-site-verification 的值
    const pageContent = evalJs(`
      const text = document.body.innerText;
      const m1 = text.match(/naver-site-verification.*?content="([^"]+)"/);
      if (m1) return m1[1];
      const m2 = text.match(/확인.*?([a-f0-9]{32,})/i);
      if (m2) return m2[1];
      const codes = document.querySelectorAll('code,pre,.code');
      for (const c of codes) {
        const m3 = c.textContent.match(/content="([^"]+)"/);
        if (m3) return m3[1];
      }
      return '';
    `)
    if (pageContent) metaContent = pageContent
  }

  console.log(`\n── Naver 站点注册结果 ──`)
  console.log(`   域名: ${site}`)

  if (metaContent) {
    console.log(`   验证 meta 标签:`)
    console.log(`   <meta name="naver-site-verification" content="${metaContent}" />`)
    console.log(`\n下一步:`)
    console.log(`  1. 将上面的 meta 标签写入站点 <head> 并部署`)
    console.log(`  2. 在浏览器中打开 https://searchadvisor.naver.com/console/board`)
    console.log(`  3. 手动完成 CAPTCHA 验证（无法自动化）`)
    console.log(`  4. 验证通过后提交 sitemap:`)
    console.log(`     node naver-setup.mjs submit-sitemap --site ${site}`)
  } else {
    console.log(`   ⚠️ 无法自动提取验证 meta 标签内容`)
    console.log(`\n下一步:`)
    console.log(`  1. 在浏览器中打开 https://searchadvisor.naver.com/console/board`)
    console.log(`  2. 点击站点进入验证页面，选择 HTML 标签验证方式`)
    console.log(`  3. 复制 naver-site-verification 的 content 值`)
    console.log(`  4. 将 meta 标签写入站点 <head> 并部署`)
    console.log(`  5. 手动完成 CAPTCHA 验证（无法自动化）`)
  }
}

// verify 只点所有权验证；遇 CAPTCHA 停止，不填写或绕过。
async function doVerify() {
  open(`https://searchadvisor.naver.com/console/verify?site=${encodedSiteUrl}`)
  waitPageReady(20)
  const before = pageText(12000)
  if (/로그인|Log in|Sign in|ID或手机号|密码/.test(before)) bail("login-required", "未登录，停止")
  stampAndClick(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='소유확인')`, "ownership-verify")
  settle(1500)
  const text = pageText(12000)
  scene("verify-result")
  console.log(text)
  if (/자동등록|보안문자|보안 문자|보안절차|자동입력|captcha/i.test(text)) {
    writeManifest(evidenceDir(), {script:"naver-setup", action, site, stopReason:"captcha-required"})
    process.exitCode = 2
  }
}

// ── submit-sitemap：提交 sitemap ─────────────────────────
async function doSubmitSitemap() {
  // 直接导航到 sitemap 提交页面（参数是 ?site= 不是 ?url=）
  open(`https://searchadvisor.naver.com/console/site/request/sitemap?site=${encodedSiteUrl}`)
  waitPageReady(20)

  const text = pageText(4000)
  if (text.includes("로그인") || text.includes("Log in") || text.includes("Sign in") || /ID或手机号|密码/.test(text)) {
    bail("login-text-seen", "页面文本命中 로그인/Log in——多半未登录 Naver（也可能是撞词，看截图）。请先在浏览器中登录 searchadvisor.naver.com")
  }

  // 检查是否到达了正确的页面（是否有 sitemap 输入框）
  if (text.includes("소유확인") || text.includes("소유 확인") || text.includes("ownership")) {
    bail("ownership-text-seen", "页面文本命中 소유확인/ownership——站点可能尚未完成所有权验证（看截图确认）。先运行: node naver-setup.mjs register --site " + site)
  }

  // 找到 sitemap URL 输入框并填写
  // Naver 的输入框要求完整 URL（例如 https://example.com/sitemap.xml）
  const inputSelector = `document.querySelector('input[type="text"][placeholder*="sitemap" i],input[type="url"],input[type="text"][placeholder*="http"],input[type="text"][placeholder*="URL" i],input[type="text"][placeholder*="url"]')`
  try {
    evalJs(`const el=${inputSelector};if(!el)throw new Error('找不到 sitemap 输入框');el.focus();el.value='';`)
  } catch {
    // 更宽泛的查找：页面上的文本输入框（排除搜索框）
    evalJs(`
      const inputs = [...document.querySelectorAll('input[type="text"],input:not([type])')];
      const el = inputs.find(i => {
        const rect = i.getBoundingClientRect();
        return rect.width > 100 && !i.classList.toString().includes('search');
      });
      if (!el) throw new Error('找不到 sitemap 输入框');
      el.focus(); el.value = '';
    `)
  }
  cli(`type "${sitemapUrl}"`)
  settle(1000)

  // 点击「확인」（确认）按钮
  try {
    stampAndClick(
      `[...document.querySelectorAll('button')].find(b=>/^확인$|^제출$|^Submit$|^OK$/i.test(b.textContent.trim()))`,
      "확인 按钮"
    )
  } catch {
    // 尝试更宽松的匹配
    stampAndClick(
      `[...document.querySelectorAll('button,input[type="submit"]')].find(b=>/확인|제출|submit|추가/i.test((b.textContent||b.value||'').trim()))`,
      "提交按钮"
    )
  }
  settle(5000)

  // 检查结果。旧版有一条最危险的断言：`resultText === ""`（eval 超时读不到页面）
  // 也被当成功——「读不到」被叙述成「提交成了」。现在只报事实 + suggested，
  // 判读以截图为准。
  let resultText
  let evalTimedOut = false
  try {
    resultText = pageText(4000)
  } catch {
    // Naver SPA 在点击확인后 eval 可能超时（已知行为）——那只说明「读不到页面」，
    // 不说明提交成没成功。
    resultText = ""
    evalTimedOut = true
  }

  const okHit = ["등록", "완료", "success"].filter((w) => resultText.includes(w))
  const errHit = ["오류", "error", "실패"].filter((w) => resultText.includes(w))
  const suggested = evalTimedOut ? "unknown-eval-timeout" : errHit.length ? "error-text-seen" : okHit.length ? "success-text-seen" : "unknown"
  const finalScene = scene("submit-sitemap-final", { sitemapUrl, evalTimedOut, okHit, errHit, textHead: resultText.slice(0, 500) })
  writeManifest(evidenceDir(), { script: "naver-setup", action, site, sitemapUrl, suggested, stopReason: "flow-completed", finishedAt: new Date().toISOString() })
  console.log(`已填入 sitemap 并点击提交按钮。`)
  console.log(`   站点:    ${site}`)
  console.log(`   Sitemap: ${sitemapUrl}`)
  console.log(`   页面回读: ${evalTimedOut ? "eval 超时（读不到页面——这不是成功的证据）" : okHit.length || errHit.length ? `命中文案 ${[...okHit, ...errHit].join("/")}` : "没命中任何已知文案"}`)
  console.log(`   suggested: ${suggested}（判读以 ${evidenceDir()} 里 ${finalScene.tag} 的截图为准）`)
  console.log(`\n注意:`)
  console.log(`  - 「已提交」不等于「已处理」，Naver 处理 sitemap 需要时间`)
  console.log(`  - 可在 Search Advisor 后台查看 sitemap 处理状态:`)
  console.log(`    https://searchadvisor.naver.com/console/site/request/sitemap?site=${encodedSiteUrl}`)
  if (suggested !== "success-text-seen") process.exitCode = 1
}

// ── 执行 ──────────────────────────────────────────────────
try {
  if (action === "status") await doStatus()
  else if (action === "register") await doRegister()
  else if (action === "verify") await doVerify()
  else if (action === "submit-sitemap") await doSubmitSitemap()
} finally {
  if (!keepSession) {
    try { cli("close") } catch {}
  }
}
