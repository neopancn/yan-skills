#!/usr/bin/env node
/**
 * 本地公式与官方目录尚无等价工具的旧用途。
 * 2026-09-30 核对官方 gefei 工具目录：保留下表中的单页信号、聚合、
 * 输入判型、历史报告、起名意图/撞名/会话用途；其他网络命令改走官方 Skill。
 * 旧接口使用网站每日配额口径，不能当作官方开放 API 积分。
 * translatePage/Aggregate/Me、mineSeed/Page/Report、domainSessions 原记录不计配额；
 * serpPage、domainIntent/Collision 的实际扣费以旧接口响应为准，未知不写成免费。
 * 本地 kgr/string/money/email 零网络、零配额；凭据只在旧请求进程内使用，不输出。
 * kgr/money 的 KD 派生值保留为历史计算，不参与选词与立项裁决；JSON 字段兼容保留。
 * 2026-09-30 mineSeed 实跑 HTTP 200，返回 type/value；其余独有端点未逐项实跑。
 */
import { writeFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newEvidenceDir, writeManifest } from "./lib-scene.mjs";
import { opencliRun, opencliAvailable } from "./lib-opencli.mjs";

const BASE = "https://seo.web.cafe";
const WEBCAFE_SESSION = "webcafe-nav";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TOKEN_RE = /[0-9]{13}\.[0-9a-f]{64}/;
const HEADER_RE = /X-[A-Z]{2,8}-Token/;

/** 官方目录暂无等价能力的旧端点。 */
const TOOLS = {
  serpPage: { tool: "serp", path: "/serp/api/page", body: (a) => ({ url: req(a.url, "--url"), keyword: req(a.keyword, "--keyword") }), desc: "单个 SERP 结果页的评分（旧接口）" },
  translatePage: { tool: "translate", path: "/translate/api/page", body: (a) => ({ url: req(a.url, "--url") }), desc: "需求翻译：单页面信号分析（不计旧配额）" },
  translateAggregate: {
    tool: "translate",
    path: "/translate/api/aggregate",
    body: (a) => {
      const pages = jsonArg(a.pages, "--pages") ?? [];
      const related = jsonArg(a.related, "--related") ?? [];
      const sites = jsonArg(a.sites, "--sites") ?? [];
      if (!pages.length && !related.length && !sites.length) {
        die("--pages/--related/--sites 三个都是空数组——先取到数据再聚合，不要直接跑空的。");
      }
      return { pages, related, sites, query: req(a.query, "--query") };
    },
    desc: "需求翻译：把已取的 page/related/site 数据聚合成选词表（不计旧配额）",
  },
  translateMe: { tool: "translate", path: "/translate/api/me", method: "GET", desc: "需求翻译：读取旧配额档位（不计旧配额）" },
  mineSeed: { tool: "mine", path: "/mine/api/seed", body: (a) => ({ input: req(a.input, "--input") }), desc: "需求挖掘：把输入判定成关键词还是网址（不计旧配额）" },
  minePage: { tool: "mine", path: "/mine/api/page", body: (a) => ({ url: req(a.url, "--url") }), desc: "需求挖掘：单页面信号分析（不计旧配额）" },
  mineReport: {
    tool: "mine", path: "/mine/api/report", method: "GET",
    query: (a) => (a.seed ? { seed: a.seed } : a.id ? { id: a.id } : die("mineReport 需要 --seed 或 --id 其中一个")),
    desc: "需求挖掘：取回已生成报告（不计旧配额，--seed 或 --id）",
  },
  domainIntent: { tool: "domain", path: "/domain/api/intent", body: (a) => ({ text: req(a.text, "--text"), hasCandidates: !!a.hasCandidates }), desc: "网站起名：从描述提炼意图与 brief（旧接口）" },
  domainCollision: { tool: "domain", path: "/domain/api/collision", body: (a) => ({ name: req(a.name, "--name") }), desc: "网站起名：品牌撞名风险（旧接口）" },
  domainSessions: { tool: "domain", path: "/domain/api/sessions", method: "GET", desc: "网站起名：历史起名会话（不计旧配额）" },
};

/**
 * 解析聚合数组参数（--pages/--related/--sites）。
 * CLI 参数只能是字符串，数组必须以 JSON 字符串形式传入，例如
 *   --pages '[{"url":"https://example.com"}]'
 * 不给该参数时返回 undefined（区别于「给了但解析失败」），后者要报错。
 */
function jsonArg(v, flag) {
  if (v === undefined || v === true) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(v);
  } catch {
    die(`${flag} 需要合法 JSON 数组字符串，例如 '["a","b"]'（实际传入：${v}）`);
  }
  if (!Array.isArray(parsed)) die(`${flag} 必须是 JSON 数组，例如 '["a","b"]'（实际传入：${v}）`);
  return parsed;
}
/**
 * 纯客户端工具，没有后端，别去探。8 个里 4 个已经把内联 JS 的公式抄下来，
 * 复刻成本地命令（见下面的 LOCAL 表），零网络零配额，价值是能批量算。
 * 剩下 4 个明确不做，理由各不相同，逐个写清楚，免得后来人以为是漏做：
 *
 *   - traffic：CSV 解析 + 可视化，强绑一条上传的曲线数据，没有可复用的公式，
 *     批量价值低，不做。
 *   - influencer：单次议价场景（一次报价 vs 一个 YouTuber），不是能批量跑的东西，不做。
 *   - level：纯静态说明页，实测页面里 0 个 <input>/<form>，没有算法可复刻，不做。
 *   - gsc：实测页面全文 `fetch(` 只命中两处——VIP 门禁用的 `/gsc/api/me` 和
 *     教程文案用的 `/gsc/api/tutorial`，都不是数据接口；模拟数据是浏览器里
 *     `Math.random()` 现算的，没有后端也没有可抄的公式，不做。
 *     （gsc 原本没被列进这张表，容易被漏判成"忘了做"，这次一并标出来。）
 */
const NOT_DONE = {
  traffic: "CSV 解析+可视化，强绑上传的曲线数据，没有可复用公式，批量价值低",
  influencer: "单次议价场景，不是能批量跑的东西",
  level: "纯静态说明页，0 个 input/form，没有算法可复刻",
  gsc: "全文 fetch( 只命中 VIP 门禁 /gsc/api/me 和教程文案 /gsc/api/tutorial；模拟数据是浏览器 Math.random() 现算，无数据后端",
};

function req(v, flag) {
  // parseArgs 对「给了 flag 但没跟值」的编码是把值设成布尔 true（当成开关标志）。
  // 对于 req() 覆盖的这些「必须带值」的参数，true 不是合法值，而是「少打了一个值」，
  // 必须当成缺失处理——否则 --volume（不跟数字）会被当作字符串/布尔值静默往下传。
  if (v === undefined || v === null || v === "" || v === true) die(`缺少必需参数 ${flag}（给了标志但没跟值？）`);
  return v;
}
function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const cmd = argv[0];
  const a = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) die(`未知参数：${t}（用 --help 看用法）`);
    const k = t.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[k] = true;
    else { a[k] = next; i++; }
  }
  return { cmd, a };
}

/**
 * 批量模式：每行一组参数，跟顶层 --xxx 合并（行内同名字段覆盖顶层）。
 * 抽成独立函数是因为本地命令（kgr/string/money/email）和远端命令共用同一套
 * batch 文件格式——之前只有远端命令走了这条路，LOCAL 分支在 batch 逻辑之前就
 * return 了，HELP 却写着本地命令「可批量」，实测直接报「缺少必需参数」，
 * 承诺和行为对不上（可批量本来就是复刻这四个公式的全部理由）。
 */
function parseBatchRows(a) {
  if (!a.batch) return [a];
  return readFileSync(a.batch, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => ({
      ...a,
      ...Object.fromEntries(
        l.split(/\s+(?=[a-z]+=)/).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; })
      ),
    }));
}

/** 旧请求的可选 Cookie，只在进程内使用。 */
function cookie() {
  return process.env.SEO_WEBCAFE_COOKIE || "";
}
function authHeaders() {
  const c = cookie();
  return c ? { "user-agent": UA, cookie: c } : { "user-agent": UA };
}

/** 抓工具页 HTML，自助取该工具的令牌与请求头名。这一步不消耗查询配额。 */
const tokenCache = new Map();
async function toolAuth(tool) {
  if (tokenCache.has(tool)) return tokenCache.get(tool);
  const r = await fetch(`${BASE}/${tool}/`, { headers: authHeaders() });
  if (!r.ok) die(`取 /${tool}/ 页面失败：HTTP ${r.status}`);
  const html = await r.text();
  const tok = (html.match(TOKEN_RE) || [])[0];
  const hdr = (html.match(HEADER_RE) || [])[0];
  if (!tok || !hdr) {
    die(
      `在 /${tool}/ 的 HTML 里没找到令牌或请求头名。\n` +
        "多半是站点改版了令牌注入方式（不带 Cookie 本来也应该能拿到令牌）。\n" +
        "后者属于正常损耗，请更新本脚本顶部的 TOKEN_RE / HEADER_RE 并回写已验证日期。"
    );
  }
  const auth = { [hdr]: tok };
  tokenCache.set(tool, auth);
  return auth;
}

/**
 * 登录态默认路径（2026-09-11 事故修复）：驱动用户本机已登录的真实 Chrome（OpenCLI），
 * 把请求发进已登录的页面里执行，而不是抠 httpOnly cookie。
 *
 * 之前的版本只在 quotaPreflight 里打一段文字提示「你可以这样手动跑」，从不真的执行——
 * 结果是没人愿意手动敲那几行 opencli 命令，脚本实际上永远走 node 侧裸 fetch，
 * 永远匿名，永远访客档 10/日。三个执行者今天用同一个 KD_TOKEN 批量跑 kd 很快耗尽，
 * 就是把这条误导性的访客计数当成了真实上限（见 officialQuotaPreflight 的实测修正）。
 * 这里把「能力」变成「默认行为」：session 类工具默认经浏览器执行，访客只在
 * OpenCLI 不可用或显式 --guest 时作为兜底，并且兜底必须在 stdout 打印醒目警告。
 * 跨平台 spawn 细节（Windows 的 .cmd 壳问题）统一在 lib-opencli.mjs，勿在此重抄。
 */
/** 一个进程内同一个工具页只 open 一次——批量模式下同一 spec 会调很多次，没必要每次都重新导航。 */
const browserOpenedTools = new Set();
function opencliOpenTool(tool) {
  if (browserOpenedTools.has(tool)) return;
  opencliRun(["browser", WEBCAFE_SESSION, "open", `${BASE}/${tool}/`], {
    encoding: "utf8",
    timeout: 30000,
  });
  browserOpenedTools.add(tool);
}

/** 在已打开的工具页里跑一段 eval，返回其 stdout（opencli 把结果 JSON 打到 stdout，警告走 stderr）。 */
function opencliEval(code) {
  // JS 整体 base64 成无空格单 token：opencli 直连路（node.exe + main.js）本来就不怕
  // 空格，但兜底的 cmd shell 路怕；包装对两条路都无损。
  const b64 = Buffer.from(code, "utf8").toString("base64");
  const wrapped =
    "(async()=>{const b='" + b64 + "';" +
    "const bin=atob(b);const u8=new Uint8Array(bin.length);" +
    "for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);" +
    "const code=new TextDecoder().decode(u8);return (0,eval)(code);})()";
  return opencliRun(["browser", WEBCAFE_SESSION, "eval", wrapped], {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
}

/**
 * 把一次 HTTP 请求发进浏览器里执行：页面自己抽令牌（同 toolAuth 的正则，但读的是
 * 浏览器里已登录会话渲染出的 HTML，天然带 Cookie）+ `credentials:"include"` 发请求。
 * 返回 {status, raw}，由旧接口 JSON 解析路径处理。
 */
async function browserRequest(spec, a) {
  opencliOpenTool(spec.tool);
  const method = spec.method || "POST";
  const bodyStr = method === "POST" ? JSON.stringify(spec.body(a)) : null;
  const qs = method === "GET" && spec.query ? `?${new URLSearchParams(spec.query(a))}` : "";
  const code = `(async()=>{
    const html = document.documentElement.outerHTML;
    const tok = (html.match(${TOKEN_RE.toString()})||[])[0];
    const hdr = (html.match(${HEADER_RE.toString()})||[])[0];
    if (!tok || !hdr) return {__err: "在页面 HTML 里没找到令牌或请求头名，多半是站点改版了"};
    const headers = {[hdr]: tok};
    const opts = {method: ${JSON.stringify(method)}, credentials: "include", headers};
    ${bodyStr ? `headers["content-type"] = "application/json"; opts.body = ${JSON.stringify(bodyStr)};` : ""}
    const r = await fetch(${JSON.stringify(spec.path + qs)}, opts);
    const raw = await r.text();
    return {__status: r.status, __raw: raw};
  })()`;
  let out;
  try {
    out = opencliEval(code);
  } catch (e) {
    throw new Error(`opencli eval 执行失败（session=${WEBCAFE_SESSION}）：${String(e?.message || e).slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`opencli eval 返回的不是预期 JSON：${out.slice(0, 300)}`);
  }
  if (parsed.__err) throw new Error(parsed.__err);
  return { status: parsed.__status, raw: parsed.__raw };
}

function warnGuestFallback(reason) {
  console.error(`旧接口改用访客请求：${reason}；登录与配额以本轮响应为准。`);
}

function finalizeSessionResult(spec, status, txt) {
  return { status, data: safeJson(txt), raw: txt };
}

/**
 * 访客/手动 Cookie 路径（node 侧裸 fetch）。**这是降级路径，不是默认路径**——
 * 只有 --guest 显式要求、或 SEO_WEBCAFE_COOKIE 手动给了、或 OpenCLI 不可用兜底时才走这里。
 * 默认路径是下面的 callSessionAuto → browserRequest。
 */
async function callSessionGuest(spec, a) {
  const auth = await toolAuth(spec.tool);
  const method = spec.method || "POST";
  const opt = { method, headers: { ...auth, ...authHeaders() } };
  if (method === "POST") {
    opt.headers["content-type"] = "application/json";
    opt.body = JSON.stringify(spec.body(a));
  }
  const qs = method === "GET" && spec.query ? `?${new URLSearchParams(spec.query(a))}` : "";
  const r = await fetch(`${BASE}${spec.path}${qs}`, opt);
  const txt = await r.text();
  return finalizeSessionResult(spec, r.status, txt);
}

/** 旧接口保持原有登录态浏览器优先、访客兜底路径。 */
async function callSessionAuto(spec, a) {
  if (a.guest) {
    return callSessionGuest(spec, a);
  }
  if (cookie()) return callSessionGuest(spec, a); // 手动给了 Cookie，跳过浏览器
  if (!opencliAvailable()) {
    warnGuestFallback("本机 OpenCLI 不可用");
    return callSessionGuest(spec, a);
  }
  try {
    const { status, raw } = await browserRequest(spec, a);
    return finalizeSessionResult(spec, status, raw);
  } catch (e) {
    warnGuestFallback(`驱动登录态浏览器失败：${String(e.message).slice(0, 150)}`);
    return callSessionGuest(spec, a);
  }
}

function safeJson(t) {
  try { return JSON.parse(t); } catch { return null; }
}

function summarize(name, data) {
  if (!data) return "（非 JSON 响应）";
  if (name === "translatePage") return `${data.title ?? data.url} · ${data.wordCount ?? "—"} 词 · 首页:${data.isHomepage ? "是" : "否"} · 关键词候选 ${(data.keywords || []).length} 个`;
  if (name === "translateAggregate") return `聚合 ${Object.values(data.aggregated || {}).flat().length} 词 · 精选 ${(data.picks || []).length} 个 · 未覆盖 ${(data.uncovered || []).length} 个`;
  if (name === "mineSeed") return `判定为「${data.type ?? "—"}」：${data.value ?? "—"}`;
  if (name === "minePage") return `${data.title ?? data.url} · ${data.wordCount ?? "—"} 词`;
  if (name === "domainIntent") return `意图：${data.intent ?? "—"} · brief：${(data.brief || "").slice(0, 60)}`;
  if (name === "domainCollision") return `撞名风险 ${data.collision?.risk ?? "—"}：${(data.collision?.reason || "").slice(0, 60)}`;
  if (data.error) return `错误 ${data.code}：${data.error}`;
  return Object.keys(data).slice(0, 8).join(", ");
}

/**
 * 本地命令：4 个纯前端工具的公式复刻，零网络、零配额、可批量。
 * 公式全部照抄自对应工具页面的内联 <script>（2026-08-24 抓取核对），
 * 不调用任何 seo.web.cafe 的接口，也不取令牌——LOCAL 命令走这条独立分支，
 * 绝不能不小心接进 callSessionAuto 那条会发请求的路径。
 */
const KD_DOMAINS = { 0: 0, 10: 10, 20: 22, 30: 36, 40: 56, 50: 84, 60: 129, 70: 202, 80: 353, 90: 756, 100: 1200 };
/** 历史计算：KD → 引荐域名数，Ahrefs 经验对照表线性插值（抄自 /kgr/ 与 /money/；不参与选词与立项裁决）。 */
function requiredDomains(kd) {
  if (kd <= 0) return 0;
  const keys = Object.keys(KD_DOMAINS).map(Number).sort((x, y) => x - y);
  let lo = 0, hi = 100;
  for (const k of keys) {
    if (k <= kd && k > lo) lo = k;
    if (k >= kd && k < hi) hi = k;
  }
  if (lo === hi) return KD_DOMAINS[lo];
  return Math.round(KD_DOMAINS[lo] + (kd - lo) * (KD_DOMAINS[hi] - KD_DOMAINS[lo]) / (hi - lo));
}
/** 外链阶梯计价：前 10 条 $100；11~50 条每条 +1%；51~200 条每条 +1.5%；200+ 条每条 +2%。 */
function linkCost(n) {
  if (n <= 10) return 100;
  if (n <= 50) return 100 * (1 + (n - 10) * 0.01);
  if (n <= 200) return 100 * (1 + 40 * 0.01 + (n - 50) * 0.015);
  return 100 * (1 + 40 * 0.01 + 150 * 0.015 + (n - 200) * 0.02);
}
function totalLinkCost(total) {
  let s = 0;
  for (let i = 1; i <= total; i++) s += linkCost(i);
  return s;
}
function numArg(v, flag) {
  const n = Number(req(v, flag));
  if (Number.isNaN(n)) die(`${flag} 需要是数字（实际传入：${v}）`);
  return n;
}
/**
 * 带默认值的数字参数：不传就用默认值，传了就必须是合法数字。
 * money 命令的 6 个可选参数（sites/kws/rankpos/rpm/saas/pvuv/kd）此前直接
 * `Number(a.x)` 不校验——`--kd abc` 会得到 NaN，clamp(NaN,...) 还是 NaN，
 * 一路穿到 totalLinkCost(NaN) 里（`for(i=1;i<=NaN;i++)` 一次都不进）算出 cost=0，
 * 于是「参数打错了」被叙述成「外链投入 $0、ROI ∞x」这种看着极乐观的结果。
 * 所有可选数字参数都必须走这里，不能再裸 Number() 了。
 */
function optNumArg(v, flag, def) {
  if (v === undefined) return def;
  if (v === true) die(`${flag} 需要跟一个数字（给了标志但没跟值）`);
  const n = Number(v);
  if (Number.isNaN(n)) die(`${flag} 需要是数字（实际传入：${v}）`);
  return n;
}

const LOCAL = {
  kgr: {
    desc: "历史公式：KGR / EKGR / KDROI（历史计算，不参与选词与立项裁决；零网络零配额）",
    help: "--volume <月搜索量> --intitle <intitle 结果数> --kd <0-100 难度分>",
    run: (a) => {
      const volume = numArg(a.volume, "--volume");
      const intitle = numArg(a.intitle, "--intitle");
      const kd = numArg(a.kd, "--kd");
      if (volume <= 0) die("--volume 必须大于 0");
      if (intitle < 0) die("--intitle 不能是负数（intitle 结果数没有负数这回事）");
      if (kd < 0 || kd > 100) die("--kd 必须在 0-100 之间");

      const kgr = intitle / volume;

      const kdFactor = 1 + kd / 100;
      const ekgr = (intitle * kdFactor) / volume;

      const domains = requiredDomains(kd);
      const invest = totalLinkCost(domains);
      // $0.1/次点击、日均按月搜索量/30 估，来自 /kgr/ 页面同一段公式。
      const revenue = (volume / 30) * 0.1 * 365;
      const roi = invest > 0 ? ((revenue - invest) / invest) * 100 : Infinity;

      // 历史公式只保留数值与旧字段，不参与选词与立项裁决。
      // 两路记录入口见 references/playbooks/entry.md；
      // Google 与 ChatGPT 证据分别见 references/seo-serp.md、references/seo-geo.md。
      return {
        kgr: { value: Number(kgr.toFixed(3)) },
        ekgr: { value: Number(ekgr.toFixed(3)), kdFactor: Number(kdFactor.toFixed(2)) },
        kdroi: {
          requiredDomains: domains,
          invest: Number(invest.toFixed(2)),
          yearRevenueCap: Number(revenue.toFixed(2)),
          roiPct: invest > 0 ? Number(roi.toFixed(1)) : null,
        },
      };
    },
    summarize: (d) =>
      `KGR ${d.kgr.value} · EKGR ${d.ekgr.value}（kdFactor ${d.ekgr.kdFactor}） · ` +
      `KDROI 需 ${d.kdroi.requiredDomains} 条外链/$${d.kdroi.invest}，ROI ${d.kdroi.roiPct ?? "∞"}%` +
      `（历史计算，不参与选词与立项裁决）`,
  },

  string: {
    desc: "TDK 长度检查：字符/词/字节统计 + title(30-60)/desc(70-160) 有效长度（纯本地计算）",
    help: '--text "..." 或 --file <path>（必填，正文统计的输入）；再加 --title "..." / --desc "..." 可在同一次调用里附带查 title/desc 的 TDK 长度',
    run: (a) => {
      const text = a.file ? readFileSync(a.file, "utf8") : req(a.text, "--text 或 --file");
      const CJK = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
      const countWords = (t) => {
        let words = 0, inWord = false;
        for (const c of t) {
          if (CJK.test(c)) { words++; inWord = false; continue; }
          if (/[A-Za-z0-9_'-]/.test(c)) { if (!inWord) { words++; inWord = true; } }
          else inWord = false;
        }
        return words;
      };
      // TDK 有效长度：ASCII 记 1，其余（含中日韩/全角）记 2，近似像素占宽。
      const tdkLen = (t) => [...t].reduce((n, c) => n + (c.codePointAt(0) <= 0x7f ? 1 : 2), 0);
      const tdkCheck = (t, lo, hi) => {
        const n = tdkLen(t);
        const status = n === 0 ? "empty" : n < lo ? "short" : n <= hi ? "ok" : "over";
        return { text: t, len: n, range: [lo, hi], status };
      };
      const out = {
        chars: [...text].length,
        charsNoSpace: [...text.replace(/\s/g, "")].length,
        words: countWords(text),
        lines: text ? text.split("\n").length : 0,
        bytes: Buffer.byteLength(text, "utf8"),
        uniqueChars: new Set([...text]).size,
      };
      if (a.title) out.titleTdk = tdkCheck(a.title, 30, 60);
      if (a.desc) out.descTdk = tdkCheck(a.desc, 70, 160);
      return out;
    },
    summarize: (d) => {
      const tdk = [];
      if (d.titleTdk) tdk.push(`title ${d.titleTdk.len}/60（${d.titleTdk.status}）`);
      if (d.descTdk) tdk.push(`desc ${d.descTdk.len}/160（${d.descTdk.status}）`);
      return `${d.chars} 字符 · ${d.words} 词 · ${d.bytes} 字节 · ${d.uniqueChars} 个不同字符${tdk.length ? " · " + tdk.join(" · ") : ""}`;
    },
  },

  money: {
    desc: "月收入目标拆解：UV / 关键词日搜索量；外链投入与 ROI 为历史计算，不参与选词与立项裁决（纯本地计算）",
    help: "--income <月收入$> [--sites 1] [--kws 5] [--rankpos 3] [--rpm 5] [--saas 0] [--pvuv 2] [--kd 30]",
    run: (a) => {
      const clamp = (v, lo, hi) => {
        // NaN 断言：clamp(NaN, lo, hi) 本会静默返回 NaN（Math.max/min 对 NaN 短路），
        // 之前正是这样把「参数打错了」伪装成「算出来是 0」。这里提前截断。
        if (Number.isNaN(v)) die("money 内部参数不是数字（不应该发生，说明 optNumArg 校验被绕过了）");
        return Math.min(hi, Math.max(lo, v));
      };
      const income = clamp(numArg(a.income, "--income"), 100, 100000);
      const sites = clamp(optNumArg(a.sites, "--sites", 1), 1, 20);
      const kws = clamp(optNumArg(a.kws, "--kws", 5), 1, 50);
      const rankpos = Math.round(clamp(optNumArg(a.rankpos, "--rankpos", 3), 1, 10));
      const rpm = clamp(optNumArg(a.rpm, "--rpm", 5), 1, 20);
      const saas = clamp(optNumArg(a.saas, "--saas", 0), 0, 500);
      const pvuv = clamp(optNumArg(a.pvuv, "--pvuv", 2), 1, 5);
      const kd = clamp(optNumArg(a.kd, "--kd", 30), 0, 100);
      // 行业 CTR 曲线，抄自 /money/ 页面内联 JS。
      const CTR = { 1: 39.8, 2: 18.7, 3: 10.2, 4: 7.2, 5: 5.1, 6: 4.4, 7: 3.0, 8: 2.1, 9: 1.9, 10: 1.6 };
      const ctr = CTR[rankpos] / 100;

      const daily = income / 30;
      const yearly = income * 12;
      const adPerUv = (rpm / 1000) * pvuv;
      const saasPerUv = saas / 1000;
      const perUv = adPerUv + saasPerUv;
      const totalUv = perUv > 0 ? daily / perUv : 0;
      const siteUv = totalUv / sites;
      const sitePv = siteUv * pvuv;
      const kwVol = siteUv / kws / ctr;
      const domains = requiredDomains(kd);
      const cost = sites * totalLinkCost(domains);
      const roi = cost > 0 ? yearly / cost : Infinity;

      // KD 预算与 ROI 保留历史公式及默认 KD30，不参与选词与立项裁决。
      // 两路记录入口见 references/playbooks/entry.md；
      // Google 与 ChatGPT 证据分别见 references/seo-serp.md、references/seo-geo.md。
      return {
        params: { income, sites, kws, rankpos, ctrPct: CTR[rankpos], rpm, saas, pvuv, kd },
        dailyIncome: Number(daily.toFixed(2)),
        perUvValue: Number(perUv.toFixed(4)),
        totalDailyUv: Math.round(totalUv),
        siteDailyUv: Math.round(siteUv),
        siteDailyPv: Math.round(sitePv),
        keywordDailyVolume: Math.round(kwVol),
        requiredDomainsPerSite: domains,
        totalLinkCost: Math.round(cost),
        yearlyRevenue: Math.round(yearly),
        roi: cost > 0 ? Number(roi.toFixed(2)) : null,
      };
    },
    summarize: (d) =>
      `每站需日 UV ${d.siteDailyUv}（${d.siteDailyPv} PV） · 每词日搜索量 ${d.keywordDailyVolume} · ` +
      `外链投入 $${d.totalLinkCost} · ROI ${d.roi ?? "∞"}x（历史计算，不参与选词与立项裁决）`,
  },

  email: {
    desc: "从文本批量提取邮箱地址并去重（纯本地计算）",
    help: "--text \"...\" 或 --file <path>；--mode list|comma|domain（默认 list）",
    run: (a) => {
      const text = a.file ? readFileSync(a.file, "utf8") : req(a.text, "--text 或 --file");
      const RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const matched = text.match(RE) || [];
      const seen = new Set();
      const emails = [];
      for (const m of matched) {
        const e = m.toLowerCase();
        if (!seen.has(e)) { seen.add(e); emails.push(e); }
      }
      const mode = a.mode || "list";
      // 拼错 --mode（比如打成 --mode coma）之前会静默退回 list——用户以为自己拿到的是
      // comma 格式，实际是换行分隔的默认格式，粘贴到下一步会直接出错。白名单校验一下。
      if (!["list", "comma", "domain"].includes(mode)) die(`--mode 只能是 list/comma/domain 之一（实际传入：${mode}）`);
      let output;
      if (mode === "comma") output = emails.join(", ");
      else if (mode === "domain") {
        const dseen = new Set(), domains = [];
        for (const e of emails) { const d = e.split("@")[1]; if (d && !dseen.has(d)) { dseen.add(d); domains.push(d); } }
        output = domains.join("\n");
      } else output = emails.join("\n");
      return { count: emails.length, rawCount: matched.length, emails, output };
    },
    summarize: (d) => `找到 ${d.count} 个邮箱${d.rawCount > d.count ? `（去重前 ${d.rawCount} 个）` : ""}`,
    // --mode 指定成 comma/domain 就是为了直接拿现成文本用（贴邮件列表、贴 disallow 名单），
    // 不该逼用户自己 jq -r .output 从 JSON 里挖。没给 --out 落盘时，直接把这段文本打出来。
    rawOutput: (d, a) => (a.mode && a.mode !== "list" ? d.output : null),
  },
};

const HELP = `本地公式与哥飞旧接口独有用途

用法：node seo-webcafe.mjs <命令> [选项]

旧接口命令（官方目录暂无等价能力）：
${Object.entries(TOOLS).map(([k, v]) => `  ${k}  ${v.desc}`).join("\n")}

本地命令（零网络、零配额，可批量）：
${Object.entries(LOCAL).map(([k, v]) => `  ${k}  ${v.desc}\n    ${v.help}`).join("\n")}

  tools             列出本地命令与未复刻工具
  --out <path>       写完整 JSON
  --batch <file>     每行一组 key=value 参数，行内覆盖顶层
  --spacing-ms <ms>  批量请求间隔
  --guest            显式使用旧接口访客请求；默认登录态 Chrome
  --help             本帮助

kgr 的 EKGR/kdFactor/KDROI、money 的 KD 预算/ROI 为历史计算，不参与选词与立项裁决。
默认摘要标注历史用途；--out 与默认 JSON 保留旧字段，money 仍按默认 KD30 计算。
两路记录入口：references/playbooks/entry.md；Google 证据见 references/seo-serp.md，ChatGPT 推荐见 references/seo-geo.md。
旧接口每日配额与官方 API 积分分开；本轮口径以响应为准。
已覆盖的网络能力加载官方 gefei/gefei-keywords/gefei-competitor/gefei-domain/gefei-page。`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help")) { console.log(HELP); return; }
  const { cmd, a } = parseArgs(argv);

  if (cmd === "tools") {
    console.log("已复刻成本地命令（零网络零配额）：" + Object.keys(LOCAL).map((k) => `${k}（${LOCAL[k].desc}）`).join("；"));
    console.log("确认无后端、不做的工具：" + Object.entries(NOT_DONE).map(([k, why]) => `${k}（${why}）`).join("；"));
    return;
  }
  // 本地命令走独立分支：不取令牌、不发 HTTP、不查配额档位，直接算完打印。
  // 支持 --batch，跟远端命令共用同一份批量文件格式——见 parseBatchRows。
  if (LOCAL[cmd]) {
    const local = LOCAL[cmd];
    const rows = parseBatchRows(a);
    const results = rows.map((args) => local.run(args));
    for (const data of results) console.log(`✓ ${cmd} → ${local.summarize(data)}`);
    const single = results.length === 1;
    const payload = single ? results[0] : results;
    if (a.out) {
      writeFileSync(a.out, JSON.stringify(payload, null, 2));
      console.error(`已写入 ${a.out}`);
    } else if (single && local.rawOutput) {
      const raw = local.rawOutput(results[0], rows[0]);
      if (raw != null) console.log(raw);
      else console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
    return;
  }

  const spec = TOOLS[cmd];
  if (!spec) die(`未知命令：${cmd}（用 --help 看全部命令）`);

  const rows = parseBatchRows(a);

  const spacing = Number(a.spacingMs ?? spec.spacingMs ?? 0);
  const results = [];
  let failDir = null;
  for (let i = 0; i < rows.length; i++) {
    const args = { ...a, ...rows[i] };
    const res = await callSessionAuto(spec, args);
    const label = args.keyword || args.url || args.input || cmd;
    const parseFailed = res.status === 200 && res.data && typeof res.data === "object" && res.data.error;
    if (res.status !== 200 || parseFailed) {
      const reason = parseFailed ? res.data.error : res.raw.slice(0, 120);
      console.error(`✗ ${label} → ${res.status !== 200 ? `HTTP ${res.status} ` : ""}${reason}`);
      // 失败的响应**原文**必须留下：`HTTP 500` 和「配额横幅 HTML 藏在 200 里」
      // 是完全不同的故障，只有原文分得出来。--out 会带上（results 里有 raw），
      // 没给 --out 也落 .rankup/evidence/seo-webcafe-<ts>/。
      try {
        if (!failDir) failDir = newEvidenceDir("seo-webcafe");
        const fn = `${String(i + 1).padStart(2, "0")}-${String(label).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60)}.raw.txt`;
        writeFileSync(join(failDir, fn), `HTTP ${res.status}\n\n${res.raw ?? ""}`);
        writeManifest(failDir, { script: "seo-webcafe", cmd, stopReason: "request-failures", finishedAt: new Date().toISOString() });
        console.error(`  响应原文已落盘：${join(failDir, fn)}`);
      } catch (e) {
        console.error(`  （原文落盘失败：${String(e?.message || e).slice(0, 200)}）`);
      }
      process.exitCode = 1;
    } else {
      console.log(`✓ ${label} → ${summarize(cmd, res.data)}`);
    }
    results.push({
      args: rows[i],
      status: res.status,
      data: res.data,
      ...(res.status !== 200 || parseFailed ? { raw: String(res.raw ?? "").slice(0, 20000) } : {}),
    });
    if (spacing && i < rows.length - 1) await new Promise((r) => setTimeout(r, spacing));
  }

  if (a.out) {
    const path = a.out;
    if (path.endsWith("/")) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, `${cmd}.json`), JSON.stringify(results, null, 2)); }
    else writeFileSync(path, JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    console.error(`已写入 ${path}`);
  }
}

// 导入只暴露本地公式与契约，不运行请求。
export { BASE, UA, toolAuth, TOOLS, LOCAL, parseBatchRows, summarize };

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().finally(() => {
    if (browserOpenedTools.size) execFileSync("opencli", ["browser", WEBCAFE_SESSION, "close"], { stdio: "ignore" });
  }).catch((e) => die(`执行失败：${e?.message || e}`));
}
