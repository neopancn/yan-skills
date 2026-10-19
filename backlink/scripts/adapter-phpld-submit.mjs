#!/usr/bin/env node
/**
 * adapter-phpld-submit.mjs — Lane A for the PHPLD family: press Continue on the
 * rows that showed no challenge, and read what actually came back.
 *
 * Kept separate from the staging adapter on purpose. Staging is safe to run over
 * a whole family; pressing submit is not, and the two must not share a flag that
 * someone can set by accident.
 *
 * It refuses to submit a form that acquired a challenge since staging — PHPLD
 * installs vary, and the challenge sometimes only renders on the second view.
 *
 * Usage: node scripts/adapter-phpld-submit.mjs --queue q.tsv --out result.json
 *
 * 2026-08-30 双证人化：每行 state 落点在写行前 captureScene（穿透 census + 截图）
 * 落进 `<out>.evidence/`，行内带 evidence；提交后的定长 `sleep 3` 换成条件等待
 * （连续两次读数一致才继续）；浏览器调用改走 opencli-core 的 opencli()。
 * 截图链路已实盘验证。
 */
import fs from 'node:fs';
import { helpGuard, opencli } from './opencli-core.mjs';
import { captureScene, defaultSceneDir } from './lib-evidence-scene.mjs';
import { classifySubmitOutcome, submitOutcomeProbeSource } from './lib-submit-outcome.mjs';
helpGuard(import.meta.url);

const a = {};
for (let i = 2; i < process.argv.length; i++) { const f = process.argv[i]; if (f.startsWith('--')) a[f.slice(2)] = process.argv[++i]; }
if (!a.queue) { console.error('need --queue'); process.exit(2); }

const rows = fs.readFileSync(a.queue, 'utf8').split(/\r?\n/).filter(Boolean)
  .map((l) => { const [session, url, state] = l.split('\t'); return { session, url, state }; })
  .filter((r) => r.state === 'filled-no-captcha');

const ocli = async (s, ...argv) => (await opencli(['browser', s, ...argv], { windowMode: 'dedicated', timeoutMs: 90_000 })).stdout;
const ev = async (s, js) => { try { return JSON.parse(await ocli(s, 'eval', js)); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidenceDir = defaultSceneDir({ out: a.out || null, script: 'adapter-phpld-submit' });
// 每行 state 落点一对现场。永不 throw；行内带路径。
const sceneFor = (res, note) => captureScene({
  session: res.session, outDir: evidenceDir, windowMode: 'dedicated',
  tag: `${String(res.url || '').replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_').slice(0, 60)}-${res.state}`,
  note,
});

const out = [];
for (const r of rows) {
  const res = { url: r.url, session: r.session };
  try {
    const pre = await ev(r.session, `(()=>{const f=[...document.forms].find(x=>x.elements.URL&&x.elements.TITLE);
      if(!f) return JSON.stringify({gone:1});
      const challenge=/recaptcha|hcaptcha|turnstile/i.test(document.documentElement.innerHTML)||!!f.elements['g-recaptcha-response']
        ||!!f.querySelector('[name*=captcha i],[name=IMAGEHASH],[name=scode]');
      const b=f.querySelector('input[type=submit],button[type=submit]');
      if(b) b.setAttribute('data-bl-go','1');
      return JSON.stringify({challenge,sel:b?'[data-bl-go="1"]':null,label:b?(b.value||b.innerText||'').trim():null,
        filled:{TITLE:f.elements.TITLE.value,URL:f.elements.URL.value},before:location.href,beforeTitle:document.title});})()`);
    if (!pre || pre.gone) { res.state = 'form-gone'; res.evidence = await sceneFor(res, 'PHPLD form no longer present'); out.push(res); continue; }
    if (pre.challenge) { res.state = 'challenge-appeared'; res.evidence = await sceneFor(res, 'challenge appeared since staging'); out.push(res); continue; }
    if (!pre.sel) { res.state = 'no-submit-control'; res.evidence = await sceneFor(res, 'no submit control found'); out.push(res); continue; }
    if (!pre.filled.URL) { res.state = 'not-filled'; res.evidence = await sceneFor(res, 'URL field empty at submit time'); out.push(res); continue; }
    res.label = pre.label;
    await ocli(r.session, 'click', pre.sel);
    // 条件等待，不是定长 sleep：每秒读一次 {url,title,len}，连续两次一致
    //（页面安定）才继续，最多 10s。定长 3 秒读不出「到底等到了什么」。
    {
      let prev = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await sleep(1_000);
        const now = await ev(r.session, 'JSON.stringify({url:location.href,title:document.title,len:document.body.innerText.length})');
        const key = JSON.stringify(now);
        if (prev === key) break;
        prev = key;
      }
    }
    // 判据成对，见 lib-submit-outcome.mjs 头部注释。旧版在这里扫全页文本找
    // thank/success，PHPLD 的 add.php 校验失败时**原样重画同一张表单**并把值回填
    // 进 input——那种页面上「我们的 URL 在页面上」和「thank you」都可能成立，而什么
    // 都没被接受。所以这里读的是「表单之外的区域」和「表单还在不在」两半。
    const challengeProbe = await ev(r.session, `JSON.stringify({challenge:/recaptcha|hcaptcha|turnstile/i.test(document.documentElement.innerHTML)||!!document.querySelector('[name*=captcha i],[name=IMAGEHASH],[name=scode]')})`);
    const probe = await ev(r.session, submitOutcomeProbeSource(pre.filled.URL));
    const verdict = classifySubmitOutcome({
      ...(probe || {}),
      challenge: Boolean(challengeProbe?.challenge),
      beforeUrl: pre.before,
      beforeTitle: pre.beforeTitle,
    });
    res.after = probe ? { url: probe.afterUrl, title: probe.title, text: probe.confirmationText } : null;
    res.evidence = probe
      ? {
        formStillPresent: probe.formStillPresent,
        echoedSubmittedValue: probe.echoedSubmittedValue,
        validationError: probe.validationError,
        urlInConfirmationRegion: probe.urlInConfirmationRegion,
        positive: verdict.positive,
        negative: verdict.negative,
      }
      : { probe: 'unreadable' };
    // 名字沿用这个 adapter 原有的两个 state，其余直接用判据的 state。
    if (verdict.state === 'gated-captcha-on-confirm') res.state = 'challenge-on-next-step';
    else if (verdict.state === 'submitted-unconfirmed') res.state = 'advanced-unconfirmed';
    else res.state = verdict.state;
    // 提交后的落点也要一对现场：probe 是 DOM 证人，截图是像素证人。
    res.evidence = await sceneFor(res, `submit outcome: ${res.state}`);
  } catch (e) {
    // catch → state:'error' 必须带现场；标签页留着（本脚本从不 close）。
    res.state = 'error';
    res.error = String(e.message).slice(0, 160);
    res.evidence = await sceneFor(res, `caught: ${String(e.message).slice(0, 160)}`);
  }
  out.push(res);
  process.stderr.write(`${res.state.padEnd(24)} ${res.url}\n`);
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(out, null, 2) + '\n');
}
process.stderr.write('\n' + JSON.stringify(out.reduce((m, r) => ((m[r.state] = (m[r.state] || 0) + 1), m), {})) + '\n');
