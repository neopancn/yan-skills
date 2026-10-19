// Google 地区跳转检查与 NCR 修复；依赖已登录 Chrome/OpenCLI。
// 只读页面和出口资料，NCR 会设置 Google 偏好；不改代理、不清 Cookie。
// 已验证 2026-10-09；出口检测网站与 Google 的路由可能不同。
import assert from 'node:assert/strict';
import { defaultSession, openAndEval, closeSession } from './opencli-core.mjs';
const session = defaultSession('google-region');
const summary = '(() => ({url:location.href,footer:document.querySelector("#footcnt")?.innerText}))()';
try {
  const before = await openAndEval(session, 'https://www.google.com/', summary, { wait: 1 });
  const exit = await openAndEval(session, 'https://ipinfo.io/json', '(() => {const x=JSON.parse(document.body.innerText);return {ip:x.ip,country:x.country,city:x.city,org:x.org}})()', { wait: 1 });
  await openAndEval(session, 'https://www.google.com/ncr', summary, { wait: 1 });
  const after = await openAndEval(session, 'https://www.google.com/', summary, { wait: 1 });
  const search = await openAndEval(session, 'https://www.google.com/search?q=google', summary, { wait: 1 });
  console.log(JSON.stringify({ before, exit, after, search }, null, 2));
  assert.equal(new URL(after.url).hostname, 'www.google.com', '首页仍跳转');
  assert.equal(new URL(search.url).hostname, 'www.google.com', '搜索仍跳转');
} finally {
  await closeSession(session);
}
