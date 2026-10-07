/** Shared temporary ChatGPT page driver; OpenCLI uses the logged-in Chrome. */
import { opencliRun } from '../lib-opencli.mjs';

const SLD2 = new Set(['co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.cn', 'com.tw', 'co.kr', 'com.hk', 'com.sg', 'co.nz', 'com.mx', 'com.tr', 'co.za']);
// 多租户平台：子域名才是「一个产品」，不能折叠到主域
const MULTI_TENANT = ['itch.io', 'github.io', 'netlify.app', 'vercel.app', 'pages.dev', 'notion.site', 'substack.com', 'wordpress.com', 'blogspot.com', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'gitlab.io', 'onrender.com', 'fly.dev', 'replit.app', 'glitch.me'];

export function regDomain(input) {
  let host = String(input || '').trim().toLowerCase();
  if (!host) return '';
  try { host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname; } catch { /* keep */ }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_TENANT.includes(last2)) return parts.slice(-3).join('.');
  if (SLD2.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

export function oc(args, { timeoutS = 180, env = process.env } = {}) {
  // 统一走 lib-opencli 的 Windows 安全 spawn（裸 spawnSync('opencli') 在 Windows 上
  // 起不了 .cmd 壳，返回 ENOENT/EINVAL，所有 oc() 调用方全部静默失败——2026-10-07 实测）。
  try {
    const stdout = opencliRun(args, { env, encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, stdout: stdout || '', stderr: '', spawnError: null };
  } catch (e) {
    return {
      status: e.status ?? null,
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || e.message || '',
      spawnError: e.code || e.message || null,
    };
  }
}

/** opencli browser eval 的输出：字符串结果原样打印（一行 JSON），对象结果会被美化；两种都兼容 */
export function parseEvalJson(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  for (const cand of [t, t.split('\n').filter(Boolean).pop()]) {
    let v = tryParse(cand);
    if (typeof v === 'string') v = tryParse(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

export function classifyWebSend(text) {
  const t = String(text || '');
  if (/logged[- ]in|not logged|sign in|log in|login|unauthorized/i.test(t)) return 'auth';
  if (/rate.?limit|too many requests|usage limit|reached the limit/i.test(t)) return 'rate-limit';
  return 'send-failed';
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function browserCommand(web, args, options = {}) {
  const command = ['browser', web.session, ...args, '--window', process.env.AI_PROBE_WEB_WINDOW || 'dedicated'];
  if (!web.keepAlive || args[0] !== 'open') return oc(command, options);
  if (!web.legacyKeepAlive) {
    const result = oc([...command, '--keep-alive'], options);
    if (result.status === 0 || !/unknown option[^\n]*--keep-alive/i.test(result.stderr + result.stdout)) return result;
    web.legacyKeepAlive = true;
    console.error('[提示] OpenCLI 不支持 --keep-alive，退回旧版 24 小时保活；用完仍需 close。');
  }
  return oc(command, { ...options, env: { ...process.env, OPENCLI_BROWSER_IDLE_TIMEOUT: '86400' } });
}

/** 成功常驻可显式移交；其余退出及可捕获中断都关闭任务会话。 */
export function manageSession(web) {
  const cleanup = () => { if (web.opened && !web.retained) closeSession(web); };
  const interrupt = signal => { web.retained = false; cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('exit', cleanup);
  process.once('SIGINT', () => interrupt('SIGINT'));
  process.once('SIGTERM', () => interrupt('SIGTERM'));
}

export function closeSession(web) {
  const result = browserCommand(web, ['close'], { timeoutS: 30 });
  if (result.status === 0) web.opened = false;
  return result;
}

/** 已开路径已实测；未验证的模式切换停止，避免未确认状态下发送。 */
export function ensurePrivacySwitches(web) {
  const readState = (wait = false) => parseEvalJson(browserCommand(web, ['eval', `(async () => {
    if (${wait}) {
      const deadline = Date.now() + 10000;
      while ((!document.querySelector('[contenteditable="true"][role="textbox"]') || !document.querySelector('[data-testid="app-shell-header-context-menu-surface"] button[aria-haspopup="menu"]')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    }
    return JSON.stringify({
    mode:document.querySelector('[data-testid="app-shell-header-context-menu-surface"] button[aria-haspopup="menu"]')?.innerText.trim(),
    temporary:!!document.querySelector('button[aria-label="关闭临时聊天"]'),
    text:document.body.innerText
  });})()`], { timeoutS: 15 }).stdout);
  let state = readState();
  if (state?.temporary && state.mode === '个性化') {
    const switched = parseEvalJson(browserCommand(web, ['eval', `(async () => {
      const click = el => {
        const rect = el.getBoundingClientRect();
        const options = {bubbles:true,clientX:rect.x + rect.width / 2,clientY:rect.y + rect.height / 2,button:0,pointerType:'mouse',isPrimary:true};
        for (const type of ['pointerover','pointerenter','mouseover','pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, options));
      };
      const button = document.querySelector('[data-testid="app-shell-header-context-menu-surface"] button[aria-haspopup="menu"]');
      if (button?.innerText.trim() !== '个性化') return JSON.stringify({ok:false});
      click(button);
      await new Promise(resolve => setTimeout(resolve, 300));
      const item = [...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.innerText.trim().startsWith('不个性化'));
      if (!item) return JSON.stringify({ok:false});
      click(item);
      await new Promise(resolve => setTimeout(resolve, 300));
      return JSON.stringify({ok:true});
    })()`], { timeoutS: 15 }).stdout);
    if (switched?.ok && browserCommand(web, ['open', 'https://chatgpt.com/?temporary-chat=true'], { timeoutS: 30 }).status === 0) state = readState(true);
    else state = null;
  }
  const notice = (state?.text || '').split('\n').filter(line => /不会.*记忆|不.*使用.*记忆|won.t.*memor|doesn.t.*memor/i.test(line)).join('\n');
  if (!state?.temporary || !notice || state.mode !== '不个性化') {
    return { ...failedPage(web), ok: false, failure: 'privacy-switch',
      error: `隐私开关未确认：临时聊天=${!!state?.temporary && !!notice}，个性化模式=${state?.mode || '读不到'}；未发送问题。` };
  }
  web.temporaryNotice = notice;
  return { ok: true, mode: state.mode, temporaryNotice: notice };
}

export async function openSession({ web, timeoutS = 150 }) {
  const t0 = Date.now();
  const deadline = t0 + timeoutS * 1000;
  const browser = (...args) => browserCommand(web, args, { timeoutS: Math.max(1, Math.floor((deadline - Date.now()) / 1000)) });
  let notice = web.temporaryNotice || '';
  {
    web.opened = true;
    const opened = browser('open', 'https://chatgpt.com/?temporary-chat=true');
    if (opened.status !== 0) return { ...failedPage(web), ok: false, failure: 'page', error: (opened.stderr || opened.stdout).trim(), durationMs: Date.now() - t0 };
    for (;;) {
      const state = parseEvalJson(browser('eval', `JSON.stringify({text:document.body.innerText,ready:!!document.querySelector('[contenteditable="true"][role="textbox"]')})`).stdout);
      const text = state?.text || '';
      if (/验证码|captcha|verify you are human|too many requests|usage limit|reached the limit|达到.*上限/i.test(text)) return { ...failedPage(web), ok: false, failure: 'rate-limit', error: '临时页出现验证码或限流提示', durationMs: Date.now() - t0 };
      if (!state?.ready && /登录|log in|sign in/i.test(text)) return { ...failedPage(web), ok: false, failure: 'auth', error: '临时页出现登录门', durationMs: Date.now() - t0 };
      notice = text.split('\n').filter((line) => /不会.*记忆|不.*使用.*记忆|won.t.*memor|doesn.t.*memor/i.test(line)).join('\n');
      if (state?.ready) break;
      if (Date.now() >= deadline) return { ...failedPage(web), ok: false, failure: 'page', error: '未核对到临时对话不使用记忆提示', durationMs: Date.now() - t0 };
      await sleep(1000);
    }
    web.temporaryNotice = notice;
  }
  return { ...ensurePrivacySwitches(web), durationMs: Date.now() - t0 };
}

// 仅失败时读取可见文字；排除输入内容，简单缩短邮箱与长串，不读取凭据。
export function failedPage(web) {
  const page = parseEvalJson(browserCommand(web, ['eval', `JSON.stringify((() => {
    let text = document.body.innerText;
    for (const el of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      const value = el.innerText || el.value || '';
      if (value) text = text.replaceAll(value, '');
    }
    return {pageText:text.slice(0,1500),pageUrl:location.href};
  })())`], { timeoutS: 15 }).stdout);
  const redact = value => String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[A-Z0-9_=-]{32,}/gi, token => token.slice(0,8) + '…' + token.slice(-8));
  return { answer: '', cited: [], pageText: redact(page?.pageText), pageUrl: redact(page?.pageUrl) };
}

export async function sendTurn({ prompt, timeoutS, web, continuation = false, natural = false }) {
  const t0 = Date.now();
  const deadline = t0 + timeoutS * 1000;
  const browser = (...args) => browserCommand(web, args, { timeoutS: Math.max(1, Math.floor((deadline - Date.now()) / 1000)) });
  let notice = web.temporaryNotice || '';
  if (!continuation) {
    const opened = await openSession({ web, timeoutS });
    if (!opened.ok) return opened;
    notice = web.temporaryNotice;
  }
  const state = natural ? parseEvalJson(browser('eval', `JSON.stringify({count:document.querySelectorAll('[data-markdown-text-style="assistant-message"]').length,blocked:/验证码|captcha|verify you are human|too many requests|usage limit|reached the limit|达到.*上限/i.test(([...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')].reduce((t,a)=>t.split(a.innerText).join(''),document.body.innerText))),auth:!document.querySelector('[contenteditable="true"][role="textbox"]') && /登录|log in|sign in/i.test(document.body.innerText)})`).stdout) : null;
  if (state?.blocked || state?.auth) return { ...failedPage(web), ok: false, failure: state.auth ? 'auth' : 'rate-limit', error: '临时页出现登录、验证码或限流提示', durationMs: Date.now() - t0 };
  const before = state?.count || 0;
  for (const args of [['type', '[contenteditable="true"][role="textbox"]', prompt], ['click', 'button[aria-label="发送"]']]) {
    let r = browser(...args);
    // 多轮对话页可能同时存在两个 contenteditable 文本框；选择器歧义时改用 ChatGPT 输入框固定 id 重试一次。
    if (r.status !== 0 && /selector_ambiguous/.test(r.stderr || r.stdout || '') && args[0] === 'type') r = browser('type', '[contenteditable="true"][role="textbox"]', prompt, '--nth', '1');
    if (r.status !== 0) return { ...failedPage(web), ok: false, failure: classifyWebSend(r.stderr || r.stdout), error: (r.stderr || r.stdout).trim().slice(-300), durationMs: Date.now() - t0 };
  }
  while (Date.now() < deadline) {
    const r = browser('eval', `JSON.stringify((() => {
      const text = document.body.innerText;
      const answers = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
      const nonAnswer = answers.reduce((t,a)=>t.split(a.innerText).join(''),text);
      const answer = answers.pop();
      const busy = !!document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop"],button[aria-label*="停止"]');
      const links = answer ? [...answer.querySelectorAll('a[href^="http"]')].map(a => ({url:a.href,title:a.innerText,via:'dom-link'})) : [];
      return {text:answer?.innerText || '',count:answers.length + (answer ? 1 : 0),sources:!!answer && /sources|来源|搜索|searching|searched/i.test(answer.closest('article')?.innerText || answer.innerText),links,busy,blocked:/验证码|captcha|verify you are human|too many requests|usage limit|reached the limit|达到.*上限/i.test(nonAnswer),blockedHit:(nonAnswer.match(/.{0,50}(验证码|captcha|verify you are human|too many requests|usage limit|reached the limit|达到.*上限).{0,50}/i)||[''])[0],auth:!document.querySelector('[contenteditable="true"][role="textbox"]') && /登录|log in|sign in/i.test(text),model:document.querySelector('button[aria-label="选择 ChatGPT 模型"]')?.innerText || null};
    })())`);
    const got = parseEvalJson(r.stdout);
    if (got?.blocked || got?.auth) return { ...failedPage(web), ok: false, failure: got.auth ? 'auth' : 'rate-limit', error: '临时页出现登录、验证码或限流提示 | hit=' + JSON.stringify(got.blockedHit||'') + ' auth=' + got.auth, durationMs: Date.now() - t0 };
    if (got?.text && !got.busy && (natural ? got.count > before : got.text.includes('---PROBE---'))) {
      const cited = [...new Map(got.links.map(c => [c.url, {...c, domain:regDomain(c.url)}])).values()];
      return { ok: true, answer:got.text, text:got.text, failure:null, pageText:'', cited, searched:got.sources || cited.length > 0, durationMs:Date.now()-t0,
        web:{is_temporary_chat:true,temporaryNotice:notice,memory_scope:null,model:got.model,conversationUrl:'https://chatgpt.com/?temporary-chat=true',citedCount:cited.length,payloadVerified:false},
        ev:{searches:cited.length ? [{queries:[],preSited:false,resultCount:cited.length}] : [],retrieved:[],usage:null} };
    }
    await sleep(Math.min(3000, Math.max(0, deadline-Date.now())));
  }
  return { ...failedPage(web),ok:false,failure:'timeout',error:`临时对话在 ${timeoutS} 秒内未读到完整回答`,durationMs:Date.now()-t0 };
}

