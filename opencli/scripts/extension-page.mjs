#!/usr/bin/env node
/**
 * 用途：绕过 OpenCLI 的 http(s) 导航白名单，用 CDP 直连打开/读取 chrome-extension:// 页面。
 *       opencli 的 isSafeNavigationUrl 与 isDebuggableUrl 都不认扩展协议（extension/src/background.ts:3447,3453），
 *       所以扩展页只能走 CDP 或改 fork，不能走 `opencli browser open` / `bind`。
 *
 * 参数：
 *   --url <url>          要打开/读取的目标页（必填），如 chrome-extension://<id>/payment.html
 *   --port <n>           已存在的 CDP 端口；不给则用 --launch 启一个（默认 9223）
 *   --launch             启动隔离 Chrome 实例（独立 --user-data-dir，不碰用户的 Chrome）
 *   --extension <dir>    --launch 时要加载的未打包扩展目录
 *   --headed             --launch 时开窗口（默认 --headless=new，不抢焦点）
 *   --eval <expr>        在页面里求值并打印结果（默认打印 title/url/innerText 摘要）
 *   --network <ms>       额外采集 Network 请求 url，等待 <ms> 毫秒
 *   --keep               结束后不关闭 Chrome（默认关掉自己启动的那个）
 *
 * 依赖：Node >= 22（内置 WebSocket 与 fetch）、本机 Chrome。
 * 已知坑：
 *   - MV3 扩展没有常驻 SW 时 /json/list 不会出现它，必须用 PUT /json/new 主动创建标签页。
 *   - chrome-extension URL 打开失败时 title 会等于 URL、body 为错误页文案，据此判加载成功与否。
 *   - --load-extension 必须配独立 --user-data-dir，否则被忽略。
 * 验证日期：2026-10-12（Chrome 154.0.8037.98，Windows）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const has = (name) => argv.includes(`--${name}`);

const targetUrl = flag('url');
if (!targetUrl) {
  console.error('usage: node extension-page.mjs --url chrome-extension://<id>/page.html [--port 9223] [--launch --extension <dir>] [--eval <expr>] [--network 3000]');
  process.exit(2);
}
const port = Number(flag('port', '9223'));
const evalExpr = flag('eval');
const networkMs = Number(flag('network', '0'));
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let userDataDir = null;
async function launch() {
  const chrome = flag('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  userDataDir = mkdtempSync(join(tmpdir(), 'extqa-'));
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    flag('extension') ? `--load-extension=${flag('extension')}` : null,
    has('headed') ? null : '--headless=new',
    'about:blank',
  ].filter(Boolean);
  child = spawn(chrome, args, { stdio: 'ignore', detached: false });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/json/version`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error(`CDP 端口 ${port} 未就绪`);
}

async function pickTarget() {
  const list = async () => (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === 'page');
  const hit = (await list()).find((t) => t.url === targetUrl || decodeURIComponent(t.url) === targetUrl);
  if (hit) return hit;
  // 新 Chrome 的 /json/new 只认 PUT
  const created = await fetch(`${base}/json/new?${encodeURI(targetUrl)}`, { method: 'PUT' });
  if (created.ok) return await created.json();
  return null;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  };
  return {
    ready,
    events,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

function cleanup() {
  if (child && !has('keep')) { try { child.kill(); } catch {} }
  if (userDataDir && !has('keep')) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}

try {
  if (has('launch')) await launch();
  const target = await pickTarget();
  if (!target?.webSocketDebuggerUrl) throw new Error('未找到页面 target（扩展是否已加载？）');

  const page = cdp(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  if (networkMs > 0) await page.send('Network.enable');

  const expression = evalExpr
    ? `(async () => { try { return JSON.stringify(await (async () => (${evalExpr}))()); } catch (e) { return JSON.stringify({ evalError: String(e) }); } })()`
    : `JSON.stringify({ title: document.title, href: location.href, failed: document.title === location.href, text: (document.body?.innerText || '').slice(0, 600) })`;

  const { result } = await page.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  console.log(result.value ?? JSON.stringify(result));

  if (networkMs > 0) {
    await sleep(networkMs);
    const reqs = page.events.filter((e) => e.method === 'Network.requestWillBeSent')
      .map((e) => e.params.request.url)
      .filter((u) => !u.startsWith('data:') && !u.startsWith('chrome-extension://'));
    console.log(JSON.stringify({ networkRequests: [...new Set(reqs)] }, null, 2));
  }
  page.close();
  cleanup();
  process.exit(0);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  cleanup();
  process.exit(1);
}