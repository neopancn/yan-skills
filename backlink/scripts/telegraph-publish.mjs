#!/usr/bin/env node
// telegra.ph 即时发布：createAccount + createPage（POST），无账号无邮箱无 CAPTCHA，无需浏览器
// 用法:
//   node telegraph-publish.mjs --title "..." --file content.json [--author "Name"] [--author-url "https://..."] [--out result.json] [--short-name xxx]
// 内容格式: JSON 数组，Telegraph Node 对象，如
//   [{"tag":"p","children":["文字 ",{"tag":"a","attrs":{"href":"https://…"},"children":["锚文本"]}]}]
//   允许 tag: a aside b blockquote br code em figcaption figure h3 h4 hr i iframe img li ol p pre s strong u ul video
// 要点:
//   - createPage 必须 POST（GET + 长 content 会拿到 HTML 错误页，报 Unexpected token '<'）
//   - access_token 是凭据：只写进 --out 文件，绝不打印到 stdout/日志
//   - byline 的 author_url 是页面上唯一的 dofollow 位（正文锚全是 nofollow，2026-08 注册表实测）
//   - graph.org 是同源镜像，主域不通时把 API 域名换掉即可
// 输出: {url, path, title, authorUrl, publishedAt}
// 实测: 2026-10-17（PSD 教程页发布成功并回读验证）
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const title = get('--title');
const file = get('--file');
if (!title || !file) { console.error('缺 --title 或 --file'); process.exit(1); }
const author = get('--author', 'PhotoCraft');
const authorUrl = get('--author-url', '');
const out = get('--out');
const shortName = get('--short-name', `pc${Date.now().toString(36)}`);
const API = get('--api', 'https://api.telegra.ph');

const post = async (path, params) => {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { throw new Error(`HTTP ${r.status} 非 JSON: ${t.slice(0, 200)}`); }
  if (!j.ok) throw new Error(`API error: ${t.slice(0, 300)}`);
  return j.result;
};

const content = readFileSync(file, 'utf8');
// 必须重新序列化成紧凑 JSON 再发：telegra.ph 的 POST 解析器会拒收 pretty-printed
// 文本（含缩进空白即报 CONTENT_FORMAT_INVALID，2026-10-17 三组对照实测），
// 与 author 字段、return_content 无关。
const normalized = JSON.stringify(JSON.parse(content));

const acc = await post('/createAccount', {
  short_name: shortName, author_name: author, ...(authorUrl ? { author_url: authorUrl } : {}),
});
const page = await post('/createPage', {
  access_token: acc.access_token,
  title,
  author_name: author,
  ...(authorUrl ? { author_url: authorUrl } : {}),
  content: normalized,
  // 注意: 绝不传 return_content——字符串 "false" 会被服务端当 true 处理并报
  // CONTENT_FORMAT_INVALID（2026-10-17 二分实测），省略即默认 false。
});
const result = { url: page.url, path: page.path, title, authorUrl, publishedAt: new Date().toISOString() };
console.log(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result));
