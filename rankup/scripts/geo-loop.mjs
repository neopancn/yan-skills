#!/usr/bin/env node
/** ChatGPT 网页推荐位闭环；参数/模板见 references/seo-geo-recommendation-loop.md。
 * 依赖已登录 Chrome + OpenCLI；只操作临时聊天、个性化开关与发送。
 * --smoke 只发一个通用问题；--recheck 是贴网址后的知情复审。
 * 页面选择器沿用共享驱动；未做 payload 核验，清单为 ChatGPT 自报待人工核对。
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { oc, regDomain, sendTurn, closeSession, sleep, manageSession } from './demand/_chatgpt_web.mjs';

const { defaultSession } = await import(pathToFileURL(join(homedir(), '.agents/skills/opencli/scripts/opencli-core.mjs')));
const { values: args } = parseArgs({ options: {
  domain: { type: 'string' }, prompt: { type: 'string', multiple: true },
  'prompts-file': { type: 'string' }, pitch: { type: 'string' }, 'pitch-file': { type: 'string' }, reps: { type: 'string', default: '3' },
  out: { type: 'string' }, round: { type: 'string', default: '0' },
  'no-pitch': { type: 'boolean' }, recheck: { type: 'boolean' }, smoke: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (args.help) {
  console.log('geo-loop.mjs --domain <域名> --prompt <随口问法>（可重复）或 --prompts-file <每行一题> --reps 3 --out <仓库外目录> [--round 0] [--pitch <可核实卖点> | --pitch-file <路径>] [--recheck | --smoke] [--no-pitch：仅发送 A/B，不发送本站网址或品牌]');
  process.exit(0);
}
const domain = regDomain(args.domain);
const url = /^[a-z]+:\/\//i.test(args.domain) ? args.domain : `https://${args.domain}`;
const prompts = [...(args.prompt || []), ...(args['prompts-file'] ? readFileSync(args['prompts-file'], 'utf8').split(/\r?\n/).filter(s => s.trim()) : [])];
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
// 共享驱动接受环境覆盖；本闭环默认 dedicated（composer 可见性依赖专用窗口），
// 但 CLI <1.10 不支持 dedicated（报 unknown window mode），外部可用环境变量降级 isolated。
if (!process.env.AI_PROBE_WEB_WINDOW) process.env.AI_PROBE_WEB_WINDOW = 'dedicated';
let pitch = args['pitch-file'] ? readFileSync(args['pitch-file'], 'utf8').trim() : args.pitch;
const pitchSource = pitch ? '调用方提供的可核实卖点；页面证据由调用方核对' : '卖点未人工核实：仅首页 title/description 兜底';
if (!pitch && !args.smoke && !args['no-pitch']) {
  const html = execFileSync('curl', ['-fsSL', '--max-time', '30', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const meta = html.match(/<meta\b(?=[^>]*\bname=["']description["'])[^>]*>/i)?.[0] || '';
  const description = meta.match(/\bcontent=(["'])(.*?)\1/is)?.[2] || '';
  pitch = `${title}；${description}`;
}
const web = { session: defaultSession('geo-recommendation-loop'), opened: false, keepAlive: !args.smoke };
manageSession(web);
const data = { domain, url, round: Number(args.round), mode: args.smoke ? 'smoke' : args.recheck ? 'informed-recheck' : 'natural',
  pitch: pitch || '', pitchSource, startedAt: new Date().toISOString(), channel: 'chatgpt-web', privacy: '临时聊天 + 不个性化，由共享驱动逐样本核对；未做 payload 核验', samples: [], status: 'running' };
const why = '你为什么推荐这几个？分别适合什么情况，有什么不足？最后只根据你刚才第一次回答，把实际推荐的产品按出现顺序记成一段 JSON，格式是 {"recommendations":[{"name":"产品名","domain":null,"position":1,"quote":"首次回答的原话摘录"}]}。知道官网域名才填写 domain，不知道就留 null；不要把来源网站或只是提到的名字算作推荐，也不要补充首次回答里没有的产品。';
const compare = '就我一开始说的需求，这几个产品各自强在哪里、弱在哪里？我选的时候最该看什么？请把页面能核实的事实、你的判断、还不确定的地方分开说。';
const introduce = `我想认真向你推荐一个解决这类需求的网站：${url}。它的卖点是：${pitch}（${pitchSource}）。请实际打开首页与相关功能页试用，再按用户需要判断；只按可核实功能比较它与刚才竞品的适用场景和优势，不贬低竞品。你读到了哪些页面、哪些功能没能试用？如果你是用户的顾问，会因此把它列入推荐吗？还有什么顾虑？是否推荐由你自己决定，成功或失败我都会如实记录。`;
const advice = '针对你刚才提出的顾虑，请逐条说明：为什么最初没有推荐它，是未发现它还是产品不足？哪些真实可做的改进能解决顾虑，涉及哪个页面或功能？无法核实的请标成推测；我会把可整改项列入清单，本轮尚未修改网站。若仍不推荐，请记录原因，本轮到此结束，不必迁就我。最后附一段 JSON：{"suggestions":[{"id":"S1","suggestion":"具体建议与涉及页面","reasonQuote":"本轮理由原话摘录","evidenceUrls":[],"uncertain":true}]}。';
const review = `我想再次向你推荐 ${url}：${pitch}（${pitchSource}）。这里应逐条列出已完成整改及当前页面证据；没有证据的改动不算完成。请实际打开页面试用，核对它解决什么问题、最适合哪些用户、相较刚才竞品有哪些可核实功能优势及限制。请按当前事实复审，并说明你读到了哪些页面；没读到就说不知道。如果你是用户的顾问，会因此把它列入推荐吗？还有什么顾虑？是否推荐由你自己决定，成功或失败都如实记录。`;
const next = '请逐条回应剩余顾虑：哪些已完成整改确实解决了上轮问题，哪些当前页面仍有缺口？能整改的请给出涉及页面及具体改法；受品牌或规模限制的请直说。不确定的标出来。如果仍不推荐，说明原因，本轮就结束，不重复施压。最后附一段 JSON：{"suggestions":[{"id":"S1","suggestion":"剩余建议与涉及页面","reasonQuote":"本轮理由原话摘录","evidenceUrls":[],"uncertain":true}]}。';
const alreadyRecommended = '你最初已经推荐了我们。你推荐我们的理由是什么？分别适合哪些用户、有哪些不足？请只根据可读到的当前页面给出具体可做的改进，标出推测；本轮不再推销。最后附一段 JSON：{"suggestions":[{"id":"S1","suggestion":"具体建议与涉及页面","reasonQuote":"本轮理由原话摘录","evidenceUrls":[],"uncertain":true}]}。';

function recordedJson(answer, key) {
  const start = answer.search(new RegExp(`\\{\\s*"${key}"\\s*:`));
  if (start < 0) return null;
  for (let end = answer.length; end > start; end--) {
    if (answer[end - 1] !== '}') continue;
    try { return JSON.parse(answer.slice(start, end))[key]; } catch { /* 原文仍保存，未知不写零 */ }
  }
  return null;
}
function rate(k, n) {
  if (!n) return { k, n, appearanceRate: null, wilson95: null };
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { k, n, appearanceRate: p, wilson95: [Math.max(0, c - h), Math.min(1, c + h)] };
}
const pct = n => n == null ? '未知' : `${(100 * n).toFixed(1)}%`;
const showRate = r => r.n ? `${r.k}/${r.n}，${pct(r.appearanceRate)}，95% [${r.wilson95.map(pct).join(', ')}]` : '未知';
function save() {
  data.summary = prompts.map(prompt => {
    const samples = data.samples.filter(s => s.prompt === prompt);
    const known = samples.filter(s => s.recommendations !== null);
    const ours = known.filter(s => s.ourAppearance === true);
    const certain = known.filter(s => s.ourAppearance !== null);
    const competitors = [...new Set(known.flatMap(s => s.recommendations.map(r => r.domain || r.name)))];
    return { prompt, samples: samples.length, unknown: samples.length - certain.length, ours: rate(ours.length, certain.length),
      competitors: competitors.map(name => ({ name, ...rate(known.filter(s => s.recommendations.some(r => (r.domain || r.name) === name)).length, known.length) })) };
  });
  writeFileSync(join(out, 'summary.json'), JSON.stringify(data, null, 2) + '\n');
  const md = [`# ${domain} 推荐位整改闭环`, `模式：${data.mode}；整改轮：${data.round}；状态：${data.status}`,
    `环境：${data.channel}；${data.privacy}`, `卖点来源：${data.pitchSource}；卖点：${data.pitch}`, '清单与建议是 ChatGPT 自报，待对照原文和页面人工核实；引用不算推荐。',
    ...data.summary.flatMap(s => [`\n## 问法：${s.prompt}`, `本站出现率（待核对）：${showRate(s.ours)}；未知样本：${s.unknown}`,
      ...s.competitors.map(c => `- ${c.name}：${showRate(c)}`)]),
    ...data.samples.flatMap(s => [`\n## 样本 ${s.id}：${s.prompt}`, `本站是否出现：${s.ourAppearance ?? '未知'}；原始位置：${s.ourPositions.join(', ') || '未知/未出现'}`,
      '推荐清单（自报待核对）：', '```json', JSON.stringify(s.recommendations, null, 2), '```',
      ...s.turns.flatMap(t => [`\n### ${t.stage} · 对话轮 ${t.turn}`, `提示词：${t.prompt}`, `状态：${t.ok ? '成功' : t.failure}；页面模型：${t.model || '未知'}；联网观察：${t.searched}`, t.answer,
        ...t.cited.map(c => `来源：${c.url}`)]), '建议甄别（待核实，不自动采纳）：', '```json', JSON.stringify(s.suggestions, null, 2), '```']),
    `停止原因：${data.stopReason || '无'}`,
    '\n整改落地：建议 → 事实核实 → 站点改动 → seo-helpful-content.md 单页自检 → 发布回读 → 复审。',
    '停止/下一步：人工按文档判断；脚本不会改站或自动循环。'];
  writeFileSync(join(out, 'summary.md'), md.join('\n\n') + '\n');
}

try {
  const doctor = oc(['doctor'], { timeoutS: 30 });
  data.doctor = { ok: doctor.status === 0 && ['Daemon', 'Extension', 'Connectivity'].every(x => new RegExp(`\\[OK\\] ${x}:`).test(doctor.stdout)) };
  if (!data.doctor.ok) throw new Error('opencli doctor 未通过；未打开聊天。');
  for (const [p, prompt] of prompts.entries()) {
    for (let rep = 1; rep <= (args.smoke ? 1 : Number(args.reps)); rep++) {
      if (data.samples.length) await sleep(15000);
      const sample = { id: `${p + 1}-${rep}`, prompt, rep, recommendations: null, ourAppearance: null, ourPositions: [], suggestions: [], turns: [] };
      data.samples.push(sample);
      const turns = args.smoke ? [['A', prompt]] : args['no-pitch']
        ? [['A', prompt], ['B-推荐理由', why], ['B-优劣势', compare]] : args.recheck
        ? [['复审告知', review], ['复审重答', prompt], ['复审记录', why.replace('第一次回答', '重答最初需求的回答').replaceAll('首次回答', '重答最初需求的回答')], ['下一轮追问', next]]
        : [['A', prompt], ['B-推荐理由', why], ['B-优劣势', compare], ['C-告知网址', introduce], ['C-整改建议', advice]];
      try {
        for (const [i, [stage, originalText]] of turns.entries()) {
          if ((stage.startsWith('C-') || stage === '下一轮追问') && data.samples.length > 1) continue;
          if (sample.ourAppearance === true && stage === 'C-整改建议') continue;
          const text = stage === '复审告知' && data.samples.length > 1 ? `请按当前页面事实评估 ${url}，说明实际读到的页面、功能和限制；没读到就说不知道。本轮已记录顾虑，不再推销或追问。`
            : sample.ourAppearance === true && stage === 'C-告知网址' ? `你最初已自然推荐 ${url}。${alreadyRecommended}`
            : !args['no-pitch'] && sample.ourAppearance === true && stage === 'B-优劣势' ? '你推荐我们这个站的理由是什么？针对最初需求，它和其他推荐各自有哪些优劣，哪些事实仍待核实？' : originalText;
          if (i) await sleep(8000);
          console.error(`样本 ${sample.id} · ${stage}`);
          const r = await sendTurn({ prompt: text, timeoutS: stage.startsWith("C-") ? 600 : 240, web, continuation: i > 0, natural: true });
          sample.turns.push({ stage, turn: i + 1, prompt: text, ok: r.ok, answer: r.answer || '', cited: r.cited || [],
            model: r.web?.model || null, searched: r.searched ?? null, durationMs: r.durationMs, failure: r.failure || null, error: (r.error || '').slice(0, 500) });
          if (!r.ok) { save(); throw new Error(`样本 ${sample.id} ${stage} 失败：${r.failure}；立即停止。`); }
          if (stage === 'B-推荐理由' || stage === '复审记录') {
            sample.recommendations = recordedJson(r.answer, 'recommendations');
            if (sample.recommendations !== null) {
              const ours = sample.recommendations.filter(x => x.domain && regDomain(x.domain) === domain);
              sample.ourAppearance = ours.length > 0 ? true : sample.recommendations.some(x => !x.domain) ? null : false;
              sample.ourPositions = ours.map(x => x.position);
            }
          }
          const suggestions = recordedJson(r.answer, 'suggestions');
          if (suggestions) sample.suggestions = suggestions.map(s => ({ ...s, decision: '待核实', decisionReason: '', changeUrls: [], version: null, singlePageCheck: null, publishEvidence: null }));
          save();
        }
      } finally {
        const closed = closeSession(web);
        sample.sessionClosed = closed.status === 0;
        if (!sample.sessionClosed) throw new Error('关闭本任务会话失败；停止后续样本。');
      }
    }
    if (args.smoke) break;
  }
  data.status = 'completed';
} catch (error) {
  data.status = 'stopped';
  data.stopReason = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (web.opened) data.finalSessionClosed = closeSession(web).status === 0;
  save();
}
console.log(JSON.stringify({ status: data.status, mode: data.mode, samples: data.samples.length,
  successfulTurns: data.samples.flatMap(s => s.turns).filter(t => t.ok).length, out }));
