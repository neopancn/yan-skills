// scripts/demand/suggest.mjs 的离线契约（2026-09-02）：
//
//   1. 三种响应形状各能解析：Google/Bing 的 ["q", [...]]、DDG 的 [{phrase}]；
//   2. URL 构造把 hl/gl 转成各引擎自己的格式（Bing market=en-US、DDG kl=us-en），
//      Google 带 oe=utf-8&ie=utf-8，词根 URL 编码；
//   3. 某引擎失败时：返回 null（不是 []），{engine,url,status,body} 落证据目录，
//      manifest 逐引擎记非 ok 状态——「0 条」和「没取到」必须长得不一样；
//   4. 引擎之间互不影响：一个 429 不拖累另一个的 ok。
//
// 纯离线：fetcher 注入假响应，不联网。真联网结果见脚本头部「已验证日期」。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(pathToFileURL(path.join(here, '../scripts/demand/_lib.mjs')).href);
const sg = await import(pathToFileURL(path.join(here, '../scripts/demand/suggest.mjs')).href);

test('parseGoogle：["q", ["s1","s2"]]', () => {
  const text = JSON.stringify(['clipboard history', ['clipboard history windows', 'clipboard history mac']]);
  assert.deepEqual(sg.parseGoogle(text), ['clipboard history windows', 'clipboard history mac']);
  assert.throws(() => sg.parseGoogle('{"error":"blocked"}'), /形状/);
});

test('parseBing：OpenSearch ["q", ["s1"], [], []]', () => {
  const text = JSON.stringify(['clipboard history', ['clipboard history windows 11', 'clipboard history shortcut'], [], []]);
  assert.deepEqual(sg.parseBing(text), ['clipboard history windows 11', 'clipboard history shortcut']);
  assert.throws(() => sg.parseBing('<html>blocked</html>'));
});

test('parseDdg：[{"phrase":"s1"},{"phrase":"s2"}]', () => {
  const text = JSON.stringify([{ phrase: 'clipboard history android' }, { phrase: 'clipboard history iphone' }]);
  assert.deepEqual(sg.parseDdg(text), ['clipboard history android', 'clipboard history iphone']);
  assert.throws(() => sg.parseDdg('{"phrase":"not-an-array"}'), /数组/);
});

test('buildUrl：hl/gl 转成各引擎自己的格式，词根做 URL 编码', () => {
  const g = sg.buildUrl('google', 'クリップボード 履歴', { hl: 'ja', gl: 'jp' });
  assert.ok(g.startsWith('https://suggestqueries.google.com/complete/search?client=firefox&q='));
  assert.ok(g.includes('&hl=ja&gl=jp&oe=utf-8&ie=utf-8'));
  assert.ok(g.includes(encodeURIComponent('クリップボード 履歴')));
  const b = sg.buildUrl('bing', 'clipboard history', { hl: 'en', gl: 'us' });
  assert.equal(b, 'https://api.bing.com/osjson.aspx?query=clipboard%20history&language=en&market=en-US');
  const d = sg.buildUrl('ddg', 'clipboard history', { hl: 'en', gl: 'us' });
  assert.equal(d, 'https://duckduckgo.com/ac/?q=clipboard%20history&kl=us-en');
  assert.throws(() => sg.buildUrl('yandex', 'x'), /未知引擎/);
});

test('失败引擎：返回 null、{engine,url,status,body} 落证据目录、manifest 记非 ok；其它引擎不受影响', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'suggest-ev-'));
  lib.initEvidence('suggest-unit', { dir, argv: [] });
  const fetcher = async (url) => {
    if (url.includes('suggestqueries.google.com')) return { status: 429, body: 'slow down' };
    if (url.includes('api.bing.com')) return { status: 200, body: JSON.stringify(['q', ['bing one', 'bing two']]) };
    return { status: 200, body: '<html>captcha</html>' }; // ddg：200 但不是 JSON
  };
  const res = await sg.collect('clipboard history', { hl: 'en', gl: 'us', fetcher });
  assert.equal(res.engines.google, null, '429 的引擎必须是 null，不是 []');
  assert.deepEqual(res.engines.bing, ['bing one', 'bing two']);
  assert.equal(res.engines.ddg, null, '解析失败也必须是 null');

  const file = lib.writeManifest('completed');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const byEngine = Object.fromEntries(m.sources.map((s) => [s.source, s]));
  assert.equal(byEngine.google.status, 'http_429');
  assert.equal(byEngine.bing.status, 'ok');
  assert.equal(byEngine.bing.rawCount, 2);
  assert.equal(byEngine.ddg.status, 'parse_error');
  assert.ok(byEngine.google.url.includes('suggestqueries.google.com'));

  const dump = readdirSync(dir).find((f) => f === 'suggest-google-429.json');
  assert.ok(dump, `证据目录里没有 google 429 现场：${readdirSync(dir).join(', ')}`);
  const scene = JSON.parse(readFileSync(path.join(dir, dump), 'utf8'));
  assert.equal(scene.engine, 'google');
  assert.equal(scene.status, 429);
  assert.equal(scene.body, 'slow down');
  assert.ok(scene.url.startsWith('https://suggestqueries.google.com/'));

  const s = lib.sourceStatusSummary();
  assert.equal(s.failed, 2);
  assert.equal(s.ok, 1);
});

test('网络层异常（fetcher 抛错）记 network_error，状态 null', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'suggest-ev-'));
  lib.initEvidence('suggest-unit-net', { dir, argv: [] });
  const fetcher = async () => { throw new Error('ECONNRESET'); };
  const items = await sg.collectEngine('ddg', 'x', { fetcher });
  assert.equal(items, null);
  const m = JSON.parse(readFileSync(lib.writeManifest('completed'), 'utf8'));
  assert.equal(m.sources[0].status, 'network_error');
  assert.ok(m.sources[0].error.includes('ECONNRESET'));
  assert.ok(readdirSync(dir).includes('suggest-ddg-neterr.json'));
});
