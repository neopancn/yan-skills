/**
 * lib-similarweb-pro.mjs —— 直连**官方** pro.similarweb.com（用户自己的 Pro 账号）。
 *
 * 为什么不是哥飞的共享面板：Similarweb 侧原先走 `sim.3ue.co`（Tools Share 代理，
 * 见 lib-tools-share.mjs），那条通道的登录态已失效（2026-10-13 实测：两个 profile
 * 下都报 `Tools Share is not logged in`）。用户持有官方 Pro 账号，且官方站上能直接
 * 命中**同源 JSON API**——不渲染、不解析 `.swReactTable-column` 虚拟表格、不受面板
 * 档位与共享配额影响，字段还更多（difficulty=KD、latestZeroClicks、leadingSite、
 * volumeTrend 都是 DOM 表里没有或读不到的）。**Similarweb 取数一律走这里，不再经面板。**
 *
 * 三条实测纪律（2026-09-24 首记于 gefei-similarweb-research、2026-09-28/10-13 复测）：
 *   1. **同源 fetch 必须带 SPA 全套自定义头**（`X-Sw-Page` / `X-Sw-Page-View-Id` /
 *      `X-Requested-With`），缺头 = CloudFront WAF 直接 403 **并返回 HTML**；
 *   2. **登录态在独立的 opencli profile 里**（默认 `msht4gxm`），必须显式 `--profile`
 *      钉住，别依赖全局默认档——默认档被切走时症状是「页面空了 / 403」，不是报错；
 *   3. **失败要能一眼分清真因**：HTTP != 200 与「返回体是 HTML 而不是 JSON」是两种
 *      完全不同的故障（前者是接口/套餐，后者是登录态或 WAF），所以错误消息里
 *      把 HTTP 码、实际落点、profile 名都写出来，别让人对着「取到 0 条」去猜。
 *
 * 本模块只做「落到官方站 + 在页面上下文里发一个同源请求」这两件事。取哪些端点、
 * 参数怎么拼、返回怎么解释，是各自脚本的事（见 similarweb-keywords.mjs、
 * similarweb-batch.mjs）——**不在这里堆端点清单**，免得变成第二份会过期的地图。
 */
import { openAndEval, opencli } from './opencli-core.mjs';

export const SIMILARWEB_PRO_ORIGIN = 'https://pro.similarweb.com';

/**
 * 落地页。**只提供「一个已登录的 pro.similarweb.com 页面上下文」**——同源 fetch
 * 必须从这里发出去，深链到哪个报道路由无所谓（实测 /activation/home 与
 * 关键词页上发同一组请求结果一致）。选「网站分析首页」是因为它是账号可用时
 * 一定会渲染出来的那一页；路由漂移时它比深层报道路由更稳。
 */
export const SIMILARWEB_PRO_HOME = `${SIMILARWEB_PRO_ORIGIN}/#/digitalsuite/websiteanalysis/home`;

/** 持有 SimilarWeb Pro 登录态的 Browser Bridge profile（`opencli profile list`）。 */
export const DEFAULT_SIMILARWEB_PRO_PROFILE = 'msht4gxm';

/**
 * 解析这次要用的 profile：`--profile` > 环境变量 > 默认档。
 * 脚本把它原样交给 opencli-core 的 `profileArgs`。
 */
export function resolveSimilarwebProProfile(flags = {}) {
  const raw = flags.profile || process.env.SIMILARWEB_PRO_PROFILE || DEFAULT_SIMILARWEB_PRO_PROFILE;
  return String(raw).trim();
}

/** 页面里跑的那套 SPA 头。任何同源 fetch 都要带上，否则一律 403。 */
export const SW_PRO_HEADERS_JS = '{"Accept":"application/json","Content-Type":"application/json; charset=utf-8","X-Sw-Page":location.href,"X-Sw-Page-View-Id":crypto.randomUUID(),"X-Requested-With":"XMLHttpRequest"}';

/**
 * 生成「在页面里发一个同源请求并把 status + 原始 body 带回来」的 JS。
 *
 * 为什么把 status 和**原始文本**一起带回来、不在页面里 JSON.parse：登录态失效和
 * WAF 拦截时返回的是 HTML，页面里 `r.json()` 会抛一个没有上下文的 SyntaxError，
 * 看起来像 CLI 坏了。带回原文，Node 侧才能给出「返回的是 HTML，说明没登录/被拦」
 * 这种能直接照着修的错误。
 */
export function swProFetchJs(url, { method = 'GET', body = null } = {}) {
  const init = [`method: ${JSON.stringify(method)}`, 'headers: H', 'credentials: "include"'];
  if (body !== null) init.push(`body: ${JSON.stringify(body)}`);
  return `(async () => {
  const H = ${SW_PRO_HEADERS_JS};
  const r = await fetch(${JSON.stringify(url)}, {${init.join(', ')}});
  const t = await r.text();
  return JSON.stringify({ status: r.status, body: t });
})()`;
}

/**
 * 归一化两条通道的返回值。**这两条通道的形状不一样**，混在一起是本模块最容易
 * 踩的坑：
 *   - `openAndEval`（走 batch）返回的是求值结果**本身**（裸值，或 batch 的 `{result}`）；
 *   - `opencli(['browser', … 'eval', js])`（直发）返回的是 CLI 进程信封 `{code, stdout, stderr}`。
 * 只认前者会出现「第一次落地（batch）能过、之后每次请求（直发）全挂」这种半截故障。
 */
function unwrap(raw) {
  let value = raw;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.stdout === 'string' && !('result' in value)) value = value.stdout; // 直发：{code, stdout}
    else if ('result' in value) value = value.result; // batch 信封
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try { return JSON.parse(text); } catch { return value; }
    }
  }
  return value;
}

function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch { return null; }
}

/**
 * 打开官方 Pro 页面并就地跑一段 JS，返回它的值。
 *
 * **落地断言在这里，不在调用方**：profile 用错或登录态失效时 opencli 不会报错，
 * 页面会安静地落在登录页/别的域名上，然后每一个 API 调用都返回 HTML——一路
 * 表现为「这个词没数据」。所以在拿到页面上下文的第一刻就把落点核一次。
 */
export async function openSimilarwebPro(session, js, options = {}) {
  const profile = options.profile;
  const probe = '(() => JSON.stringify({ href: location.href, title: document.title }))()';
  const landed = unwrap(await openAndEval(session, SIMILARWEB_PRO_HOME, probe, { ...options, wait: options.wait ?? 8 }));
  const host = hostOf(landed?.href);
  if (!host || !(host === 'pro.similarweb.com' || host.endsWith('.similarweb.com'))) {
    throw new Error(
      `Similarweb Pro 没有落在官方站上（实际落点 ${landed?.href ?? '未知'}）。`
      + `检查这个 profile 的登录态：opencli --profile ${profile ?? '<默认档>'} profile list / doctor。`,
    );
  }
  if (!js) return landed;
  return unwrap(await proEval(session, js, options));
}

/** 复用已打开的 Pro 页面上下文跑一段 JS（不重新导航）。 */
export async function proEval(session, js, options = {}) {
  return unwrap(await opencli(['browser', session, 'eval', js], options));
}

/**
 * 发一个同源请求并解释响应。返回解析好的 JSON。
 * 三种失败各给一条能照着修的消息，见文件头第 3 条纪律。
 */
export async function swProRequest(session, url, { method = 'GET', body = null, profile, what = 'SimilarWeb Pro', ...options } = {}) {
  const raw = await proEval(session, swProFetchJs(url, { method, body }), { ...options, profile });
  const envelope = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!envelope || typeof envelope.status !== 'number') {
    throw new Error(`${what}：eval 没有带回 {status, body}（拿到 ${JSON.stringify(raw).slice(0, 200)}）。`);
  }
  const text = String(envelope.body ?? '');
  if (envelope.status !== 200) {
    throw new Error(`${what} 返回 HTTP ${envelope.status}：${text.slice(0, 200)}`);
  }
  if (text.trimStart().startsWith('<')) {
    throw new Error(
      `${what} 返回的是 HTML 而不是 JSON——登录态失效或被 WAF 拦了。`
      + `先确认 profile（--profile ${profile ?? '<默认档>'}）还登着 pro.similarweb.com。`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} 返回的 body 不是合法 JSON：${text.slice(0, 200)}`);
  }
}
