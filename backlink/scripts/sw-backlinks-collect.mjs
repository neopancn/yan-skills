#!/usr/bin/env node
// SimilarWeb Pro 竞对外链采集：backlinks 表格同源 API 翻页拉全量
// 用法:
//   node sw-backlinks-collect.mjs --keys "usephotocraft.com,photocraft.one" --out ./sw-backlinks-data [--keep-open] [--profile msht4gxm] [--session sw-backlinks]
// 依赖: opencli CLI + SimilarWeb Pro 登录态（默认 msht4gxm profile）
// 会话: 默认固定 sw-backlinks（配额站纪律：一站一固定会话），结束自动 close，--keep-open 保留
// API（2026-10-17 抓包确认）:
//   POST /api/backlinks/backlinks?page=<n>&pageSize=100&status=Active&followType=<DoFollowOnly|All>&key=<domain>&asc=false&sort=DomainScore
//   body '[]'（空数组）；UI 的 duration=28d 不进 API，后端默认即 28d 窗口
//   pageSize>100 报 400 Illegal Page Size（999/500 均实测被拒）；followType=NoFollow 非法（400，2026-10-17 实测）
//   响应: {TotalRecords, Records[{UrlFrom,UrlTo,Rank,PageScore,DomainScore,FirstSeen,LastVisited,IsLost,IsNew,IsBroken,Image}], Page, PageSize}
// 输出: <out>/<domain>.json = {key, followType, status, total, collected, fetchedAt, records}
// 实测: 2026-10-17（usephotocraft.com 1488 条 = 15 页全量拉通）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function findOpencli() {
  const entry = 'D:/Program Files/nodejs/node_global/node_modules/@jackwener/opencli/dist/src/main.js';
  if (process.platform === 'win32' && existsSync(entry)) return [process.execPath, entry];
  return ['opencli'];
}
const [OPENCLI_BIN, ...OPENCLI_PRE] = findOpencli();

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KEYS = (get('--keys', '') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!KEYS.length) { console.error('缺 --keys（逗号分隔域名）'); process.exit(1); }
for (const k of KEYS) {
  if (!/^[a-z0-9.-]+$/i.test(k)) { console.error(`非法域名: ${k}`); process.exit(1); }
}
const OUT = get('--out', './sw-backlinks-data');
const FOLLOW = get('--follow', 'DoFollowOnly');
if (!['DoFollowOnly', 'All'].includes(FOLLOW)) { console.error(`--follow 只支持 DoFollowOnly|All，得到 ${FOLLOW}`); process.exit(1); }
const PROFILE = get('--profile', 'msht4gxm');
const SESSION = get('--session', 'sw-backlinks');
const KEEP_OPEN = argv.includes('--keep-open');
const PAGE_SIZE = 100;

const oc = (sub) => JSON.parse(execFileSync(OPENCLI_BIN, [...OPENCLI_PRE, '--profile', PROFILE, 'browser', SESSION, ...sub], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 页面上下文里跑一页 fetch。返回原始 JSON 文本；非 200 抛错（限流/登录态失效在这里现形）。
function fetchPage(key, page) {
  const js = `(async()=>{const q='page=${page}&pageSize=${PAGE_SIZE}&status=Active&followType=${FOLLOW}&key=${key}&asc=false&sort=DomainScore';const r=await fetch('/api/backlinks/backlinks?'+q,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','x-requested-with':'XMLHttpRequest'},body:'[]'});const t=await r.text();if(r.status!==200)return JSON.stringify({httpError:r.status,head:t.slice(0,300)});return t;})()`;
  const raw = oc(['eval', js]);
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const data = JSON.parse(s);
  if (data.httpError) throw new Error(`HTTP ${data.httpError}: ${data.head}`);
  if (!Array.isArray(data.Records)) throw new Error(`响应缺 Records: ${s.slice(0, 200)}`);
  return data;
}

function collectKey(key) {
  const first = fetchPage(key, 1);
  const total = first.TotalRecords || 0;
  const records = [...first.Records];
  const pages = Math.ceil(total / PAGE_SIZE);
  console.log(`  ${key}: ${total} 条 / ${pages} 页`);
  for (let p = 2; p <= pages; p++) {
    sleep(400);
    const d = fetchPage(key, p);
    records.push(...d.Records);
    process.stdout.write(`\r  ${key}: ${records.length}/${total}`);
  }
  if (pages > 1) process.stdout.write('\n');
  const out = {
    key, followType: FOLLOW, status: 'Active',
    total, collected: records.length,
    fetchedAt: new Date().toISOString(), records,
  };
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${key}.json`);
  writeFileSync(file, JSON.stringify(out));
  console.log(`  已写 ${file}`);
}

console.log(`[1/2] 打开 pro.similarweb.com（profile=${PROFILE} session=${SESSION}）`);
oc(['open', `https://pro.similarweb.com/#/digitalsuite/acquisition/backlinks/table/999/?duration=28d&key=${KEYS[0]}&sort=DomainScore&asc=false&status=Active&follow=DoFollowOnly`]);
sleep(8000);

console.log(`[2/2] 采集 ${KEYS.length} 个域名的 dofollow active 外链`);
const failed = [];
for (const key of KEYS) {
  try {
    collectKey(key);
  } catch (e) {
    failed.push(key);
    console.error(`  ${key} 失败: ${e.message}`);
  }
}

if (!KEEP_OPEN) {
  try { oc(['close']); } catch { /* 会话可能已释放 */ }
}

if (failed.length) {
  console.error(`失败域名: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('完成');
