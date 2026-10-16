// 全站 canonical + sitemap 体检：
//   1) GET /sitemap.xml（跟踪重定向，记录最终 URL 与状态）
//   2) 解析 sitemap（urlset / sitemapindex），抽样逐 URL 探活：状态码、是否重定向（sitemap 里的重定向 URL 是问题）
//   3) 抽样页面（首页 + sitemap 前 N 个）抓 HTML：canonical href、meta robots/noindex、
//      canonical 是否等于最终落地 URL、https/apex 一致性
//   4) www 变体跳转行为
// 用法：node canonical-sitemap-audit.mjs --domains a.com,b.com [--out x.json] [--sample 6]
// 已知坑：CF 会拦非浏览器 UA（error 1010）→ 必须带真实 Chrome UA；
//        shiptowp.com 等偶发 SSLEOFError → 每请求重试 3 次。
// 验证：2026-10-16 八站全量跑通。

import { writeFileSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
const domains = (arg("domains") || "").split(",").map(s => s.trim()).filter(Boolean);
const outPath = arg("out", null);
const sampleN = parseInt(arg("sample", "6"), 10);
if (!domains.length) { console.error("用法：node canonical-sitemap-audit.mjs --domains a.com,b.com [--out x.json] [--sample 6]"); process.exit(1); }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(20000),
        ...opts,
      });
      return res;
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// 手动跟跳转，记录链路
async function fetchChain(url, maxHops = 5) {
  const chain = [];
  let cur = url;
  for (let h = 0; h < maxHops; h++) {
    const res = await fetchRetry(cur);
    chain.push({ url: cur, status: res.status, location: res.headers.get("location") });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location"), cur).href;
      continue;
    }
    return { chain, finalUrl: cur, status: res.status, text: await res.text().catch(() => "") };
  }
  return { chain, finalUrl: cur, status: null, text: "", error: "too many redirects" };
}

function parseSitemap(xml) {
  const isIndex = /<sitemapindex/i.test(xml);
  const tag = isIndex ? "sitemap" : "url";
  const locs = [...xml.matchAll(new RegExp(`<${tag}[^>]*>\\s*<loc>([\\s\\S]*?)</loc>`, "gi"))]
    .map(m => m[1].trim());
  const lastmods = [...xml.matchAll(/<lastmod>([\s\S]*?)<\/lastmod>/gi)].map(m => m[1].trim());
  return { isIndex, urls: locs, lastmods };
}

function extractSeo(html, finalUrl) {
  const out = {};
  const c = html.match(/<link[^>]+rel=["']?canonical["']?[^>]*>/i) || html.match(/<link[^>]+href=["'][^"']*["'][^>]*rel=["']?canonical["']?[^>]*>/i);
  if (c) {
    const href = (c[0].match(/href=["']([^"']*)["']/i) || [])[1];
    out.canonical = href ? new URL(href, finalUrl).href : null;
  } else out.canonical = null;
  const robots = (html.match(/<meta[^>]+name=["']robots["'][^>]*>/i) || [])[0];
  if (robots) out.metaRobots = (robots.match(/content=["']([^"']*)["']/i) || [])[1] || "";
  out.title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim().slice(0, 100);
  out.h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  out.htmlBytes = html.length;
  return out;
}

function normalize(u) {
  try { const x = new URL(u); return x.origin.replace(/^https?:\/\/www\./, "https://") + x.pathname.replace(/\/$/, "") ; } catch { return u; }
}

const report = [];
for (const d of domains) {
  process.stderr.write(`\n==> ${d}\n`);
  const r = { domain: d, issues: [] };
  const issue = (severity, kind, detail) => r.issues.push({ severity, kind, detail });

  // 1) www 变体
  try {
    const www = await fetchChain(`https://www.${d}/`);
    r.www = { chain: www.chain, final: www.finalUrl, status: www.status };
    const firstHop = www.chain[0];
    if (!firstHop || firstHop.status !== 301) issue("warn", "www_redirect", `https://www.${d}/ 首跳返回 ${firstHop ? firstHop.status : "无响应"}（非 301）`);
  } catch (e) { r.www = { error: String(e).slice(0, 120) }; }

  // 2) sitemap.xml
  let sm;
  try {
    sm = await fetchChain(`https://${d}/sitemap.xml`);
    r.sitemap = { url: `https://${d}/sitemap.xml`, chain: sm.chain, finalUrl: sm.finalUrl, status: sm.status };
    if (sm.finalUrl !== `https://${d}/sitemap.xml` && !sm.finalUrl.startsWith(`https://${d}/`))
      issue("warn", "sitemap_redirect", `sitemap.xml 跳转到 ${sm.finalUrl}`);
    if (sm.status !== 200) { issue("error", "sitemap_status", `sitemap.xml 状态 ${sm.status}`); report.push(r); continue; }
  } catch (e) { r.sitemap = { error: String(e).slice(0, 200) }; issue("error", "sitemap_fetch", String(e).slice(0, 200)); report.push(r); continue; }

  const parsed = parseSitemap(sm.text);
  r.sitemap.type = parsed.isIndex ? "sitemapindex" : "urlset";
  r.sitemap.count = parsed.urls.length;
  if (!parsed.isIndex && parsed.urls.length === 0) issue("error", "sitemap_empty", "sitemap 无 <loc> 条目");

  // 展开 sitemap index（最多 10 个子 sitemap）
  let pageUrls = parsed.urls;
  if (parsed.isIndex) {
    pageUrls = [];
    for (const child of parsed.urls.slice(0, 10)) {
      try {
        const c = await fetchRetry(child);
        const t = await c.text();
        if (c.status !== 200) issue("error", "child_sitemap_status", `${child} → ${c.status}`);
        const cp = parseSitemap(t);
        pageUrls.push(...cp.urls);
      } catch (e) { issue("error", "child_sitemap_fetch", `${child}: ${String(e).slice(0, 120)}`); }
    }
    r.sitemap.pageUrlCount = pageUrls.length;
  }

  // 3) 抽样探活 sitemap URL
  const step = Math.max(1, Math.floor(pageUrls.length / sampleN));
  const sample = pageUrls.filter((_, i) => i % step === 0).slice(0, sampleN);
  r.pages = [];
  let nonCanonicalBase = 0;
  for (const u of sample) {
    try {
      const p = await fetchChain(u);
      const seo = extractSeo(p.text, p.finalUrl);
      const row = { url: u, finalUrl: p.finalUrl, status: p.status, ...seo };
      // sitemap 里的 URL 重定向 = 问题
      if (p.finalUrl !== u && p.status >= 300 && p.chain.some(c => c.status >= 300 && c.status < 400))
        issue("warn", "sitemap_url_redirect", `${u} → ${p.finalUrl}`);
      if (!/^https:\/\/[^/]*\/?$/.test(u)) { /* noop */ }
      if (seo.canonical === null) issue("warn", "no_canonical", u);
      else if (normalize(seo.canonical) !== normalize(p.finalUrl)) issue("error", "canonical_mismatch", `${u} 页面 canonical=${seo.canonical} 落地=${p.finalUrl}`);
      if (seo.metaRobots && /noindex/i.test(seo.metaRobots)) issue("error", "noindex", `${u} meta robots=${seo.metaRobots}`);
      if (p.status === 404) issue("error", "sitemap_url_404", u);
      // 基域一致性：sitemap URL 应统一 https + apex（或统一带 www）
      const base = new URL(u);
      if (base.protocol !== "https:" || base.hostname.startsWith("www.")) nonCanonicalBase++;
      r.pages.push(row);
      await sleep(300);
    } catch (e) { r.pages.push({ url: u, error: String(e).slice(0, 120) }); }
  }
  if (nonCanonicalBase > 0) issue("warn", "sitemap_mixed_base", `${nonCanonicalBase}/${sample.length} 个抽样 URL 是 http:// 或 www. 开头`);
  report.push(r);
  await sleep(500);
}

const json = JSON.stringify(report, null, 2);
console.log(json);
if (outPath) { writeFileSync(outPath, json, "utf8"); process.stderr.write(`\nsaved -> ${outPath}\n`); }
