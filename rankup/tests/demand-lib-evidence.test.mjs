// demand/_lib.mjs 的失败留现场契约（2026-08-30 重构第一波）：
//
//   1. get 系列失败要把 {url,status,headers,body} 落进证据目录，异常里带落点路径；
//   2. 每次运行落 manifest.json，argv 剥敏，sources 逐源记 {source,status,rawCount,error}；
//   3. 「0 条 + 源失败」和「0 条 + 源成功」的输出必须长得不一样；
//   4. die() 先落 manifest（stopReason=died: …）再退出。
//
// 这些保证「配额 429/CAPTCHA/改版/超时」与「真的没有数据」在产出里可分辨——
// 契约破了，AI 就会把采集故障读成市场结论。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libPath = path.join(here, '../scripts/demand/_lib.mjs');
const lib = await import(pathToFileURL(libPath).href);

test('manifest 落盘：argv 剥敏、sources 逐源、stopReason', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demand-lib-ev-'));
  lib.initEvidence('unit-test', { dir, argv: ['--query', 'x', '--token', 'sk_live_abc', '--api-key=hunter2'] });
  lib.recordSource({ source: 'a', status: 'http_429', rawCount: 0, error: 'HTTP 429' });
  lib.recordSource({ source: 'b', status: 'ok', rawCount: 3 });
  const file = lib.writeManifest('completed');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(m.script, 'unit-test');
  assert.deepEqual(m.argv, ['--query', 'x', '--token', '<redacted>', '--api-key=<redacted>']);
  assert.equal(m.sources.length, 2);
  assert.equal(m.sources[0].status, 'http_429');
  assert.equal(m.stopReason, 'completed');
  const s = lib.sourceStatusSummary();
  assert.equal(s.failed, 1);
  assert.equal(s.ok, 1);
  assert.ok(s.lines.some((l) => l.includes('http_429')));
});

test('getJson 失败：{url,status,body} 进证据目录，异常带落点路径', async () => {
  const server = http.createServer((_, res) => {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' });
    res.end('quota exhausted');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/x`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demand-lib-ev-'));
  lib.initEvidence('unit-test-fetch', { dir, argv: [] });
  try {
    await assert.rejects(
      () => lib.getJson(url, { retries: 0 }),
      (e) => e.message.includes('HTTP 429') && e.message.includes('现场已留'),
    );
  } finally {
    server.close();
  }
  const dump = readdirSync(dir).find((f) => f.startsWith('fetch-') && f.includes('429'));
  assert.ok(dump, `证据目录里没有 429 现场文件：${readdirSync(dir).join(', ')}`);
  const body = JSON.parse(readFileSync(path.join(dir, dump), 'utf8'));
  assert.equal(body.url, url);
  assert.equal(body.status, 429);
  assert.equal(body.body, 'quota exhausted');
  assert.equal(body.headers['retry-after'], '60');
});

test('空结果输出：源失败与源成功长得不一样；die() 先落 manifest 再退出', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demand-lib-ev-'));
  const code = `
    import { initEvidence, recordSource, printTable, die } from ${JSON.stringify(pathToFileURL(libPath).href)};
    initEvidence('unit-test-die', { dir: ${JSON.stringify(dir)}, argv: [] });
    recordSource({ source: 'a', status: 'http_429', rawCount: 0, error: 'HTTP 429' });
    printTable([], [{ key: 'x', label: 'x' }]);
    die('桥没连上');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  // 空表输出必须点名失败，而不是一句裸的 (无结果)。
  assert.ok(r.stdout.includes('采集失败'), `空表输出没有报源失败：${r.stdout}`);
  assert.ok(!/^\(无结果\)$/m.test(r.stdout.trim()));
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(m.stopReason.startsWith('died: 桥没连上'), m.stopReason);
  assert.ok(r.stderr.includes('现场已留'));
});

// ── 2026-08-30 重构第二波：浏览器失败现场的双证人 captureBrowserScene ──────────
// 契约：页面文本（DOM 证人）+ 截图（视觉证人）成对落进证据目录；
// 任何一步取证失败都不抛——取证失败不许掩盖原始错误。
// 这里用假 opencli 验证调用形态与落盘；真 Chrome 上的截图链路已实盘验证。

import { mkdtempSync as mkdtemp2, writeFileSync, chmodSync, existsSync } from 'node:fs';

function fakeOpencli(dir, body) {
  const bin = path.join(dir, 'fake-opencli');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

// 假 opencli 是 /bin/sh 脚本，Windows 无法直接 spawn 无扩展名 shebang 文件；
// 这条契约由 Unix CI 覆盖，win32 上跳过而不是伪造通过。
const shShimSkip = process.platform === 'win32' && '/bin/sh 夹具无法在 win32 直接 spawn';

test('captureBrowserScene：文本与截图成对落进证据目录', { skip: shShimSkip }, () => {
  const dir = mkdtemp2(path.join(os.tmpdir(), 'demand-lib-scene-'));
  const binDir = mkdtemp2(path.join(os.tmpdir(), 'demand-lib-bin-'));
  const bin = fakeOpencli(binDir, [
    'for last; do :; done',
    'case "$*" in',
    '  *" eval "*) echo \'{"url":"https://example.test/x","title":"T","readyState":"complete","text":"hello page"}\';;',
    '  *" screenshot "*) printf PNG > "$last";;',
    'esac',
  ].join('\n'));
  lib.initEvidence('unit-test-scene', { dir, argv: [] });
  const out = lib.captureBrowserScene('sess-x', 'tag one/兩', { bin });
  assert.ok(out.text, '文本证人应当落盘');
  assert.ok(out.text.startsWith(dir), `文本证人应在证据目录里：${out.text}`);
  const page = JSON.parse(readFileSync(out.text, 'utf8'));
  assert.equal(page.url, 'https://example.test/x');
  assert.equal(page.text, 'hello page');
  assert.ok(out.shot && existsSync(out.shot), '截图证人应当落盘');
  assert.ok(/-shot\.png$/.test(out.shot));
  // tag 里的非法字符要被清洗掉，别把路径写坏
  assert.ok(!path.basename(out.text).includes('/'));
});

test('captureBrowserScene：opencli 调不起来也不抛，证人记 null/错误现场', () => {
  const dir = mkdtemp2(path.join(os.tmpdir(), 'demand-lib-scene-'));
  lib.initEvidence('unit-test-scene-fail', { dir, argv: [] });
  let out;
  assert.doesNotThrow(() => { out = lib.captureBrowserScene('sess-x', 'boom', { bin: '/nonexistent-opencli-xyz' }); });
  assert.equal(out.shot, null);
  // 拍不到的原因必须留下：静默 null 会让「这次没拍成」和「压根没拍」长得一样
  assert.ok(out.shotError, '截图拿不到时应记下原因');
  // 文本证人退化为错误现场文件（或 null），但绝不抛出去掩盖原始错误
  if (out.text) {
    const page = JSON.parse(readFileSync(out.text, 'utf8'));
    assert.ok(page.error, '退化文件里应记下拿不到证人的原因');
  }
});

test('captureBrowserScene：opencli 在场但截图子命令失败时也记 shotError', { skip: shShimSkip }, () => {
  const dir = mkdtemp2(path.join(os.tmpdir(), 'demand-lib-scene-'));
  const binDir = mkdtemp2(path.join(os.tmpdir(), 'demand-lib-bin-'));
  const bin = fakeOpencli(binDir, [
    'case "$*" in',
    '  *" eval "*) echo \'{"url":"https://example.test/x","title":"T","readyState":"complete","text":"hi"}\';;',
    '  *" screenshot "*) echo "no active session" 1>&2; exit 4;;',
    'esac',
  ].join('\n'));
  lib.initEvidence('unit-test-scene-shotfail', { dir, argv: [] });
  const out = lib.captureBrowserScene('sess-x', 'shotfail', { bin });
  assert.ok(out.text, '文本证人照常落盘——一个证人失败不该拖垮另一个');
  assert.equal(out.shot, null);
  assert.match(out.shotError, /no active session|exit 4/);
});
