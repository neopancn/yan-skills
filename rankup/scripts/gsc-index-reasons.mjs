// GSC 索引报告批量体检：逐属性抓「网页未被编入索引的原因」表。
// 用途：排查多站点「新原因导致 xxx 无法编入索引」类问题。
// 用法：
//   node gsc-index-reasons.mjs --properties a.com,b.com [--profile tvgnfg4a] [--out <json路径>] [--session <名>]
// 依赖：opencli 浏览器桥已连接且该 profile 已登录 Google（GSC 权限）。
// 已知坑：
//   - GSC 报表懒加载，每站轮询 waitUpTo 60s；原因表在页面文本里，直接解析 innerText。
//   - 属性切换后页面 SPA 复用，open 会强制导航到新 resource_id。
// 验证：2026-10-16 neorainboy 账号 8 属性全量跑通（shiptowp/aicharactervoice/aifacerater/drivebatcher/haoyi/larktune/linkedinwendanswer/paidfetch）。

import { opencliRun } from "./lib-opencli.mjs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const profile = arg("profile", null);
const outPath = arg("out", null);
const session = arg("session", "gsc-idx-reasons");
const properties = (arg("properties", null) || "").split(",").map(s => s.trim()).filter(Boolean);

if (!properties.length) {
  console.error("用法：node gsc-index-reasons.mjs --properties a.com,b.com [--profile <p>] [--out <file>] [--session <名>]");
  process.exit(1);
}

const prefix = profile ? ["--profile", profile] : [];

const EXTRACT_JS = `(() => {
  const t = document.body.innerText;
  const start = t.indexOf("网页索引编制");
  return t.slice(start === -1 ? 0 : start, (start === -1 ? 0 : start) + 6000);
})()`;

function oc(args, opts = {}) {
  return opencliRun([...prefix, ...args], { encoding: "utf8", timeout: 60000, ...opts });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitReportReady(prop) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = oc(["browser", session, "eval", "document.body.innerText.includes('已编入索引') || document.body.innerText.includes('处理中') ? (document.body.innerText.includes('已编入索引') ? 'ready' : 'loading') : 'other'"]);
      const s = String(r || "").trim().replace(/^"+|"+$/g, "");
      if (s === "ready") return true;
    } catch { /* retry */ }
    await sleep(4000);
  }
  return false;
}

function parseReasons(text) {
  // 从页面文本切出「网页未被编入索引的原因」到「改进网页的呈现效果」或页尾
  const lines = text.split("\n").map(l => l.trim());
  const out = { summary: {}, reasons: [], improved: [] };
  const mi = lines.findIndex(l => /已编入索引/.test(l) && /未编入索引/.test(lines[lines.indexOf(l) - 1] || ""));
  // 更稳的摘要抓法：数字跟在「未编入索引/已编入索引」附近
  const idxNotIndexed = lines.indexOf("未编入索引");
  const idxIndexed = lines.indexOf("已编入索引");
  if (idxNotIndexed > -1) out.summary.notIndexed = lines[idxNotIndexed + 1];
  if (idxIndexed > -1) out.summary.indexed = lines[idxIndexed + 1];

  const start = lines.findIndex(l => l.includes("网页未被编入索引的原因"));
  const end = lines.findIndex(l => l.includes("改进网页的呈现效果"));
  const seg = lines.slice(start + 1, end === -1 ? lines.length : end);
  // 原因行模式：原因名 → 来源(网站/用户/不适用) → 验证(未启动/已通过/失败…) → 数字
  const KNOWN = ["网页会自动重定向","重复网页，用户未选定规范网页","重复网页，Google 已选择其他规范网页","未找到 (404)","已被 robots.txt 屏蔽","备用网页（有适当的规范标记）","备用网页（提交了备用网址）","已提交，未编入索引","已抓取 - 尚未编入索引","已发现 - 尚未编入索引","抓取异常","服务器错误 (5xx)","软 404","被「noindex」标记屏蔽","重复提交的网址未选定规范网页","网页会自动重定向","替代网页（有适当的规范标记）"];
  for (let i = 0; i < seg.length; i++) {
    const l = seg[i];
    if (!l || l.length > 40) continue;
    const n = seg[i + 1];
    const isCount = n && /^\d+$/.test(n) && !(seg[i - 1] || "").match(/^\d+$/);
    if (isCount && (KNOWN.some(k => l === k || l.startsWith(k.slice(0, 8))) || /网页|错误|抓取|索引|屏蔽|重定向|标记/.test(l))) {
      out.reasons.push({ reason: l, count: parseInt(n, 10) });
    }
  }
  // 已编入索引但有呈现问题的第二张表
  const start2 = lines.findIndex(l => l.includes("改进网页的呈现效果"));
  if (start2 > -1) {
    const seg2 = lines.slice(start2 + 1);
    for (let i = 0; i < seg2.length; i++) {
      const l = seg2[i];
      const n = seg2[i + 1];
      if (n && /^\d+$/.test(n) && !/^\d+$/.test(l) && l.length < 40 && l !== "每页行数") {
        out.improved.push({ reason: l, count: parseInt(n, 10) });
        i++;
      }
    }
  }
  return out;
}

const results = [];
try {
  for (const prop of properties) {
    const url = `https://search.google.com/search-console/index?resource_id=${encodeURIComponent("sc-domain:" + prop)}&pages=ALL_URLS`;
    process.stderr.write(`\n==> ${prop}\n`);
    oc(["browser", session, "open", url]);
    const ready = await waitReportReady(prop);
    if (!ready) {
      results.push({ property: prop, error: "timeout waiting report" });
      continue;
    }
    await sleep(2000);
    let text = "";
    try {
      text = String(oc(["browser", session, "eval", EXTRACT_JS]));
      if (text.startsWith('"') && text.endsWith('"')) text = JSON.parse(text);
    } catch (e) {
      text = "";
    }
    if (typeof text === "object" && text !== null) text = text.result ?? text.value ?? JSON.stringify(text);
    const parsed = parseReasons(String(text));
    results.push({ property: prop, ...parsed, raw: String(text).slice(0, 3000) });
  }
} finally {
  try { oc(["browser", session, "close"]); } catch { /* ignore */ }
}

const json = JSON.stringify(results, null, 2);
console.log(json);
if (outPath) {
  writeFileSync(outPath, json, "utf8");
  process.stderr.write(`\nsaved -> ${outPath}\n`);
}
