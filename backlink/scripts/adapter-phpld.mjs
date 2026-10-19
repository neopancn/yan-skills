#!/usr/bin/env node
/**
 * adapter-phpld.mjs — one adapter for the PHP Link Directory family.
 *
 * Why a family adapter instead of a generic driver: these installs share an
 * identical field contract — TITLE, URL, DESCRIPTION, OWNER_NAME, OWNER_EMAIL,
 * CATEGORY_ID — across dozens of domains. Writing to that contract is exact
 * where a fuzzy scorer is a guess, and a guess on a submission form is how the
 * wrong form gets filled.
 *
 * These installs carry reCAPTCHA. This adapter therefore NEVER submits: it
 * fills every field it may legitimately fill, selects a category, leaves the
 * tab open at the ready-to-send state, and reports. The person clears the
 * challenge and clicks Continue — seconds per site.
 *
 * Usage:
 *   node scripts/adapter-phpld.mjs --session S --profile p.json \
 *     --urls urls.txt [--limit 12] [--out staged.json]
 *
 * 2026-08-30 双证人化：每行 state 落点（eval-failed / not-this-family /
 * staged-captcha / filled-no-captcha / error）在写行前 captureScene（穿透
 * census + 截图）落进 `<out>.evidence/`，行内带 evidence；浏览器调用改走
 * opencli-core 的 opencli()（带访问记账），不再 execFileSync 裸调。
 * 截图链路已实盘验证。
 */

import fs from 'node:fs';
import { helpGuard, opencli } from './opencli-core.mjs';
import { captureScene, defaultSceneDir } from './lib-evidence-scene.mjs';
helpGuard(import.meta.url);

const a = {};
for (let i = 2; i < process.argv.length; i++) {
  const f = process.argv[i];
  if (f.startsWith('--')) a[f.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
if (!a.session || !a.profile || !a.urls) { console.error('need --session --profile --urls'); process.exit(2); }

const profile = JSON.parse(fs.readFileSync(a.profile, 'utf8'));
const urls = fs.readFileSync(a.urls, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, Number(a.limit) || Infinity);

// ONE SESSION PER STAGED SITE. `tab new` does create a tab, but a session only
// ever tracks its newest one — earlier tabs drop out of `tab list` and the
// staged queue evaporates while the run still reports N staged. A session NAME
// is what owns a tab, so N staged forms need N session names. Measured: three
// concurrent sessions each keep their own tab; three `tab new` calls inside one
// session leave exactly one.
const sessionFor = (url) => `${a.session}-${new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
const ocliIn = async (session, ...argv) => (await opencli(['browser', session, ...argv], { windowMode: 'dedicated', timeoutMs: 90_000 })).stdout;
const evalIn = async (session, js) => { try { return JSON.parse(await ocliIn(session, 'eval', js)); } catch { return null; } };
const evidenceDir = defaultSceneDir({ out: a.out || null, script: 'adapter-phpld' });

// Category preference, best first. These directories are general-purpose and
// their taxonomies are near-identical, so one ordered list covers the family.
// Falling back to a wrong category is worse than falling back to a broad one:
// an off-category listing is the usual reason a free submission is rejected.
const CATEGORY_PREFS = ['internet', 'computer', 'web', 'software', 'technology', 'tools', 'business', 'services'];

const FILL = (P) => `
(() => {
  const P = ${JSON.stringify(P)};
  const f = [...document.forms].find(x => x.elements.URL && x.elements.TITLE);
  if (!f) return JSON.stringify({ ok:false, reason:'not a PHPLD form' });
  const put = (n, v) => { const e = f.elements[n]; if (!e) return null;
    e.value = v; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    return String(e.value).slice(0,50); };

  const filled = {
    TITLE: put('TITLE', P.brand),
    URL: put('URL', P.url),
    DESCRIPTION: put('DESCRIPTION', P.description),
    OWNER_NAME: put('OWNER_NAME', P.owner),
    OWNER_EMAIL: put('OWNER_EMAIL', P.email),
  };

  let category = null;
  const sel = f.elements.CATEGORY_ID;
  if (sel && sel.options) {
    const opts = [...sel.options].filter(o => o.value && o.value !== '0');
    for (const want of ${JSON.stringify(CATEGORY_PREFS)}) {
      const hit = opts.find(o => o.text.toLowerCase().includes(want));
      if (hit) { sel.value = hit.value; sel.dispatchEvent(new Event('change',{bubbles:true})); category = hit.text.trim().replace(/^[|_\\s]+/,''); break; }
    }
  }

  const captcha = /recaptcha|hcaptcha|turnstile/i.test(document.documentElement.innerHTML)
    || !!f.elements['g-recaptcha-response'];
  const btn = [...f.querySelectorAll('input[type=submit],button')].map(b => (b.value||b.innerText||'').trim());
  return JSON.stringify({ ok:true, filled, category, captcha, submitLabels: btn });
})()`;

const payload = {
  brand: profile.brand,
  url: profile.linkTargets?.default || profile.canonicalUrl,
  description: profile.descriptions.medium500,
  owner: profile.submitterName || profile.brand,
  email: profile.contactEmail,
};

const staged = [];
for (const url of urls) {
  const row = { url, at: new Date().toISOString() };
  const session = sessionFor(url);
  row.session = session;
  try {
    await ocliIn(session, 'open', url);
    const page = await evalIn(session, 'JSON.stringify({url:location.href,title:document.title})');
    row.page = page;
    const r = await evalIn(session, FILL(payload));
    row.result = r;
    row.state = !r ? 'eval-failed'
      : !r.ok ? 'not-this-family'
      : r.captcha ? 'staged-captcha'
      : 'filled-no-captcha';
  } catch (e) {
    // catch → state:'error' 必须带现场（下面统一 captureScene）。标签页留着——
    // 本脚本本来就不 close，失败后人还能回到现场。
    row.state = 'error';
    row.error = String(e.message).slice(0, 200);
  }
  // 每行 state 落点一对现场（穿透 census + 截图），行内带路径。永不 throw。
  row.evidence = await captureScene({
    session, outDir: evidenceDir, windowMode: 'dedicated',
    tag: `${new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')}-${row.state}`,
    note: `adapter-phpld ${url} → ${row.state}${row.error ? `: ${row.error}` : ''}`,
  });
  staged.push(row);
  process.stderr.write(`${row.state.padEnd(18)} ${url}\n`);
  if (a.out) fs.writeFileSync(a.out, JSON.stringify({ generatedAt: new Date().toISOString(), staged }, null, 2) + '\n');
}

const by = staged.reduce((m, r) => ((m[r.state] = (m[r.state] || 0) + 1), m), {});
process.stderr.write(`\n${staged.length} processed: ${JSON.stringify(by)}\n`);
const queueRows = staged.filter((r) => r.state === 'staged-captcha' || r.state === 'filled-no-captcha');
fs.writeFileSync((a.out || '/tmp/staged') + '.queue.tsv',
  queueRows.map((r) => `${r.session}\t${r.url}\t${r.state}`).join('\n') + '\n');
process.stderr.write(`Queue: ${queueRows.length} staged tabs, one session each -> ${(a.out || '/tmp/staged')}.queue.tsv\n`);
