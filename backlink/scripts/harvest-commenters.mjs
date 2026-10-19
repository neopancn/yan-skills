#!/usr/bin/env node
/**
 * harvest-commenters.mjs — 从一篇文章页收割评论者外链域名。
 *
 * 2026-08-30 双证人化：
 *   - open + 等待 + 提取合并为一次 openAndEval 原子 batch（旧版的
 *     `wait time N` 在 opencli 1.8.7 是坏的——报了秒数但不到 1 秒就返回，
 *     见 opencli-core.mjs 的 sleepStep 注释；openAndEval 用的是页面内真睡眠）；
 *   - 采完 captureScene（穿透 census + 截图）落进 --evidence-dir，输出带 evidence；
 *   - 落点自检：提取到的 sourceUrl 的 host 与请求 host 不一致时记
 *     `hijackSuspected: true`（事实字段，共享标签页被别的工作流接管的形态，
 *     判断交给 AI 对质现场）；
 *   - 失败也先取证再抛，错误消息带证据路径。截图链路已实盘验证。
 */
import { defaultSession, openAndEval, parseFlags, printJson, required, validateSession, showHelpIfRequested } from './opencli-core.mjs';
import { captureScene, defaultSceneDir, sceneSummaryLine } from './lib-evidence-scene.mjs';

const flags = parseFlags(process.argv.slice(2));
showHelpIfRequested(flags, import.meta.url);
const session = flags.session ? validateSession(flags.session) : defaultSession('backlink-discovery');
const url = new URL(required(flags, 'url'));
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are supported.');
// --window foreground 仅供需要人工登录、验证码或亲自查看时显式使用。
const windowMode = flags.window || process.env.OPENCLI_WINDOW || 'dedicated';
const waitSeconds = Math.max(0, Math.min(15, Number(flags.wait || 3)));
const evidenceDir = typeof flags['evidence-dir'] === 'string'
  ? flags['evidence-dir']
  : defaultSceneDir({ out: typeof flags.out === 'string' ? flags.out : null, script: 'harvest-commenters' });

const EXTRACT = `(() => {
  const pageHost = location.hostname.replace(/^www\\./, '');
  const containers = [...document.querySelectorAll('#comments,.comments,.comment-list,.commentlist,[class*="comment-list" i],[id*="comment-list" i],[data-testid*="comment" i],article')];
  const roots = containers.length ? containers : [document.body];
  const links = [];
  for (const root of roots) {
    for (const anchor of root.querySelectorAll('a[href]')) {
      try {
        const url = new URL(anchor.href, location.href);
        const domain = url.hostname.replace(/^www\\./, '');
        if (!['http:', 'https:'].includes(url.protocol) || !domain || domain === pageHost) continue;
        if (/facebook|twitter|x\\.com|instagram|linkedin|youtube|gravatar|wordpress\\.org|google/i.test(domain)) continue;
        links.push({ domain, url: url.toString().split('#')[0], rel: anchor.rel || null });
      } catch {}
    }
  }
  const unique = [...new Map(links.map((entry) => [entry.domain + '|' + entry.url, entry])).values()];
  return JSON.stringify({
    sourceUrl: location.href,
    sourceDomain: pageHost,
    discoveredAt: new Date().toISOString(),
    candidateDomains: [...new Set(unique.map((entry) => entry.domain))],
    links: unique
  });
})()`;

let result;
try {
  const evaluated = await openAndEval(session, url.toString(), EXTRACT, {
    wait: waitSeconds,
    windowMode,
    timeoutMs: 120_000,
  });
  result = typeof evaluated === 'string' ? JSON.parse(evaluated) : evaluated;
} catch (error) {
  // **先取证后死**：提取失败（导航超时、eval 崩、空返回）的那一刻页面长什么样，
  // 只有此刻拍得到。captureScene 永不 throw。
  const scene = await captureScene({
    session, outDir: evidenceDir, windowMode, tag: 'extract-failed',
    note: `harvest-commenters ${url.toString()}: ${String(error?.message || error).slice(0, 200)}`,
  });
  error.message = `${error.message} ${sceneSummaryLine(scene)}`;
  throw error;
}

// 落点自检（事实，不是判决）：同名会话共享标签页，别的工作流可以在 batch 之间
// open 自己的 URL。host 对不上时这批「评论者域名」多半采自别人的页面。
const landedHost = (() => { try { return new URL(result.sourceUrl).hostname.replace(/^www\./, ''); } catch { return null; } })();
const requestedHost = url.hostname.replace(/^www\./, '');
const hijackSuspected = landedHost !== null && landedHost !== requestedHost;
if (hijackSuspected) {
  console.error(`[hijack?] 请求 ${requestedHost}，提取时页面在 ${landedHost}——共享标签页可能被别的工作流接管，这批域名先别入库，对质 evidence 再定。`);
}

// 成功也留一对现场：0 个候选域名是「页面真没有评论区外链」还是「评论区没渲染」，
// 只有对着截图才分得开。
const scene = await captureScene({
  session, outDir: evidenceDir, windowMode, tag: 'harvested',
  note: `harvest-commenters ${url.toString()}: ${result.candidateDomains?.length ?? 0} candidate domains`,
});

const output = { session, requestedUrl: url.toString(), hijackSuspected, evidence: scene, ...result };
if (typeof flags.out === 'string') {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(flags.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}
printJson(output);
