#!/usr/bin/env node
/**
 * PageSpeed 取数 —— **走网页版 pagespeed.web.dev，不再走带 key 的 PSI API**
 * （2026-08-31 改）。零 key、零配额、零账号；网页版还比 API 多给两样东西：
 * CrUX 的**样本量档位**（「许多样本」/「少量样本」）和新的「智能体浏览」类别。
 *
 * 为什么要有这个脚本：段 4 闸门 6 要求「实验室与现场数据都记录，不一致以
 * 现场为准」。单跑 Lighthouse 只给实验室那一半，闸门会「只过一半而表面是绿的」。
 * 网页版一屏同时给两套，正好对上这条判据。
 *
 * ── 2026-08-31 实测（决定了这个脚本长成现在这样）────────────────────────
 *
 * 1. **网页版跑分只在标签页真的可见时才会渲染完。** 同一个 URL：
 *    Chrome 标签页处于后台（`document.visibilityState === "hidden"`）时，
 *    页面停在「Running analysis」，连测 4 轮、每轮 60–80 秒，**一次都没出分**；
 *    同一轮里标签页一变 visible，Lighthouse 报告立刻从 179 个元素涨到 8559 个、
 *    分数当场出现。数据其实早就到了（后台也能看到报告外壳，303 个元素），
 *    卡住的是**重报告的渲染**——后台标签页拿不到 rAF/空闲回调。
 * 2. **伪造可见性没用。** 试过在页内改写 `document.visibilityState` / `hidden`、
 *    把 `requestAnimationFrame` 垫成 `setTimeout`、补发 `visibilitychange` 与
 *    `focus`：页面读到的确实变成 visible，**渲染照样不动**（元素数纹丝不动）。
 *    节流发生在浏览器层，不是页面读的那个标志位。
 * 3. **历史 foreground 实测不保证持续可见**：当时 Chrome App 不在
 *    最前时标签页仍为 hidden。这不代表 PSI 必须抢系统前台；当前使用 dedicated，
 *    依据与未验证边界见下方 2026-10-04 修订。
 * 4. **慢站会跑很久**：一个低流量站连跑 240 秒都还在「Running analysis」。
 *    预算要给足，超时**不等于「没有数据」**。
 * 5. `hl=en` 生效，能把界面语言钉死（否则跟着浏览器语言走，读数正则会漂）。
 * 6. 网页版的跑分请求走的是 `_/PagespeedUi/data/batchexecute` 这个内部 RPC，
 *    参数是混淆过的，**不要试图直接调它**——它没有契约，随时会变。
 *
 * ── 窗口模式修订（2026-10-04）──────────────────────────────────────────
 * 默认使用 `--window dedicated` 专用窗口，不借用用户当前窗口、不抢系统焦点；
 * 窗口位置由 OpenCLI 的专用窗口布局管理，本轮未验证副屏落位。扩展会把会话标签设为专用窗口
 * 的活动标签，满足 PSI 的可见性要求，无需把用户窗口拉到前台。
 * 依据：2026-10-04 任务 brief 提供的本机实测——另一进程已使用 dedicated
 * 窗口在 pagespeed.web.dev 跑 PSI 并出结果。本轮不运行线上 PSI；跨环境及
 * 窗口最小化、遮挡时的表现未验证，不能保证所有环境都可见。
 * `--no-foreground` 保留为兼容别名，等同默认；只有显式 `--foreground` 才
 * 使用 foreground，并允许 hidden 时 activate Chrome 的旧兜底。这会抢用户
 * 前台窗口，仅在用户明确要求看着时用。
 *
 * 历史实测（2026-09-12）：foreground + 轮询内 activate 曾无人值守跑通，
 * 但这不能证明 PSI 必须抢系统前台。旧版尝试过不存在的 `--window active`，
 * 导致 open 失败；窗口模式须以实际支持值与实测为准，不凭原理推断。
 * activate 兜底在同步轮询里执行，没有独立后台常驻进程；当前默认不调用它。
 *
 * ── 2026-09-12 第二次实测：从「读文字」改成「抠 LHR JSON」──────────────────
 * 之前 collect 只用 `document.body.innerText` 采页面文本证人——**只拿得到可见
 * 文字**：折叠的「展开视图」明细（网络依赖关系树、每条 opportunity 的逐文件
 * 表、旧版 JavaScript 的浪费字节、缓存 TTL 表、LCP 细分、第三方分解、非合成
 * 动画元素）全部读不到，逼着人一遍遍点开「展开视图」手动核对，白跑好几轮。
 *
 * 实测确认：pagespeed.web.dev 用官方 Lighthouse report renderer 渲染报告时，
 * **完整的 LHR（Lighthouse Result）JSON 就挂在页面全局**：
 *   `window.__LIGHTHOUSE_MOBILE_JSON__`（移动端报告）
 *   `window.__LIGHTHOUSE_DESKTOP_JSON__`（桌面端报告）
 * 报告一出分（`gauges > 0`）这两个全局变量就已经就绪，`JSON.stringify` 直接
 * 拿到手就是完整 LHR——`audits` 下每一条的 `details.items` 原样都在，不需要
 * 点开任何「展开视图」。实测一份 example 规模的 LHR 约 240KB 字符串，单次
 * `opencli … eval "JSON.stringify(window.__LIGHTHOUSE_MOBILE_JSON__)"` 直接
 * 拿完整、可 `JSON.parse`，没有截断；但 `fullPageScreenshot`（内嵌 base64 大图）
 * 会让大页面的 LHR 涨到几 MB，所以 `getLhrJson()` 先只探测字符串长度，超过
 * `DIRECT_FETCH_MAX_CHARS` 才切到「页内暂存 + 分块 slice」路径，避免单次
 * eval 输出撞到 CDP/opencli 的隐性上限。
 *
 * 已知限制（2026-09-12）：
 *   - 这两个全局变量名是 pagespeed.web.dev 前端实现细节，**没有公开契约**，
 *     谷歌随时可能改名或改结构——`getLhrJson()` 失败时会自动降级到「报告
 *     工具栏另存/复制 JSON + 读剪贴板」，再失败降级到「点开所有展开视图 +
 *     读 innerText」（`source: "innerText-fallback"`），保证脚本不因为这个
 *     实现细节变化而彻底跑不出数据，但 fallback 路径下的 summary 只能是
 *     尽力而为、可能没有逐文件明细。
 *   - Lighthouse 版本较新时，经典审计 id（`uses-long-cache-ttl` /
 *     `legacy-javascript` / `network-dependency-tree` / `third-party-summary` /
 *     `render-blocking-resources` / `font-display`）已被合并进「Insights」新
 *     命名（`cache-insight` / `legacy-javascript-insight` /
 *     `network-dependency-tree-insight` / `third-parties-insight` /
 *     `render-blocking-insight` / `font-display-insight`）。`NAMED_AUDITS`
 *     两种 id 都收，按 `audits` 里实际存在的那个取，不假设固定版本。
 *   - 剪贴板 fallback 依赖 opencli 扩展 ≥ 1.1.1 的 `clipboard` 子命令与报告
 *     工具栏「Save as JSON / Copy JSON」菜单项的英文文案（`hl=en` 钉死语言
 *     后应当稳定），未逐一实测覆盖所有报错分支。
 *
 * ── 一条与取数方式无关、必须保留的判据 ──────────────────────────────────
 * **现场返回「无数据」= CrUX 流量不足，不是 0、不等于通过。** 必须原样记进
 * `.rankup/baseline.md`，留空会在下一轮被读成「查过了，没问题」。
 *
 * 用法：
 *   node pagespeed.mjs plan <url...> [--strategy mobile|desktop|both] [--hl en]
 *       只打印链接与读数清单，不采数；缺省子命令为 plan。
 *       手动打开时保持标签页可见，持续 hidden 时按历史实测可能卡住渲染。
 *   node pagespeed.mjs collect <url...> [--strategy both] [--budget 300]
 *       [--session NAME] [--out DIR] [--sleep 5] [--foreground|--no-foreground]
 *       推荐采数路径：默认 dedicated 专用窗口，报告出分后抠完整 LHR JSON。
 *       每个 (URL × 端) 落 lhr.json + summary.json + summary.md + 截图/页面
 *       文本双证人，默认目录 `.rankup/evidence/pagespeed-<ts>/`。
 *       持续 hidden 或渲染不出来时 close 重开，最多重试 3 次；每个 URL 之间
 *       sleep 默认 5 秒（`--sleep 0` 关闭）。`--no-foreground` 等同默认；
 *       `--foreground` 会抢用户前台窗口，仅在用户明确要求看着时用。

 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { newEvidenceDir, captureScene, writeManifest, msleep } from "./lib-scene.mjs";
import { opencliRun } from "./lib-opencli.mjs";

const WEB = "https://pagespeed.web.dev/analysis";
// 一次 eval 的 CDP 上限实测在 115 秒左右，所以就绪判定必须是「Node 侧多次短 eval」，
// 不能写成「页内 await 一个长定时器」——后者会以 CDP 超时的形式失败。
const POLL_MS = 4000;
const DEFAULT_BUDGET_S = 300;
const DEFAULT_SLEEP_BETWEEN_S = 5;
const MAX_REOPEN_ATTEMPTS = 3;
// 直接单次 eval 取回的字符数上限；超过就切分块 slice 路径，
// 避免 fullPageScreenshot 把 LHR 撑到几 MB 时撞到 CDP/opencli 的隐性截断。
const DIRECT_FETCH_MAX_CHARS = 1_500_000;
const CHUNK_CHARS = 200_000;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function normalizeUrl(u) {
  return u.includes("://") ? u : `https://${u}`;
}

function webUrl(target, strategy, hl) {
  const qs = new URLSearchParams({ url: target, form_factor: strategy });
  if (hl) qs.set("hl", hl);
  return `${WEB}?${qs}`;
}

function parseArgs(argv) {
  const opt = {
    strategy: null,
    hl: "en",
    budget: DEFAULT_BUDGET_S,
    session: null,
    help: false,
    foreground: false,
    out: null,
    sleep: DEFAULT_SLEEP_BETWEEN_S,
  };
  const urls = [];
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opt.help = true;
    else if (a === "--strategy") opt.strategy = argv[++i];
    else if (a === "--hl") opt.hl = argv[++i];
    else if (a === "--budget") opt.budget = Number(argv[++i]);
    else if (a === "--session") opt.session = argv[++i];
    else if (a === "--out") opt.out = argv[++i];
    else if (a === "--sleep") opt.sleep = Number(argv[++i]);
    else if (a === "--foreground") opt.foreground = true;
    else if (a === "--no-foreground") opt.foreground = false;
    else if (a.startsWith("-")) die(`未知参数：${a}`);
    else if (!cmd && (a === "plan" || a === "collect")) cmd = a;
    else urls.push(normalizeUrl(a));
  }
  const resolvedCmd = cmd || "plan";
  // plan 默认 mobile（沿用旧行为）；collect 默认 both（移动 + 桌面）——
  // 闸门 6 要求两端都跑，不给默认值等于每次都要记得手打 --strategy both。
  if (opt.strategy === null) opt.strategy = resolvedCmd === "collect" ? "both" : "mobile";
  return { cmd: resolvedCmd, urls, opt };
}

function strategies(s) {
  if (s === "both") return ["mobile", "desktop"];
  if (s === "mobile" || s === "desktop") return [s];
  die(`--strategy 只能是 mobile / desktop / both，收到：${s}`);
}

const HELP = `PageSpeed 取数（走网页版 pagespeed.web.dev，**不需要 key、不占配额**）

要拿分数用 collect——推荐采数路径，opencli 驱动本机 Chrome，直接落盘完整 LHR JSON。
默认使用 dedicated 专用窗口，扩展把会话标签设为该窗口活动标签，满足 PSI 可见性。
2026-10-04 brief 提供的本机实测已在 dedicated 窗口出分；本轮不重跑线上 PSI，
跨环境及最小化、遮挡时的表现未验证。窗口位置由 OpenCLI 的专用窗口布局管理，本轮未验证副屏落位。
plan 只打印链接、不采数，是没有 opencli 或 collect 持续失败时的兜底；
手动打开时保持标签页可见，历史实测 hidden 会卡在「Running analysis」。

  node pagespeed.mjs collect <url...> [--strategy both] [--hl en] [--budget 300]
      [--session NAME] [--out DIR] [--sleep 5] [--foreground|--no-foreground]
  node pagespeed.mjs plan <url...>    [--strategy mobile|desktop|both] [--hl en]

示例（把 <url> 换成你真正要测的站，不要对不属于自己的第三方域名跑 collect）：
  node pagespeed.mjs collect <url> --strategy both --out .rankup/evidence/pagespeed-dev
  node pagespeed.mjs plan <url> --strategy both

collect       默认路径，真正采数。用 opencli 驱动本机 Chrome，报告出分后直接抠完整
              Lighthouse LHR JSON（不再依赖展开「展开视图」界面），每个 (URL × 端)
              落 lhr.json + summary.json + summary.md + 截图/页面文本双证人，
              --strategy both 时移动端/桌面端分两次单独打开分析（各自的
              active tab 对应各自的 form_factor），另外落一份
              <url>.combined-summary.md 把两端指标并排对照，
              默认目录 .rankup/evidence/pagespeed-<ts>/。
plan          兜底方案，只打印要在浏览器里打开的链接 + 读数清单 + baseline.md 记法，
              不采数、零依赖。命令行不传子命令时参数解析缺省落到这里
              （parseArgs 里 cmd || "plan"），这只是解析缺省值，不代表 plan
              是推荐路径——手动打开链接时保持标签页可见，持续 hidden 可能卡住渲染。

选项：
  --strategy      mobile / desktop / both。plan 默认 mobile，collect 默认 both
                  （CLS 一类只在桌面触发的问题、闸门 6 都要求两端都跑）
  --hl            界面语言，默认 en（钉死语言，否则读数会跟着浏览器语言漂）
  --budget        collect 每个 (URL × 端) 的等待上限秒数，默认 ${DEFAULT_BUDGET_S}
  --session       opencli 会话名（并行任务必须各传各的，否则抢同一个标签页）
  --out           collect 的落盘目录，不传则用 .rankup/evidence/pagespeed-<ts>/
  --sleep         collect 每个 URL 之间的等待秒数，默认 ${DEFAULT_SLEEP_BETWEEN_S}（避免连续
                  打 PSI 后端），传 0 关掉
  --foreground    显式使用 --window foreground，会抢用户前台窗口，仅在用户明确要求看着时用
                  同时启用 hidden 时 activate Chrome 的兜底（仅 darwin）
  --no-foreground 兼容别名，等同默认 --window dedicated，不启用 activate 兜底
  --help          显示帮助

collect 默认打开每个链接都带 --window dedicated，不默认 foreground 或 background。
标签页持续 hidden 或渲染不出来时自动 close 会话重开，最多重试 ${MAX_REOPEN_ATTEMPTS} 次。
仍报 tab-hidden 时检查专用窗口是否保持标签页可见；可用 plan 打印链接后手动读数。
仅在用户明确要求看着时使用 --foreground；该模式连续多次探测到 hidden 才每约
15 秒 activate Chrome 一次，会打断用户当前窗口。

**现场返回「无数据」= CrUX 流量不足，不是 0、不等于通过**——原样记进 baseline.md。`;

// ── plan ────────────────────────────────────────────────────────────────

function plan(urls, opt) {
  const ss = strategies(opt.strategy);
  console.log(`═══ 网页版 PageSpeed 手测清单（${urls.length} 个 URL × ${ss.length} 端）═══\n`);
  console.log(`逐条在浏览器里打开（页面会自己跑，25 秒到几分钟不等；**别切走标签页**，`);
  console.log(`后台标签页会一直停在 Running analysis）：\n`);
  for (const u of urls) {
    for (const s of ss) {
      console.log(`  [${s}] ${webUrl(u, s, opt.hl)}`);
    }
  }
  console.log(`
每份报告读这几项，一项都不能省：

  现场（页面上半屏，标题是 Discover what your real users are experiencing）
    · Core Web Vitals 评估：Passed / Failed
    · LCP / INP / CLS 三个 p75，外加 FCP、TTFB
    · 样本量档位（「许多样本 / Many samples」还是「少量样本 / Few samples」）
    · 作用域：这个 URL（This URL）还是整个源（Origin）——**两者不能混记**
    · **整块不存在 = CrUX 流量不足。原样记「现场无数据（流量不足）」，
      不是 0、不等于通过、更不许留空。**

  实验室（下半屏，Diagnose performance issues）
    · Performance / Accessibility / Best Practices / SEO 四个分数
    · 有「智能体浏览 / Agentic browsing」这一档就一并记（网页版才有，API 不给）
    · 指标区：FCP / LCP / TBT / CLS / Speed Index
    · 跑分环境那行（Lighthouse 版本、节流档位）——**换了环境的绝对值不可比**

记进 \`.rankup/baseline.md\`，一行一个 (URL × 端)：

  | URL | 端 | 现场 CWV | LCP | INP | CLS | 样本量 | 作用域 | 实验室 Perf | 日期 |

判读规则：**实验室与现场不一致时以现场为准。** 实验室机器只跑了一种平台，
读到 0 什么都不能证明——见 references/seo-box.md 第一节。

想要逐文件明细（网络依赖树、缓存 TTL、旧版 JS polyfill 等）不必再肉眼点开
「展开视图」——用 \`collect\` 子命令，它会把完整 LHR JSON 连同逐项明细直接
落盘。`);
}

// ── collect ─────────────────────────────────────────────────────────────

function defaultSession() {
  const suffix = (
    process.env.OPENCLI_SESSION_SUFFIX ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_CODE_HOST_SESSION_ID ||
    String(process.ppid)
  ).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "local";
  return `rankup-pagespeed-${suffix}`;
}

function cli(session, args, { timeout = 120_000 } = {}) {
  return opencliRun(["browser", session, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    bin: process.env.PAGESPEED_OPENCLI,
  });
}

function openSession(session, url, foreground) {
  // --window 是 `browser <session>` 之后、子命令之前的全局选项——
  // 挂在 `open` 之后不生效，2026-09-12 实测确认过顺序。
  // 默认与 --no-foreground 均为 dedicated；仅显式 --foreground 借用用户窗口。
  // dedicated 的会话标签由扩展设为专用窗口活动标签，无需抢系统焦点。
  const openArgs = ["--window", foreground ? "foreground" : "dedicated", "open", url];
  return cli(session, openArgs, { timeout: 120_000 });
}

/**
 * 就绪探针。**只报事实，不下结论。** 返回：
 *   visibility  标签页可见性——卡住时唯一有解释力的那个字段
 *   gauges      Lighthouse 类别分数环的个数（>0 = 实验室报告已渲染）
 *   elements    穿透 shadow DOM 的元素总数（后台外壳约 300，报告出来后数千）
 *   head        页面文本开头，用来区分「还在跑」和「报错了」
 * 判据用结构（分数环存在）而不是文本长度：外壳的文本早就上万了。
 */
const PROBE = `(()=>{const o=[];const deep=(r)=>{for(const e of r.querySelectorAll("*")){o.push(e);if(e.shadowRoot)deep(e.shadowRoot)}};deep(document);
const cn=e=>typeof e.className==="string"?e.className:"";
return JSON.stringify({visibility:document.visibilityState,elements:o.length,
gauges:o.filter(e=>/lh-gauge__percentage/.test(cn(e))).length,
head:(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,200)})})()`;

function probe(session) {
  const raw = cli(session, ["eval", PROBE], { timeout: 60_000 });
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const outer = JSON.parse(raw.slice(start, end + 1));
    return typeof outer === "string" ? JSON.parse(outer) : outer;
  } catch {
    return null;
  }
}

function closeSession(session) {
  try {
    cli(session, ["close"], { timeout: 30_000 });
  } catch {
    /* 关不掉不影响已经落盘的证据 */
  }
}

// ── LHR 抓取：入口 a）页面全局变量 ────────────────────────────────────────

function lhrGlobalName(strategy) {
  return strategy === "desktop" ? "__LIGHTHOUSE_DESKTOP_JSON__" : "__LIGHTHOUSE_MOBILE_JSON__";
}

/**
 * 入口 a）：pagespeed.web.dev 用 Lighthouse report renderer 渲染报告时，
 * 完整 LHR 会挂在 `window.__LIGHTHOUSE_MOBILE_JSON__` /
 * `__LIGHTHOUSE_DESKTOP_JSON__`（2026-09-12 实测确认，见文件头注释）。
 * 先探长度，短的直接一把拿，长的（fullPageScreenshot 把 LHR 撑到几 MB 时）
 * 切到「页内暂存 + 分块 slice」，避免单次 eval 输出撞到隐性上限。
 */
function fetchLhrViaGlobal(session, strategy) {
  const varName = lhrGlobalName(strategy);
  const existsRaw = cli(session, ["eval", `typeof window.${varName}`], { timeout: 30_000 }).trim();
  if (!existsRaw.includes("object")) return null;

  const stashExpr = `(()=>{try{window.__psiLhrStr=JSON.stringify(window.${varName});return window.__psiLhrStr.length}catch(e){return -1}})()`;
  const lenRaw = cli(session, ["eval", stashExpr], { timeout: 60_000 }).trim();
  const len = Number(lenRaw.match(/-?\d+/)?.[0]);
  if (!Number.isFinite(len) || len <= 0) return null;

  let text;
  try {
    if (len <= DIRECT_FETCH_MAX_CHARS) {
      text = cli(session, ["eval", "window.__psiLhrStr"], { timeout: 90_000 });
    } else {
      const parts = [];
      for (let start = 0; start < len; start += CHUNK_CHARS) {
        const end = Math.min(start + CHUNK_CHARS, len);
        const chunk = cli(session, ["eval", `window.__psiLhrStr.slice(${start},${end})`], { timeout: 90_000 });
        parts.push(chunk.replace(/\n$/, ""));
      }
      text = parts.join("");
    }
  } finally {
    try { cli(session, ["eval", "delete window.__psiLhrStr; 1"], { timeout: 20_000 }); } catch { /* 清理失败不影响结果 */ }
  }

  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

// ── LHR 抓取：入口 b）报告工具栏「Save as JSON / Copy JSON」+ 剪贴板 ────────

function fetchLhrViaClipboardMenu(session) {
  try {
    cli(session, ["click", ".lh-tools__button"], { timeout: 20_000 });
    msleep(500);
    // 菜单项英文文案（hl=en 钉死语言）：新版是 "Copy JSON"，旧版是 "Save as JSON"。
    const clickJs = `(()=>{const items=[...document.querySelectorAll('.lh-tools--button, .lh-export__item, [role="menuitem"], a, button')];
const hit=items.find(e=>/copy json|save as json/i.test((e.textContent||'')));
if(hit){hit.click();return true}return false})()`;
    const clicked = cli(session, ["eval", clickJs], { timeout: 20_000 }).trim();
    if (!clicked.includes("true")) return null;
    msleep(500);
    const clip = cli(session, ["clipboard"], { timeout: 20_000 });
    return JSON.parse(clip.trim());
  } catch {
    return null;
  }
}

// ── LHR 抓取：入口 c）展开所有「展开视图」+ 读 innerText（兜底，不结构化）───

function fetchInnerTextFallback(session) {
  try {
    cli(session, [
      "eval",
      `(()=>{const sels=['details','.lh-expandable-details','.lh-audit-group__summary'];
for(const s of sels){document.querySelectorAll(s).forEach(e=>{try{if('open' in e)e.open=true;e.click&&e.getAttribute('aria-expanded')==='false'&&e.click()}catch(_){}});}
return 'expanded'})()`,
    ], { timeout: 30_000 });
    msleep(800);
    const text = cli(session, [
      "eval",
      `(()=>{try{return document.body?document.body.innerText.slice(0,200000):''}catch(e){return 'PAGE_TEXT_FAILED:'+e}})()`,
    ], { timeout: 60_000 });
    return text;
  } catch (e) {
    return `INNERTEXT_FALLBACK_FAILED:${String(e?.message || e)}`;
  }
}

/**
 * 三级降级取 LHR：a）页面全局变量 → b）工具栏菜单 + 剪贴板 → c）展开视图 + innerText。
 * 返回 { lhr, source } —— lhr 在 c) 时是 null，innerText 另外存在 extra 里。
 */
/**
 * 2026-09-12 实测踩的坑：`gauges>0`（探针判定「报告已渲染」）看的是穿透 shadow
 * DOM 的 `.lh-gauge__percentage` 计数，**不区分是移动端那份还是桌面端那份**
 * ——同一页面里两端报告谁先跑完谁的分数环先出现，跟 URL 里带的是
 * `form_factor=mobile` 还是 `desktop` 无关。实测过 `gauges` 先从 0 跳到 11
 * （只有 desktop 的 `__LIGHTHOUSE_DESKTOP_JSON__` 就绪，mobile 那份还要再等
 * 5–10 秒），如果这时候就去读 `__LIGHTHOUSE_MOBILE_JSON__` 会拿到
 * `undefined`。所以拿 LHR 之前必须专门等**这次请求的那一端**对应的全局变量
 * 本身就绪，不能只信通用的 gauges 探针。
 */
function waitForLhrGlobalReady(session, strategy, timeoutMs) {
  const varName = lhrGlobalName(strategy);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const existsRaw = cli(session, ["eval", `typeof window.${varName}`], { timeout: 30_000 }).trim();
    if (existsRaw.includes("object")) return true;
    if (Date.now() >= deadline) return false;
    msleep(2000);
  }
}

function getLhrJson(session, strategy, remainingBudgetMs) {
  // 先专门等这一端自己的全局变量就绪（见上方函数注释），封顶再等 60s 或剩余
  // 预算（取较小值）——不能无限等，慢站/异常情况要能降级到 b)/c)。
  const extraWaitMs = Math.max(0, Math.min(60_000, remainingBudgetMs ?? 60_000));
  const ready = waitForLhrGlobalReady(session, strategy, extraWaitMs);
  const viaGlobal = ready ? fetchLhrViaGlobal(session, strategy) : null;
  if (viaGlobal) return { lhr: viaGlobal, source: "window-global", innerText: null };

  const viaClipboard = fetchLhrViaClipboardMenu(session);
  if (viaClipboard) return { lhr: viaClipboard, source: "clipboard-menu", innerText: null };

  const innerText = fetchInnerTextFallback(session);
  return { lhr: null, source: "innerText-fallback", innerText };
}

// ── LHR → 结构化 summary ───────────────────────────────────────────────

// 经典审计 id 与新版 Insights id 并列，取 audits 里真实存在的那一个——
// 不假设固定的 Lighthouse 版本（见文件头「已知限制」）。
const NAMED_AUDIT_CANDIDATES = {
  lcpElement: ["largest-contentful-paint-element", "lcp-discovery-insight"],
  lcpBreakdown: ["lcp-breakdown-insight", "largest-contentful-paint-insight"],
  serverResponseTime: ["server-response-time"],
  thirdPartySummary: ["third-party-summary", "third-parties-insight"],
  networkDependencyTree: ["network-dependency-tree", "critical-request-chains", "network-dependency-tree-insight"],
  nonCompositedAnimations: ["non-composited-animations"],
  longCacheTtl: ["uses-long-cache-ttl", "cache-insight"],
  legacyJavascript: ["legacy-javascript", "legacy-javascript-insight"],
  unusedJavascript: ["unused-javascript"],
  unusedCssRules: ["unused-css-rules"],
  renderBlockingResources: ["render-blocking-resources", "render-blocking-insight"],
  fontDisplay: ["font-display", "font-display-insight"],
};

const CORE_METRIC_IDS = [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
];

function pickAudit(audits, candidates) {
  for (const id of candidates) {
    if (audits[id]) return { matchedId: id, ...audits[id] };
  }
  return null;
}

function buildSummary(lhr, target, strategy, source) {
  const audits = lhr.audits || {};
  const scores = {};
  for (const [key, cat] of Object.entries(lhr.categories || {})) scores[key] = cat.score;

  const metrics = {};
  for (const id of CORE_METRIC_IDS) {
    const a = audits[id];
    if (a) metrics[id] = { score: a.score, displayValue: a.displayValue, numericValue: a.numericValue, numericUnit: a.numericUnit };
  }

  const named = {};
  for (const [key, candidates] of Object.entries(NAMED_AUDIT_CANDIDATES)) {
    named[key] = pickAudit(audits, candidates);
  }

  // 每条 opportunity / diagnostic / insight 原样收——performance 类目里
  // group 属于这三种的，不按分数是否满分过滤（闸门要求逐条必修，不是只看不通过的）。
  const perfRefs = lhr.categories?.performance?.auditRefs || [];
  const auditList = [];
  for (const ref of perfRefs) {
    if (!["insights", "diagnostics", "opportunity", "load-opportunities"].includes(ref.group)) continue;
    const a = audits[ref.id];
    if (!a) continue;
    auditList.push({
      id: a.id,
      title: a.title,
      group: ref.group,
      score: a.score,
      scoreDisplayMode: a.scoreDisplayMode,
      displayValue: a.displayValue ?? null,
      numericValue: a.numericValue ?? null,
      numericUnit: a.numericUnit ?? null,
      details: a.details ?? null,
    });
  }

  let networkRequests = [];
  const nr = audits["network-requests"];
  if (nr?.details?.items) {
    networkRequests = [...nr.details.items]
      .sort((x, y) => (x.startTime ?? 0) - (y.startTime ?? 0))
      .slice(0, 20);
  }

  return {
    target,
    strategy,
    source,
    fetchTime: lhr.fetchTime ?? null,
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    finalUrl: lhr.finalUrl ?? lhr.finalDisplayedUrl ?? null,
    scores,
    metrics,
    named,
    auditList,
    networkRequests,
  };
}

// ── summary.md 渲染 ────────────────────────────────────────────────────

function fmtScore(s) {
  if (s === null || s === undefined) return "—";
  return `${Math.round(s * 100)}`;
}

// subItems 是 Lighthouse 表格详情常见的「逐条子项」形态（例如 legacy-javascript
// 每个文件下面挂着具体的 polyfill/signal 列表，network-dependency-tree 每个
// 请求下面挂着子请求）——只渲染顶层行会把这些子项漏掉，闸门要求的「逐文件表」
// 恰恰常常就在这一层，必须一起展开成缩进小表。
function subItemsToMarkdown(subItems, indent = "  ") {
  const items = subItems?.items;
  if (!Array.isArray(items) || !items.length) return "";
  const keys = [...new Set(items.flatMap((it) => Object.keys(it)))];
  let md = "";
  for (const it of items) {
    const parts = keys.map((k) => {
      const v = it[k];
      if (v === undefined || v === null) return null;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}=${s.slice(0, 160)}`;
    }).filter(Boolean);
    md += `${indent}- ${parts.join("，")}\n`;
  }
  return md;
}

function detailsToMarkdown(details) {
  if (!details) return "_（无 details）_";
  const items = details.items;
  if (Array.isArray(items) && items.length && details.headings?.length) {
    const cols = details.headings.map((h) => h.key);
    const labels = details.headings.map((h) => h.label || h.key || "");
    const rows = items.slice(0, 30).map((it) =>
      cols.map((c) => {
        if (c === null || c === undefined) return "";
        const v = it[c];
        if (v === undefined || v === null) return "";
        if (typeof v === "object") return "`" + JSON.stringify(v).slice(0, 120) + "`";
        return String(v).replace(/\|/g, "\\|").slice(0, 200);
      }),
    );
    let md = `| ${labels.join(" | ")} |\n| ${labels.map(() => "---").join(" | ")} |\n`;
    let subBlocks = "";
    items.slice(0, 30).forEach((it, i) => {
      md += `| ${rows[i].join(" | ")} |\n`;
      if (it.subItems) {
        const sub = subItemsToMarkdown(it.subItems);
        if (sub) subBlocks += `\n逐子项（${it.url || it.node?.snippet || `第 ${i + 1} 行`}）：\n${sub}`;
      }
    });
    if (items.length > 30) md += `\n_（还有 ${items.length - 30} 行，见 lhr.json / summary.json 全量）_\n`;
    if (subBlocks) md += subBlocks;
    return md;
  }
  const raw = JSON.stringify(details, null, 2);
  const truncated = raw.length > 4000 ? `${raw.slice(0, 4000)}\n… (截断，全量见 lhr.json)` : raw;
  return `\`\`\`json\n${truncated}\n\`\`\``;
}

function renderSummaryMd(summary) {
  const lines = [];
  lines.push(`# PageSpeed LHR — ${summary.target} [${summary.strategy}]`);
  lines.push("");
  lines.push(`- 抓取来源：\`${summary.source}\`（a=window-global / b=clipboard-menu / c=innerText-fallback）`);
  lines.push(`- fetchTime：${summary.fetchTime ?? "—"}`);
  lines.push(`- Lighthouse 版本：${summary.lighthouseVersion ?? "—"}`);
  lines.push(`- finalUrl：${summary.finalUrl ?? "—"}`);
  lines.push("");
  lines.push("## 分数");
  lines.push("| 类目 | 分数 |");
  lines.push("| --- | --- |");
  for (const [k, v] of Object.entries(summary.scores)) lines.push(`| ${k} | ${fmtScore(v)} |`);
  lines.push("");
  lines.push("## 核心指标");
  lines.push("| 指标 | displayValue | numericValue | 分 |");
  lines.push("| --- | --- | --- | --- |");
  for (const id of CORE_METRIC_IDS) {
    const m = summary.metrics[id];
    if (!m) continue;
    lines.push(`| ${id} | ${m.displayValue ?? "—"} | ${m.numericValue ?? "—"}${m.numericUnit ? ` ${m.numericUnit}` : ""} | ${fmtScore(m.score)} |`);
  }
  lines.push("");

  if (summary.source === "innerText-fallback") {
    lines.push("## innerText 兜底（未拿到结构化 LHR，仅供人工核对）");
    lines.push("");
    lines.push("```");
    lines.push(String(summary.innerText ?? "").slice(0, 20000));
    lines.push("```");
    return lines.join("\n") + "\n";
  }

  lines.push("## 命名审计（LCP 细分 / 缓存 / 旧版 JS / 依赖树 / 第三方 / 动画 / 服务器响应）");
  for (const [key, a] of Object.entries(summary.named)) {
    lines.push("");
    lines.push(`### ${key}${a ? ` — \`${a.matchedId}\`：${a.title ?? ""}` : ""}`);
    if (!a) {
      lines.push("_（本次 LHR 里没有匹配到候选 id，见脚本 NAMED_AUDIT_CANDIDATES）_");
      continue;
    }
    lines.push(`- score: ${fmtScore(a.score)}　displayValue: ${a.displayValue ?? "—"}　numericValue: ${a.numericValue ?? "—"}`);
    lines.push(detailsToMarkdown(a.details));
  }

  lines.push("");
  lines.push("## 逐条 opportunity / diagnostic / insight（performance 类目全量，闸门 6 要求逐条必修）");
  for (const a of summary.auditList) {
    lines.push("");
    lines.push(`### [${a.group}] ${a.id} — ${a.title}（分 ${fmtScore(a.score)}）`);
    if (a.displayValue) lines.push(`- displayValue: ${a.displayValue}`);
    if (a.numericValue !== null) lines.push(`- numericValue: ${a.numericValue}${a.numericUnit ? ` ${a.numericUnit}` : ""}`);
    lines.push(detailsToMarkdown(a.details));
  }

  lines.push("");
  lines.push("## network-requests（前 20 条，按 startTime 排序）");
  lines.push("| URL | startTime | endTime | transferSize | resourceType |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of summary.networkRequests) {
    lines.push(`| ${String(r.url || "").slice(0, 100)} | ${r.startTime ?? "—"} | ${r.endTime ?? "—"} | ${r.transferSize ?? "—"} | ${r.resourceType ?? "—"} |`);
  }

  return lines.join("\n") + "\n";
}

/**
 * 移动端和桌面端是 pagespeed.web.dev 同一次分析里的两个标签页，各自独立报告。
 * 本脚本按 form_factor 分别开两次页面（而不是开一次页面再点标签切换）——
 * 2026-09-12 实测确认：只带 `?form_factor=mobile` 打开时，`window.__LIGHTHOUSE_
 * DESKTOP_JSON__` 有时已经和 `__LIGHTHOUSE_MOBILE_JSON__` 同时就绪（PSI 后端
 * 两端分析并行跑），但**哪个标签是当前 active tab 由 URL 的 form_factor 决定**，
 * 就绪探针 `probe()` 只看当前 active tab 的分数环——分两次打开，每次都让「当前
 * 请求的那一端」是 active tab，就绪判定与取到的 LHR 才能保证对应到同一端，
 * 不依赖「切换标签后全局变量会不会重新赋值」这个未逐一验证过的细节。
 * 这里只负责把同一 URL 下 mobile / desktop 两份 summary 并排渲染成一份
 * 人读的对照文件；每端的完整逐项明细仍在各自的 <tag>.summary.md 里。
 */
function renderCombinedSummaryMd(target, perStrategy) {
  const lines = [];
  lines.push(`# PageSpeed 移动端 / 桌面端对照 — ${target}`);
  lines.push("");
  lines.push("取数方式：mobile 与 desktop 分别用 `?form_factor=mobile` / `?form_factor=desktop` 各开一次");
  lines.push("pagespeed.web.dev 分析（不是开一次后点标签切换），确保「当前 active tab」与「请求的那一端」");
  lines.push("对应一致；逐项明细见同目录下各自的 `<tag>.summary.md` / `<tag>.lhr.json`。");
  lines.push("");
  const bySrategy = Object.fromEntries(perStrategy.map((r) => [r.strategy, r]));
  const order = ["mobile", "desktop"];
  lines.push("| | " + order.map((s) => (bySrategy[s] ? s : `${s}（未采集）`)).join(" | ") + " |");
  lines.push("| --- | " + order.map(() => "---").join(" | ") + " |");
  lines.push("| stopReason | " + order.map((s) => bySrategy[s]?.stopReason ?? "—").join(" | ") + " |");
  lines.push("| LHR 来源 | " + order.map((s) => bySrategy[s]?.lhrSource ?? "—").join(" | ") + " |");
  const scoreKeys = ["performance", "accessibility", "best-practices", "seo"];
  for (const k of scoreKeys) {
    lines.push(`| ${k} 分 | ` + order.map((s) => fmtScore(bySrategy[s]?.summary?.scores?.[k])).join(" | ") + " |");
  }
  for (const id of CORE_METRIC_IDS) {
    lines.push(`| ${id} | ` + order.map((s) => metricCell(bySrategy[s]?.summary, id)).join(" | ") + " |");
  }
  const failedCount = (r) => (r?.summary ? r.summary.auditList.filter((a) => a.score !== null && a.score < 1).length : "—");
  lines.push("| 未通过审计数 | " + order.map((s) => failedCount(bySrategy[s])).join(" | ") + " |");
  return lines.join("\n") + "\n";
}

// ── 单个 (URL × 端) 的采集，含自动重开重试 ─────────────────────────────

// 连续多少次探测到 visibility === "hidden" 才认定「光切 active tab 不够，窗口
// 本身可能被完全遮挡/最小化」，从而触发 osascript activate 兜底。3 次 ×
// POLL_MS(4s) ≈ 12 秒——见文件头「第四次改动」。
const STUCK_HIDDEN_THRESHOLD = 3;

function waitForReady(session, deadline, foreground) {
  let last = null;
  let hiddenStreak = 0;
  while (Date.now() < deadline) {
    msleep(POLL_MS);
    const p = probe(session);
    if (p) last = p;
    if (p && p.gauges > 0) return { ready: true, last };
    // 仅显式 --foreground 启用 activate 兜底；默认 dedicated 不执行。
    // foreground open 应该已经让这个
    // tab 保持可见。只有连续 STUCK_HIDDEN_THRESHOLD 次都探测到 hidden，才怀疑
    // 窗口本身被遮挡/最小化，退化成抢一次 OS 焦点。
    if (foreground) {
      if (p && p.visibility === "hidden") {
        hiddenStreak += 1;
        if (hiddenStreak >= STUCK_HIDDEN_THRESHOLD) activateChromeIfDue();
      } else {
        hiddenStreak = 0;
      }
    }
  }
  return { ready: false, last };
}

function collectOnce(session, target, strategy, opt) {
  const url = webUrl(target, strategy, opt.hl);
  const deadline = Date.now() + opt.budget * 1000;
  let last = null;
  let stopReason = "not-ready";

  try {
    openSession(session, url, opt.foreground);
  } catch (e) {
    return { stopReason: "opencli-open-failed", last: { error: String(e?.stderr || e?.message || e).slice(0, 400) }, url };
  }

  const r = waitForReady(session, deadline, opt.foreground);
  last = r.last;
  if (r.ready) {
    stopReason = "ready";
  } else {
    // 卡住的成因分两种，说法必须不同——**都不是「这个站没有数据」**。
    stopReason = last && last.visibility === "hidden" ? "tab-hidden" : "budget-exhausted";
  }
  return { stopReason, last, url, remainingBudgetMs: Math.max(0, deadline - Date.now()) };
}

/**
 * tab-hidden / 渲染不出来（budget-exhausted 且 elements 很低，判定为空白页）时
 * 自动 close 会话重开一个新 tab，最多重试 MAX_REOPEN_ATTEMPTS 次——
 * 不确定是不是「这个站没有数据」之前，先排除「标签页/会话本身坏了」这条路。
 */
function collectOneWithRetry(session, dir, target, strategy, opt) {
  const tag = `${strategy}-${target.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50)}`;
  let attempt = 0;
  let outcome;
  for (;;) {
    attempt += 1;
    outcome = collectOnce(session, target, strategy, opt);
    const blank = outcome.last && outcome.last.elements !== undefined && outcome.last.elements < 50;
    const shouldRetry = (outcome.stopReason === "tab-hidden" || (outcome.stopReason === "budget-exhausted" && blank))
      && attempt < MAX_REOPEN_ATTEMPTS;
    if (!shouldRetry) break;
    console.error(`[psi-web]   attempt ${attempt} → ${outcome.stopReason}（elements=${outcome.last?.elements ?? "?"}），close 重开重试…`);
    closeSession(session);
    msleep(1500);
  }

  let lhrResult = null;
  if (outcome.stopReason === "ready") {
    lhrResult = getLhrJson(session, strategy, outcome.remainingBudgetMs);
  }

  let summary = null;
  if (lhrResult?.lhr) {
    summary = buildSummary(lhrResult.lhr, target, strategy, lhrResult.source);
  } else if (lhrResult) {
    summary = { target, strategy, source: lhrResult.source, innerText: lhrResult.innerText, scores: {}, metrics: {}, named: {}, auditList: [], networkRequests: [] };
  }

  if (lhrResult?.lhr) {
    try { writeFileSync(join(dir, `${tag}.lhr.json`), JSON.stringify(lhrResult.lhr, null, 2) + "\n"); } catch { /* 落盘失败不能拦住后续 */ }
  }
  if (summary) {
    try { writeFileSync(join(dir, `${tag}.summary.json`), JSON.stringify(summary, null, 2) + "\n"); } catch { /* 同上 */ }
    try { writeFileSync(join(dir, `${tag}.summary.md`), renderSummaryMd(summary)); } catch { /* 同上 */ }
  }

  // 双证人（截图 + 页面文本）照旧留一份，卡住时这是唯一的现场记录。
  captureScene({
    dir,
    tag,
    screenshot: (p) => cli(session, ["screenshot", p], { timeout: 90_000 }),
    pageText: () =>
      cli(session, [
        "eval",
        `(()=>{try{return document.body?document.body.innerText.slice(0,60000):''}catch(e){return 'PAGE_TEXT_FAILED:'+e}})()`,
      ], { timeout: 60_000 }),
    extra: { target, strategy, webUrl: outcome.url, stopReason: outcome.stopReason, attempts: attempt, probe: outcome.last, lhrSource: lhrResult?.source ?? null },
  });

  return {
    target,
    strategy,
    webUrl: outcome.url,
    stopReason: outcome.stopReason,
    attempts: attempt,
    probe: outcome.last,
    lhrSource: lhrResult?.source ?? null,
    summary,
  };
}

function explain(stopReason) {
  switch (stopReason) {
    case "ready":
      return "报告已渲染，LHR 已抠出落盘";
    case "tab-hidden":
      return "标签页一直是 hidden —— **这是没出分的原因，不是这个站没有数据**。" +
        "检查专用窗口的会话标签是否可见；已自动重试重开，仍不行用 plan 打印链接手动读数。" +
        "仅在用户明确要求看着时才使用 --foreground（会抢用户前台窗口）";
    case "budget-exhausted":
      return "标签页可见但预算内没跑完 —— 慢站实测能跑几分钟。加大 --budget 重试；" +
        "**超时不等于没有数据**";
    case "opencli-open-failed":
      return "opencli 打不开页面，先跑 `opencli doctor`";
    default:
      return stopReason;
  }
}

// 兜底 activate 的最小间隔（毫秒）——即使持续卡在 hidden，也最多每 15 秒抢
// 一次焦点，不逐次 POLL_MS（4 秒）轮询都触发。历史上（第三次实测那版）这是
// 主路径的固定节奏；第四次改动后降级为「只在真正卡住时才用」的兜底节奏，
// 常量沿用同一个值。
const FOREGROUND_ACTIVATE_INTERVAL_MS = 15_000;
let lastForegroundActivateAt = 0;

/**
 * 仅显式 --foreground 启用的抢 OS 焦点兜底；默认 dedicated 不调用。
 * 以下为 2026-09-12 foreground 路径的历史实测：`openSession()` 里的
 * `--window foreground`（opencli 真实支持的 raise + select 档），已经在
 * `open` 那一刻同时把 tab 切前台并把窗口聚焦到系统前台——2026-09-12 第五次
 * 改动实测确认当时的 foreground 参数可出分。但 `open` 只保证那一瞬间的状态，之后只要有
 * 别的东西（用户切走、终端本身在前台跑脚本把 Chrome 挤到后台等）抢走系统
 * 前台，标签页仍可能重新变 hidden——实测两端各触发过一次本函数，兜底并没有
 * 变得多余。`waitForReady()` 在连续 STUCK_HIDDEN_THRESHOLD 次探测到 tab
 * 仍是 hidden 时才调用本函数，再调用一次 `osascript activate` 把整个
 * Chrome App 拉回系统前台，代价是这一下会打断用户当时在用的其他窗口。
 *
 * 2026-09-12 第三次实测后的实现：**不再另起进程**。最初版本用
 * `spawn(..., { detached: true })` 起一个独立 bash 死循环，靠
 * `process.on('exit'/'SIGINT'/'SIGTERM')` 兜底清理防止父进程被强杀时
 * 留下孤儿进程——这个兜底本身没问题，但复核后发现整套「detached 子进程 +
 * 信号清理」都是不必要的复杂度：本函数是从 `waitForReady()` 那个本来就在跑
 * 的同步轮询循环里直接调用的，父进程运行期间自然会周期性执行到这里，不需要
 * 另开一个进程做同一件事。没有 detached 子进程，也就不存在「清理来不及跑、
 * 留下常驻孤儿」这类风险。只在 darwin 上生效；`osascript` 不存在/失败
 * 不能拖垮主流程，吞掉即可。
 */
function activateChromeIfDue() {
  if (process.platform !== "darwin") return;
  const now = Date.now();
  if (now - lastForegroundActivateAt < FOREGROUND_ACTIVATE_INTERVAL_MS) return;
  lastForegroundActivateAt = now;
  try {
    execFileSync("osascript", ["-e", 'tell application "Google Chrome" to activate'], {
      stdio: "ignore",
      timeout: 5000,
    });
    console.error("[psi-web]   检测到报告卡住（标签页持续 hidden），已临时抢占前台以恢复。");
  } catch {
    /* 起不来就当没有这层保险，不影响主流程 */
  }
}

function outputDir(opt) {
  if (opt.out) {
    const dir = resolve(opt.out);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return newEvidenceDir("pagespeed");
}

function metricCell(summary, id) {
  const m = summary?.metrics?.[id];
  if (!m) return "—";
  return m.displayValue ?? (m.numericValue !== undefined ? String(m.numericValue) : "—");
}

function printCompactTable(results) {
  console.log("\n┌─────────────────────────────────────────────────────────────────────────┐");
  console.log("URL | 端 | 分 | FCP | LCP | TBT | CLS | 未通过审计数");
  for (const r of results) {
    const s = r.summary;
    const perf = s ? fmtScore(s.scores?.performance) : "—";
    const fcp = metricCell(s, "first-contentful-paint");
    const lcp = metricCell(s, "largest-contentful-paint");
    const tbt = metricCell(s, "total-blocking-time");
    const cls = metricCell(s, "cumulative-layout-shift");
    const failed = s ? s.auditList.filter((a) => a.score !== null && a.score < 1).length : "—";
    console.log(`${r.target} | ${r.strategy} | ${perf} | ${fcp} | ${lcp} | ${tbt} | ${cls} | ${failed}`);
  }
  console.log("└─────────────────────────────────────────────────────────────────────────┘");
}

function collect(urls, opt) {
  const ss = strategies(opt.strategy);
  const session = opt.session || defaultSession();
  const dir = outputDir(opt);
  const results = [];
  console.error(
    `[psi-web] 证据目录 ${dir}\n` +
    (opt.foreground
      ? `[psi-web] 显式 --foreground：会抢用户前台窗口，open 带 --window foreground（raise + select）` +
        (process.platform === "darwin"
          ? "，卡住超过阈值才会退化成 activate 兜底一次（darwin，不额外起进程）。"
          : "（非 darwin，无 activate 兜底）。")
      : `[psi-web] dedicated 专用窗口：open 带 --window dedicated，不启用 activate 兜底。`),
  );
  try {
    for (let ui = 0; ui < urls.length; ui++) {
      const u = urls[ui];
      const perUrl = [];
      for (const s of ss) {
        console.error(`[psi-web] ${s} ${u} …（最多等 ${opt.budget}s）`);
        const r = collectOneWithRetry(session, dir, u, s, opt);
        results.push(r);
        perUrl.push(r);
        console.error(`[psi-web]   → ${r.stopReason}：${explain(r.stopReason)}（LHR 来源：${r.lhrSource ?? "无"}）`);
      }
      // 移动端和桌面端都采了的话，另外落一份并排对照——见 renderCombinedSummaryMd 头注释。
      if (ss.length > 1) {
        const urlTag = u.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60);
        try {
          writeFileSync(join(dir, `${urlTag}.combined-summary.md`), renderCombinedSummaryMd(u, perUrl));
        } catch { /* 并排对照写不进不影响各自的 summary.md 已经落盘 */ }
      }
      // 每个 URL 之间歇一口气，避免连续几十次请求打在 PSI 后端上——
      // 不用 backlink 那套面向 opencli batch 数组的 sleepStep()（那是往
      // batch 里插一步页内 setTimeout），这里是脚本自身两次 open 之间的
      // node 侧同步等待，语义不同，直接复用 lib-scene 的 msleep 即可。
      if (opt.sleep > 0 && ui < urls.length - 1) msleep(opt.sleep * 1000);
    }
  } finally {
    try {
      writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
    } catch { /* 落盘失败不能拦住关会话 */ }
    try {
      writeManifest(dir, {
        script: "pagespeed",
        mode: "web-lhr",
        session,
        hl: opt.hl,
        budgetSeconds: opt.budget,
        targets: results.map((r) => ({ target: r.target, strategy: r.strategy, stopReason: r.stopReason, lhrSource: r.lhrSource, attempts: r.attempts })),
        finishedAt: new Date().toISOString(),
      });
    } catch { /* 同上 */ }
    closeSession(session);
  }

  console.log(`\n证据在 ${dir}（每个 (URL × 端)：lhr.json + summary.json + summary.md + 截图/页面文本）。`);
  console.log(`本脚本只采集，**不下结论**——分数、现场有没有数据，由 AI 对着`);
  console.log(`summary.md 与 lhr.json 判读，然后按 plan 子命令给的表格记进 .rankup/baseline.md。\n`);
  for (const r of results) {
    console.log(`  [${r.strategy}] ${r.target} → ${r.stopReason}（LHR 来源：${r.lhrSource ?? "无"}，尝试 ${r.attempts} 次）`);
  }
  printCompactTable(results);
  const stuck = results.filter((r) => r.stopReason !== "ready");
  if (stuck.length) {
    console.log(`\n${stuck.length} 个没跑出报告。**不要把它们记成「性能没问题」或「没有数据」**：`);
    for (const r of stuck) console.log(`  · [${r.strategy}] ${r.target} — ${explain(r.stopReason)}`);
    process.exitCode = 2;
  }
}

// ── main ────────────────────────────────────────────────────────────────

const { cmd, urls, opt } = parseArgs(process.argv.slice(2));
if (opt.help) {
  console.log(HELP);
  process.exit(0);
}
if (urls.length === 0) {
  console.log(HELP);
  process.exit(1);
}
if (!Number.isFinite(opt.budget) || opt.budget <= 0) die(`--budget 要是正数秒数，收到：${opt.budget}`);
if (!Number.isFinite(opt.sleep) || opt.sleep < 0) die(`--sleep 要是非负数秒数，收到：${opt.sleep}`);

if (cmd === "collect") collect(urls, opt);
else plan(urls, opt);
