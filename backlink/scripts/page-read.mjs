#!/usr/bin/env node
/**
 * page-read.mjs — 渲染任意公开页面，取回正文、价格、导航链接。
 *
 * 用途是**竞品产品勘测**：对手卖什么、怎么收费、付费墙长什么样、产品目录有多少个。
 * 这类判断的证据只在对手自己的页面上，任何 SEO 工具都查不到。
 *
 * 和已有脚本的分工，别用错：
 *   - inspect-page.mjs  → 扫**表单**，为提交目录/发评论服务，输出的是字段和选择器；
 *   - 本脚本            → 读**内容**，输出的是正文、价格、链接，不碰任何输入框。
 *
 * 为什么不用 curl：这类站基本都是 SPA，`curl | grep` 拿到的是一个空壳。必须让浏览器渲染。
 *
 * 只读公开页面，不登录、不填表、不点任何会产生副作用的按钮。
 *
 * 用法：
 *   node page-read.mjs --url https://example.com/pricing [--wait 6] [--links /plan] [--out x.json]
 *
 * 2026-08-30 双证人化：旧的 `paywallShape` 四个布尔是脚本结论（正则命中与否），
 * 已改为 `paywallSignals`——每类给出**命中的原文片段 + 前后文**（matched spans），
 * 没命中是空数组；「这家到底是买断还是订阅」由 AI 拿片段 + 截图判。
 * 读完 captureScene（穿透 census + 截图）落进 --evidence-dir，输出带 evidence；
 * 读取失败也先取证再抛。截图链路已实盘验证。
 */
import { writeFile } from 'node:fs/promises';
import { defaultSession, openAndEval, parseFlags, printJson, required, validateSession, showHelpIfRequested} from './opencli-core.mjs';
import { captureScene, defaultSceneDir, sceneSummaryLine } from './lib-evidence-scene.mjs';

const flags = parseFlags(process.argv.slice(2));
showHelpIfRequested(flags, import.meta.url);
const url = new URL(required(flags, 'url'));
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are supported.');
const session = flags.session ? validateSession(flags.session) : defaultSession('page-recon');
const waitSeconds = Math.max(1, Math.min(30, Number(flags.wait || 6)));
// --window foreground 仅供需要人工登录、验证码或亲自查看时显式使用。
const env = { OPENCLI_WINDOW: flags.window || process.env.OPENCLI_WINDOW || 'dedicated' };
const linkFilter = typeof flags.links === 'string' ? new RegExp(flags.links, 'i') : null;
const maxChars = Math.max(500, Math.min(60_000, Number(flags.chars || 8000)));

// 各市场的货币写法。日元和韩元最常见的坑是数字和符号中间有全角空格，
// 以及日文页面把价格写成「￥3,990」而不是「¥3990」。
const PRICE_PATTERNS = [
  ['JPY', String.raw`[¥￥]\s*[0-9][0-9,]*|[0-9][0-9,]*\s*円`],
  ['KRW', String.raw`[0-9][0-9,]*\s*원|₩\s*[0-9][0-9,]*`],
  ['USD', String.raw`\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?`],
  ['EUR', String.raw`€\s*[0-9][0-9,]*(?:[.,][0-9]{2})?`],
  ['CNY', String.raw`[0-9][0-9,]*\s*元(?!素|气|旦)`],
];

const evalExpression = `(() => {
    const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
    return JSON.stringify({
      url: location.href,
      title: document.title,
      description: document.querySelector('meta[name=description]')?.content || null,
      textLength: text.length,
      text: text.slice(0, ${maxChars}),
      links: [...document.querySelectorAll('a[href]')].map((a) => ({
        href: a.getAttribute('href'),
        text: (a.innerText || '').trim().slice(0, 60),
      })).filter((l) => l.href && !l.href.startsWith('javascript:')).slice(0, 200),
    });
  })()`;

const evidenceDir = typeof flags['evidence-dir'] === 'string'
  ? flags['evidence-dir']
  : defaultSceneDir({ out: typeof flags.out === 'string' ? flags.out : null, script: 'page-read' });

let evalResult;
try {
  evalResult = await openAndEval(session, url.href, evalExpression, {
    wait: waitSeconds,
    windowMode: env.OPENCLI_WINDOW,
    timeoutMs: 120_000,
  });
} catch (error) {
  // **先取证后死**：读不出来的那一刻页面长什么样（403 页？CAPTCHA 页？白屏？），
  // 只有此刻拍得到。captureScene 永不 throw。
  const scene = await captureScene({
    session, outDir: evidenceDir, windowMode: env.OPENCLI_WINDOW, tag: 'read-failed',
    note: `page-read ${url.href}: ${String(error?.message || error).slice(0, 200)}`,
  });
  error.message = `${error.message} ${sceneSummaryLine(scene)}`;
  throw error;
}
const captured = typeof evalResult === 'string' ? JSON.parse(evalResult) : evalResult;

const prices = {};
for (const [currency, pattern] of PRICE_PATTERNS) {
  const hits = [...new Set(captured.text.match(new RegExp(pattern, 'g')) || [])];
  if (hits.length) prices[currency] = hits.slice(0, 30);
}

// 付费墙**信号**（不是结论）：每类正则给出命中的原文片段 + 前后各 40 字的上下文。
// 旧版输出四个布尔（oneTime/subscription/…），那是脚本替 AI 下的判决——「頁面
// 提到 free trial」和「这家提供 free trial」不是一回事，命中片段和截图才是证据。
const PAYWALL_PATTERNS = {
  oneTime: /都度購入|買い切り|一次性|단건|단품|one[- ]time|single purchase/gi,
  subscription: /サブスクリプション|定期購読|月額|年額|구독|정기결제|subscription|per month|\/mo\b/gi,
  freeTrial: /無料体験|無料お試し|무료 ?체험|free trial/gi,
  refund: /返金|환불|refund|money[- ]back/gi,
};
const paywallSignals = {};
for (const [kind, re] of Object.entries(PAYWALL_PATTERNS)) {
  const spans = [];
  for (const m of captured.text.matchAll(re)) {
    if (spans.length >= 8) break;
    spans.push({
      matched: m[0],
      context: captured.text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim(),
    });
  }
  paywallSignals[kind] = spans;
}

// 第二证人：census + 截图。价格与付费墙的判断由 AI 拿片段对着截图做。
const scene = await captureScene({
  session, outDir: evidenceDir, windowMode: env.OPENCLI_WINDOW, tag: 'page-read',
  note: `page-read ${url.href}`,
});

const output = {
  version: 1,
  source: 'Rendered public page via OpenCLI browser session',
  retrievedAt: new Date().toISOString(),
  requestedUrl: url.href,
  session,
  finalUrl: captured.url,
  title: captured.title,
  description: captured.description,
  textLength: captured.textLength,
  truncated: captured.textLength > maxChars,
  prices,
  paywallSignals,
  evidence: scene,
  links: linkFilter ? captured.links.filter((l) => linkFilter.test(l.href) || linkFilter.test(l.text)) : captured.links,
  text: captured.text,
};

if (typeof flags.out === 'string') await writeFile(flags.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
printJson({ ...output, text: `${output.text.slice(0, 600)}${output.truncated ? ' …[截断，全文见 --out 文件]' : ''}` });
