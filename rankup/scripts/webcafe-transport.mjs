/**
 * 用途：new.web.cafe（哥飞社区论坛）的取数传输层。一个开关切换「匿名 HTTP」和
 *       「用户已登录的真实浏览器」，把「要不要登录」这件事从每个调用点收敛到一处。
 *       不是可执行脚本，只被 webcafe-forum.mjs 之类的调用方 import。
 * 依赖：Node 22 内置 fetch；browser 传输需要 opencli + 已登录的 Chrome。
 * 已验证日期：2026-08-24
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 【为什么需要这一层：这个站不是「要登录」或「不要登录」，是同一个端点两副面孔】
 *
 * 实测 `GET /api/ask/bounty/fd0wrgx7fh`（2026-08-24）：
 *
 *   | 传输 | HTTP | 字节 | answers | content | visible | vote_count |
 *   |---|---|---|---|---|---|---|
 *   | 匿名 curl | 200 | 80,941 | 23 条**全在** | **空** | false | **0** |
 *   | 已登录浏览器 | 200 | 140,491 | 23 条 | 19,651 字 | true | 26/8/20… |
 *
 * **匿名不会 401，也不会少给条目**——它照样返回 23 条答案、342 个投资人、
 * 每条答案的作者名和 `content_len`，只是把正文换成空串、`visible` 置 false、
 * `vote_count` 归零。这是本文件存在的唯一理由：
 *
 *   **失败是静默的。** 脚本拿到 200、拿到完整数组、拿到正确条数，
 *   一切看起来都对，只有正文是空的。如果调用方不显式检查 `visible`，
 *   它会把「没登录」当成「这条答案是空的」写进结果文件。
 *
 * 所以本层做两件事：`auto` 传输先走免费的 HTTP，**发现被降级了才升级到浏览器**；
 * 以及把降级判据 (`gated`) 做成调用方必须显式提供的参数，逼它想清楚
 * 「对这个端点来说，什么叫拿到的数据不完整」。
 *
 * 【三种传输怎么选】
 *   http     纯公开 HTTP，无依赖、可并发、给别人用零门槛。**元数据够用就停在这。**
 *   browser  在用户已登录的页面上下文里 fetch，Cookie 由浏览器自动附带，
 *            **脚本全程碰不到凭据**（不用把会话 Cookie 抠出来存进环境变量）。
 *   auto     默认。先 http，`gated()` 判定被降级则自动升级到 browser。
 *            拿不到浏览器就**如实报告降级**，不假装成功。
 *
 * 【为什么 browser 走「页面内 fetch」而不是 opencli 的 adapter 或读 Cookie】
 * 这个站的会话 Cookie 是 HttpOnly，脚本读不到；要拿就得去翻浏览器的 Cookie 存储，
 * 等于把用户的登录凭据抠出来落盘。页面内 fetch 这条路，凭据从头到尾只存在于浏览器里。
 *
 * 【已知坑】
 *   - **`hasUnlocked` 不是判据，`canSeeAll` 才是。** 悬赏正文是付费解锁的
 *     （`unlock_price:100` 分），但会员账号 `hasUnlocked:false` 却 `canSeeAll:true`
 *     ——照样能看全文。拿 `hasUnlocked` 当判据会误判成「没解锁，去解锁吧」，
 *     而**解锁是要花钱的**。
 *   - 页面内 fetch 是**相对路径**，所以会话必须停在本站 origin 上，
 *     否则打到别的域名去了还照样返回 200（那个站的 404 页面）。`ensureOrigin()` 管这件事。
 *   - **必须显式带 User-Agent**：不带 UA 的请求会被挡（和 seo-webcafe.mjs 同源的坑）。
 */

import { opencliRunAsync } from "./lib-opencli.mjs";

export const BASE = "https://new.web.cafe";

/** 不带这个头会被挡。和 seo-webcafe.mjs 是同一个坑，别删。 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/**
 * 会话名就是标签页的所有权声明：两个任务挑同一个名字就共用同一个标签页，
 * 各自读回对方打开的页面——导航报成功、数据是别人的、全程不报错。
 * 所以默认值绝不能是字面常量。后缀取「真正会并发的那个单位」。
 */
export function sessionName(base = "webcafe") {
  const suffix = (
    process.env.OPENCLI_SESSION_SUFFIX ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_CODE_HOST_SESSION_ID ||
    String(process.pid)
  )
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12) || "local";
  return `${base}-${suffix}`;
}

const abs = (p) => (p.startsWith("http") ? p : BASE + p);

/* ───────────────────────────── HTTP（匿名） ───────────────────────────── */

export async function httpGet(path, { timeout = 30000, retries = 2, accept = "application/json" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(abs(path), {
        redirect: "follow",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
      });
      clearTimeout(t);
      const text = await res.text();
      if ((res.status >= 500 || res.status === 429) && i < retries) {
        lastErr = new Error(`HTTP ${res.status} ${path}`);
        await sleep(800 * (i + 1));
        continue;
      }
      return { status: res.status, text, ok: res.ok };
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── 浏览器（已登录） ─────────────────────────── */

async function opencli(args, { timeout = 120000 } = {}) {
  const { stdout } = await opencliRunAsync(args, { timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * 页面内 fetch 是相对路径，所以会话必须先停在本站 origin 上。
 * 不检查的话，会话恰好停在别的网站时，fetch("/api/...") 打到那个站，
 * **返回它的 404 页面，HTTP 仍是 200**——又是一次静默失败。
 */
export async function ensureOrigin(session) {
  try {
    const out = await opencli(["browser", session, "eval", "location.origin"], { timeout: 20000 });
    if (out.includes("new.web.cafe")) return false;
  } catch {
    /* 会话还不存在，往下开 */
  }
  // 显式 dedicated：在专用窗口开标签页，不借用用户当前窗口。
  await opencli(["browser", session, "--window", "dedicated", "open", BASE + "/"]);
  await sleep(2500);
  return true;
}

/**
 * 在已登录的页面上下文里 GET 一个同源路径。
 * eval 必须包 IIFE：本环境 eval 上下文跨调用持续，裸的声明重复执行会抛错，
 * 而且那次调用**根本没执行**。
 */
export async function browserGet(path, { session, accept = "application/json", rsc = false } = {}) {
  if (!session) throw new Error("browserGet 需要 session");
  await ensureOrigin(session);
  const url = abs(path);
  // `RSC: 1` 让 Next.js 直接回这条路由的 flight，而不是整页 HTML。
  // 实测同一条帖子：普通 GET 41,472 字节且**不含正文**，带 RSC 头 12,609 字节且**含正文**。
  // 正文是客户端二次取的，所以只发普通 GET 会拿到一个「看起来完整」的空页面。
  const headers = { accept, ...(rsc ? { RSC: "1" } : {}) };
  const expr =
    `(async()=>{const r=await fetch(${JSON.stringify(url)},{headers:${JSON.stringify(headers)},credentials:"include"});` +
    `const t=await r.text();return JSON.stringify({status:r.status,text:t});})()`;
  const out = await opencli(["browser", session, "eval", expr]);
  const trimmed = out.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) throw new Error(`浏览器返回的不是 JSON 信封：${trimmed.slice(0, 200)}`);
  let env;
  try {
    env = JSON.parse(trimmed.slice(start));
  } catch (e) {
    throw new Error(`解析浏览器信封失败（${e.message}）：${trimmed.slice(0, 200)}`);
  }
  return { status: env.status, text: env.text, ok: env.status >= 200 && env.status < 300 };
}

/**
 * 在已登录的页面上下文里 POST 一个同源路径。
 *
 * **只用于「查询式 POST」**——有些搜索接口把参数放 body 里，方法是 POST 但语义是读。
 * 本仓库对 new.web.cafe 的调用只允许 `/api/community/message/search-message`
 * 这类检索端点；**站内还有大量同前缀的 `save-*` / `update-*` / `payment/*` 写端点，
 * 绝不能走这个函数**（那会动用户的真实账号和余额）。
 * 调用方必须自己确认路径在白名单里，见 webcafe-forum.mjs 的 READ_ONLY_POST。
 */
export async function browserPost(path, body, { session } = {}) {
  if (!session) throw new Error("browserPost 需要 session");
  await ensureOrigin(session);
  const url = abs(path);
  const expr =
    `(async()=>{const r=await fetch(${JSON.stringify(url)},{method:"POST",` +
    `headers:{"content-type":"application/json",accept:"application/json"},` +
    `credentials:"include",body:${JSON.stringify(JSON.stringify(body))}});` +
    `const t=await r.text();return JSON.stringify({status:r.status,text:t});})()`;
  const out = await opencli(["browser", session, "eval", expr]);
  const trimmed = out.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) throw new Error(`浏览器返回的不是 JSON 信封：${trimmed.slice(0, 200)}`);
  const env = JSON.parse(trimmed.slice(start));
  return { status: env.status, text: env.text, ok: env.status >= 200 && env.status < 300 };
}

/* ──────────────────────────────── auto ──────────────────────────────── */

/**
 * 取一个 JSON 端点。
 *
 * @param {string} path      `/api/...` 或完整 URL
 * @param {object} opts
 * @param {'auto'|'http'|'browser'} opts.transport
 * @param {string}  opts.session   browser/auto 升级时用的会话名
 * @param {(json:any)=>boolean} opts.gated
 *        **判定「这份数据被匿名降级了」的谓词，调用方必须自己给。**
 *        它不是「有没有报错」，而是「字段在不在、正文空不空」——
 *        因为这个站降级时照样返回 200 和完整数组。
 * @returns {{json:any, transport:'http'|'browser', degraded:boolean, status:number}}
 *        `degraded:true` 表示**确实没拿全**（想升级但没有浏览器 / 升级后依然被挡）。
 *        调用方必须把它透传给用户，不许当成成功。
 */
export async function getJson(path, { transport = "auto", session, gated } = {}) {
  const parse = (r, via) => {
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      throw new Error(
        `${via} 返回的不是 JSON（HTTP ${r.status}）：${String(r.text).slice(0, 200)}`,
      );
    }
    return json;
  };

  if (transport === "browser") {
    const r = await browserGet(path, { session });
    const json = parse(r, "浏览器");
    return { json, transport: "browser", degraded: gated ? gated(json) : false, status: r.status };
  }

  const r = await httpGet(path);
  const json = parse(r, "匿名 HTTP");
  const isGated = gated ? gated(json) : false;

  if (transport === "http") {
    return { json, transport: "http", degraded: isGated, status: r.status };
  }

  // auto：只有确认被降级了才去开浏览器。没被降级就不动用户的 Chrome。
  if (!isGated) return { json, transport: "http", degraded: false, status: r.status };

  try {
    const br = await browserGet(path, { session: session || sessionName() });
    const bjson = parse(br, "浏览器");
    return {
      json: bjson,
      transport: "browser",
      degraded: gated ? gated(bjson) : false,
      status: br.status,
    };
  } catch (e) {
    // 升级失败要如实报告，不能把降级过的数据当完整数据返回。
    return {
      json,
      transport: "http",
      degraded: true,
      status: r.status,
      upgradeError: e.message,
    };
  }
}

/**
 * 取 HTML（SSR 页面用）。经验/话题这类页面没有内容 API，只能从 HTML 里抠。
 *
 * **这里没有 auto 档，是故意的。** SSR 的降级特征（`markdown` 被抹成空串）藏在
 * RSC payload 里，本层只拿得到 HTML 字符串，判不出来。传 `"auto"` 会走 http 分支，
 * 返回值里的 `transport` 会如实写 `"http"`——调用方靠这个字段决定要不要升级。
 * 升级判据在 webcafe-forum.mjs 的 `fetchProps(path, ctx, gated)`。
 */
export async function getHtml(path, { transport = "http", session, rsc = false, via } = {}) {
  if (transport === "browser" && via === "nav") return navGet(path, { session });
  if (transport === "browser") {
    const r = await browserGet(path, { session, accept: "text/html", rsc });
    return { html: r.text, transport: "browser", status: r.status };
  }
  const r = await httpGet(path, { accept: "text/html" });
  return { html: r.text, transport: "http", status: r.status };
}

/**
 * **真实导航取数**：让浏览器像人一样打开这个 URL，等页面自己渲染，再从活着的页面里
 * 把 flight 读出来。
 *
 * 和 `browserGet` 的区别不是「快慢」，是**走不走同一条路**：
 *   browserGet  在某个已打开页面的上下文里发 `fetch()`——借的是 cookie，
 *               但请求头是 `Sec-Fetch-Mode: cors`，站点完全可以区别对待。
 *   navGet      真的导航过去，`Sec-Fetch-Mode: navigate`，和用户手点没有区别。
 *
 * 实测依据：同一时刻、同一个会话，导航打开帖子页时 DOM 里有全文，
 * 而在首页上下文里 `fetch()` 同一个 URL 拿回来的是登录页。**是路径的差别，不是登录的差别。**
 *
 * 代价是慢——每条要真的加载一个页面（含 JS、字体、若干个 API 调用），
 * 2~4 秒对 1.3 秒。稳定性换速度，在这个站上是划算的。
 */
export async function navGet(path, { session, settleMs = 2500 } = {}) {
  if (!session) throw new Error("navGet 需要 session");
  await opencli(["browser", session, "--window", "dedicated", "open", abs(path)]);
  await sleep(settleMs);
  // 从活着的页面里取 flight。这里不能读 document.body.innerText——那样会丢掉
  // markdown 的原始格式（代码块、链接、层级），而我们要的正是原文。
  const expr =
    `(()=>{const f=(self.__next_f||[]).map(x=>Array.isArray(x)?x[1]:null)` +
    `.filter(t=>typeof t==="string").join("");` +
    `return JSON.stringify({url:location.href,flight:f});})()`;
  const out = await opencli(["browser", session, "eval", expr]);
  const i = out.indexOf("{");
  if (i === -1) throw new Error(`导航后读不到 flight：${out.slice(0, 160)}`);
  const env = JSON.parse(out.slice(i));
  return { html: env.flight, url: env.url, status: 200, transport: "nav" };
}

/** 会话用完必须还回去；崩溃时不会自动清理。**绝不要用 cleanup**（那会关掉别人的标签页）。 */
export async function closeSession(session) {
  try {
    await opencli(["browser", session, "close"], { timeout: 20000 });
  } catch {
    /* 本来就没开就算了 */
  }
}

/**
 * **自动重新登录**（谷歌一键，不跳谷歌授权页）。
 *
 * 这个站会把长时间取数的会话踢下线——实测第一轮撑约 100 条，重登后只剩约 20 条。
 * 所以「重新登录」不是异常处理，是**正常取数循环里的一步**，必须能无人值守完成。
 *
 * 两步，都有各自的坑：
 *   1. 右上角「登 录」——DOM 里的文字是 `登 录`（中间有空格），按 `登录` 找不到；
 *      而且它没有 id，只能靠 class 前缀定位。
 *   2. 弹窗里的「使用 Google 登录」——**不能用 JS 的 `.click()`**，实测点了没反应
 *      （headlessui 的按钮要真实指针事件）。做法是先给它打一个属性标记，
 *      再用 opencli 的 click 按属性选中——这样既拿到了真实点击，又不用猜 class。
 *
 * 账号已在浏览器里登录过谷歌时，这一步**不会跳转到谷歌授权页**，直接就回来了。
 * 本函数只点按钮，**从不接触任何凭据**。
 */
export async function ensureLoggedIn(session, { timeout = 20000 } = {}) {
  if ((await whoami(session))?.user) return { relogged: false };

  // **登录要在自己的标签页里做，不能借用取数那个。** 窗口模式是**建标签页时定死的**，
  // 对一个已经是 background 的标签页再传 --window isolated 不会把它挪出去，
  // 于是它继续被节流、继续点不开弹窗。Cookie 是整个浏览器配置共享的，
  // 所以在这里登录，取数那个标签页立刻也是登录态。
  const loginSession = `${session}-login`;

  // **登录这一步必须用 isolated，不能用 background。** 对照实验（同样等 30 秒再点）：
  //     background → 弹窗打不开        isolated → 一次就开
  // 后台标签页被浏览器节流，水合根本没跑完，点击落在一个还没挂上处理函数的按钮上。
  // isolated 开在独立窗口里，不抢用户正在看的标签页，又不受节流——两头都要的那个选项。
  // 取数使用 dedicated 专用窗口；登录保留已实测的 isolated 独立窗口。
  await opencli(["browser", loginSession, "--window", "isolated", "open", BASE + "/"]);
  // **还要等够水合。** 实测 3 秒和 9 秒都不行、30 秒一次就中：页面还在水合时，
  // 「登 录」按钮已经在 DOM 里但处理函数还没挂上，这时候的点击**返回成功、毫无效果**。
  // 这类失败最难查——点击报 hit、按钮也确实存在，只是什么都没发生。
  await sleep(Number(process.env.WEBCAFE_HYDRATE_MS || 30000));

  // 打标记而不是猜 class：弹窗里的按钮和顶部「登 录」用的是同一串 class，
  // 靠 class 选会选中错的那个。
  const tag =
    `(()=>{const b=[...document.querySelectorAll("button")]` +
    `.find(e=>(e.innerText||"").replace(/\\s+/g," ").trim()==="使用 Google 登录");` +
    `if(!b)return "no";b.setAttribute("data-cc-login","1");return "ok";})()`;

  // **弹窗不是必然一点就开。** 页面刚导航完可能还在水合，这时候的点击落空且不报错，
  // 于是下一步「找不到 Google 按钮」，看起来像是页面结构变了——实际上只是点早了。
  // 所以要重试，并且每次都重新确认弹窗真的开了。
  // 先看弹窗是不是已经开着（上一次尝试可能已经把它点开了）。
  // 不先看就直接点，会在弹窗已开时点到弹窗里的按钮上，选择器歧义导致 click 直接报错。
  let tagged = await opencli(["browser", loginSession, "eval", tag]);
  for (let attempt = 1; attempt <= 3 && !tagged.includes("ok"); attempt++) {
    try {
      await opencli(["browser", loginSession, "click", "button.inline-flex.w-full.justify-center"]);
    } catch (e) {
      // 点击本身失败（选择器没匹配上/匹配到多个）不该终止整轮——下一次循环会重新判断。
      console.error(`  （第 ${attempt} 次点「登 录」失败：${String(e.message).split("\n")[0].slice(0, 80)}）`);
    }
    await sleep(3000 * attempt);
    tagged = await opencli(["browser", loginSession, "eval", tag]);
  }
  if (!tagged.includes("ok")) throw new Error("点了三次「登 录」，弹窗里始终没有「使用 Google 登录」按钮");

  await opencli(["browser", loginSession, "click", "[data-cc-login]"]);

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(2000);
    // 探的是**取数那个会话**——登录标签页自己成功不算数，要的是取数那边也认。
    if ((await whoami(session))?.user) {
      await closeSession(loginSession);   // 登录标签页用完就还回去，别留在用户的浏览器里
      return { relogged: true };
    }
  }
  await closeSession(loginSession);
  throw new Error("点了谷歌登录但取数会话仍未拿到登录态");
}

/** 探针：脚本当前在浏览器里是不是登录态。 */
export async function whoami(session) {
  const r = await browserGet("/api/auth/session", { session });
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}
