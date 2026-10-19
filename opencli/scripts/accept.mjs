#!/usr/bin/env node
/**
 * 可复跑的 Chrome 响应式验收；无需登录。验证日期：2026-10-10。
 * node accept.mjs --url http://localhost:3000/ --url /pricing --widths 1440,390 --height 900 --out /tmp/accept
 * --session 覆盖唯一会话名；--forbid-external 只检测并记录（发现即失败），不阻断。
 * OPENCLI_ACCEPT_CLI=/path/to/dist/src/main.js 可选择独立构建；默认调用已安装 opencli。
 * shortcut: 旧扩展能力探测失败时回退同源 iframe，新扩展使用持续顶层 viewport。
 * iframe 不能覆盖顶层导航、设备/触摸、frame-ancestors/CSP 禁止嵌入的页面；超时会失败。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultSession, validateSession, run } from './opencli-core.mjs';

const summary = { passed: 0, failed: 0, artifacts: [], consoleCaptureSupported: false, consoleErrors: [], viewportSupported: false, viewportFallbacks: [], failures: [] };
let session;
let opened = false;
let consoleChecks = 0;
const cliPath = process.env.OPENCLI_ACCEPT_CLI;
async function browser(...args) {
  const argv = ['browser', session, '--window', 'dedicated', ...args];
  const result = await run(cliPath ? process.execPath : 'opencli', cliPath ? [cliPath, ...argv] : argv,
    { timeoutMs: 60_000, env: { NODE_USE_ENV_PROXY: '1' } });
  return result.stdout;
}
async function evaluate(js) {
  return JSON.parse(await browser('eval', js));
}

// 一次异步 eval 内轮询 URL 和可见性；超时抛错，不能以空结果继续。
async function waitForPage(url, selector = 'body', framed = false, timeoutMs = 15_000) {
  return evaluate(`(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      const w = ${framed ? "document.querySelector('#opencli-accept-frame')?.contentWindow" : 'window'};
      const d = w?.document;
      const el = d?.querySelector(${JSON.stringify(selector)});
      const visible = el && el.getClientRects().length > 0 && w.getComputedStyle(el).visibility !== 'hidden';
      if (w?.location.href === ${JSON.stringify(url)} && visible && d.readyState === 'complete'
          && d.fonts.status === 'loaded' && [...d.images].every(img => img.complete)) {
        await d.fonts.ready;
        return { ready: true, url: w.location.href };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for URL/visibility/fonts/images: ' + ${JSON.stringify(url)});
  })()`);
}
function fail(point, error) {
  summary.failed++;
  summary.failures.push({ point, message: error.message });
}
try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', multiple: true }, widths: { type: 'string', default: '1440,390' },
    height: { type: 'string', default: '900' }, out: { type: 'string', default: '/tmp/opencli-accept' },
    session: { type: 'string' }, 'forbid-external': { type: 'boolean', default: false },
  } });
  assert(values.url?.length, 'At least one --url is required');
  const urls = values.url.map(url => new URL(url, values.url[0]).href);
  assert(urls.every(url => /^https?:/.test(url)), '--url must use HTTP(S)');
  const widths = values.widths.split(',').map(Number);
  const height = Number(values.height);
  assert(widths.length && [...widths, height].every(n => Number.isSafeInteger(n) && n > 0), 'Dimensions must be positive integers');
  session = validateSession(values.session || defaultSession(`accept-${randomBytes(4).toString('hex')}`));
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  for (const [index, url] of urls.entries()) {
    for (const width of widths) {
      const point = `${url} @ ${width}x${height}`;
      const stem = join(out, `page-${index + 1}-${width}`);
      try {
        opened = true;
        let persistent = false;
        try {
          const capability = JSON.parse(await browser('viewport', 'set', String(width), String(height)));
          assert(capability.supported === true, 'Extension did not acknowledge persistent viewport');
          persistent = true;
          summary.viewportSupported = true;
        } catch (error) {
          summary.viewportFallbacks.push({ point, reason: error.message });
          // If set partially succeeded, do not leave stale metrics around the fallback.
          try { await browser('viewport', 'reset'); } catch { /* old CLI/extension */ }
        }
        // Read capture before target navigation, so a late attach cannot look like a clean page.
        let preCapture = { captureSupported: false, startedAt: null };
        if (persistent) {
          await browser('open', 'about:blank');
          preCapture = JSON.parse(await browser('console', '--level', 'error'));
        } else {
          try { preCapture = JSON.parse(await browser('console', '--level', 'error')); }
          catch { /* legacy session may not exist until HTTP open */ }
        }
        const captureFrom = Date.now();
        await browser('open', url);
        await waitForPage(url);
        if (persistent) {
          const dimensions = await evaluate('({width:innerWidth,height:innerHeight})');
          assert.equal(dimensions.width, width, 'Persistent viewport width was not applied');
          assert.equal(dimensions.height, height, 'Persistent viewport height was not applied');
        }
        if (!persistent) await evaluate(`(() => {
          document.documentElement.style.cssText = 'margin:0;padding:0;border:0';
          document.body.style.cssText = 'margin:0;padding:0;border:0';
          const frame = document.createElement('iframe');
          frame.id = 'opencli-accept-frame';
          frame.style.cssText = 'display:block;border:0;width:${width}px;height:${height}px';
          frame.src = ${JSON.stringify(url)};
          document.body.replaceChildren(frame);
          return { created: true };
        })()`);
        if (!persistent) await waitForPage(url, 'body', true);
        const shot = `${stem}.png`;
        await browser('screenshot', shot, '--width', String(width), '--height', String(height));
        summary.artifacts.push(shot);
        const evidence = await evaluate(`(() => {
          const w = ${persistent ? 'window' : "document.querySelector('#opencli-accept-frame').contentWindow"};
          const d = w.document;
          const externalRequests = [...new Set(w.performance.getEntriesByType('resource')
            .map(entry => entry.name).filter(url => /^https?:/.test(url) && new URL(url).origin !== w.location.origin))];
          return { url: w.location.href, viewportSource: ${JSON.stringify(persistent ? 'persistent-viewport' : 'same-origin-iframe')}, innerWidth: w.innerWidth,
            scrollWidth: Math.max(d.documentElement.scrollWidth, d.body.scrollWidth), externalRequests };
        })()`);
        const capture = JSON.parse(await browser('console', '--level', 'error'));
        evidence.consoleCaptureSupported = capture.captureSupported === true && preCapture.captureSupported === true && !!capture.startedAt
          && capture.startedAt === preCapture.startedAt && new Date(capture.startedAt).getTime() <= captureFrom;
        summary.consoleCaptureSupported = consoleChecks++ === 0 ? evidence.consoleCaptureSupported
          : summary.consoleCaptureSupported && evidence.consoleCaptureSupported;
        evidence.consoleStartedAt = capture.startedAt ?? null;
        evidence.consoleErrors = evidence.consoleCaptureSupported
          ? capture.messages.filter(message => new Date(message.timestamp).getTime() >= captureFrom) : [];
        summary.consoleErrors.push(...evidence.consoleErrors.map(message => ({ point, ...message })));
        evidence.externalDetection = 'resource-timing; completed resources only; no blocking';
        const artifact = `${stem}.json`;
        await writeFile(artifact, JSON.stringify(evidence, null, 2) + '\n');
        summary.artifacts.push(artifact);
        assert.equal(evidence.consoleErrors.length, 0, `Captured console errors: ${evidence.consoleErrors.map(message => message.text).join('; ')}`);
        assert.equal(evidence.innerWidth, width, `innerWidth ${evidence.innerWidth} does not match ${width}`);
        assert(evidence.scrollWidth <= evidence.innerWidth,
          `scrollWidth ${evidence.scrollWidth} exceeds innerWidth ${evidence.innerWidth}`);
        assert(!values['forbid-external'] || evidence.externalRequests.length === 0,
          `External requests detected (not blocked): ${evidence.externalRequests.join(', ')}`);
        summary.passed++;
      } catch (error) { fail(point, error); }
    }
  }
} catch (error) { fail('setup', error); }
finally {
  if (opened) {
    try { await browser('close'); }
    catch (error) { fail('close session', error); }
  }
}
console.log(JSON.stringify(summary));
process.exitCode = summary.failed ? 1 : 0;
