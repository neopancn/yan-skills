/**
 * lib-evidence-scene.mjs — 失败/落点现场的双证人一次落盘（2026-08-30 双证人化，
 * 截图链路已实盘验证：真 Chrome 上 census+png 成对落盘，判决书见
 * backlink/evidence/screenshot-chain-VERDICTS.md）。
 *
 * 契约对齐 ground-truth.mjs：一个停留位置 = 一份穿透 shadow DOM 的 census
 * （含 href/title/scroll，已剥敏）+ 一张视口截图，成对落盘。任何浏览器脚本的
 * 失败分支在退出前调 `captureScene()`，AI 事后拿两个证人对质——脚本只采集，
 * 不判断。
 *
 * 三条设计红线：
 *   1. **绝不反噬调用方。** captureScene 自身永不 throw；census 或截图任何一半
 *      失败都记进返回记录（censusError / screenshotError），另一半照常尝试。
 *   2. **统一剥敏。** census 落盘前整体过 scrubEvalPayload（ground-truth 的
 *      那一份），href 过 sanitizeUrlString；错误消息过 redactSecrets。
 *   3. **census 表达式只有一份**，直接复用 ground-truth.mjs 的 CENSUS_EXPR——
 *      两份表达式必然漂移，漂移后的「双证人」只是两个不同的证人。
 *
 * 用法（两种调用形态，覆盖仓库里两类脚本）：
 *
 *   // tools-share 脚本：已有 launched.evalPage
 *   const scene = await captureScene({
 *     session, outDir, tag: 'values-never-settled',
 *     evalPage: launched.evalPage, env: launched.env,
 *   });
 *
 *   // 裸 opencli 脚本：只有会话名
 *   const scene = await captureScene({ session, outDir, tag: 'state-error' });
 *
 * 返回 SceneRecord：
 *   { tag, capturedAt, dir, censusFile, shotFile, href, title, filledCells,
 *     deepTextLength, censusError, screenshotError }
 * 文件名：scene-<tag>-census.json / scene-<tag>.png（tag 会被安全化）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { firstJson, opencli } from './opencli-core.mjs';
import { CENSUS_EXPR, SENSITIVE_PARAM, sanitizeUrlString, scrubEvalPayload } from './ground-truth.mjs';

/**
 * 错误消息的剥敏：redactSecrets（__gmitm/工具令牌）+ scrubEvalPayload
 * （cookie/authorization/bearer）之外，再把 `token=…` 这类敏感键值对整个遮掉
 * ——opencli 报错会把完整 URL 带进 message，历史事故（2026-08-24）就在这里。
 */
export function scrubErrorText(text) {
  return scrubEvalPayload(String(text ?? ''))
    .replace(/\b([\w-]*[\w])=([^\s&"'!,;]+)/g, (m, key, value) => (SENSITIVE_PARAM.test(key) ? `${key}=[REDACTED]` : m));
}

/** tag 安全化：只留 [a-z0-9._-]，其余折成 '-'；空 tag 落成 'scene'。 */
export function sanitizeSceneTag(tag) {
  const cleaned = String(tag ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'scene';
}

/** 一个场景的文件名对（纯函数，测试直接断言）。 */
export function sceneFileNames(tag) {
  const safe = sanitizeSceneTag(tag);
  return { censusFile: `scene-${safe}-census.json`, shotFile: `scene-${safe}.png` };
}

/**
 * 采集一处现场。永不 throw；outDir 会被创建。
 *
 * options:
 *   session      opencli 会话名（截图必需；evalPage 缺省时 census 也用它）
 *   outDir       证据目录
 *   tag          场景名（进文件名，会被安全化）
 *   evalPage     可选，(expression[, timeoutMs]) => parsed JSON；tools-share 的
 *                launched.evalPage 直接传入
 *   env          可选，传给 opencli 的环境（tools-share 的 launched.env）
 *   windowMode   可选，dedicated（默认）/ foreground（显式人工操作）
 *   timeoutMs    可选，单命令超时（默认 60s）
 *   note         可选，一句话说明为什么在这里取证（原样写进 census 文件顶层）
 *   screenshot   测试注入口：async (absPath) => void，缺省走 opencli screenshot
 */
export async function captureScene({
  session,
  outDir,
  tag,
  evalPage = null,
  env = {},
  windowMode = 'dedicated',
  timeoutMs = 60_000,
  note = null,
  screenshot = null,
} = {}) {
  const { censusFile, shotFile } = sceneFileNames(tag);
  const record = {
    tag: sanitizeSceneTag(tag),
    capturedAt: new Date().toISOString(),
    dir: outDir ? path.resolve(outDir) : null,
    censusFile: null,
    shotFile: null,
    href: null,
    title: null,
    filledCells: null,
    deepTextLength: null,
    censusError: null,
    screenshotError: null,
  };
  if (!outDir) {
    record.censusError = 'no outDir given';
    record.screenshotError = 'no outDir given';
    return record;
  }
  try { mkdirSync(outDir, { recursive: true }); } catch (error) {
    record.censusError = scrubErrorText(error?.message || String(error)).slice(0, 300);
    record.screenshotError = record.censusError;
    return record;
  }

  // DOM 证人。
  try {
    const doEval = evalPage
      || (async (expression) => firstJson(
        (await opencli(['browser', session, 'eval', expression], { env, windowMode, timeoutMs })).stdout,
      ));
    const capture = await doEval(CENSUS_EXPR, timeoutMs);
    capture.href = sanitizeUrlString(capture.href);
    const payload = note ? { note, ...capture } : capture;
    writeFileSync(
      path.join(outDir, censusFile),
      `${scrubEvalPayload(JSON.stringify(payload, null, 2))}\n`,
    );
    record.censusFile = censusFile;
    record.href = capture.href ?? null;
    record.title = capture.title ?? null;
    record.filledCells = capture.census?.deep?.filledCells ?? null;
    record.deepTextLength = capture.census?.deep?.textLength ?? null;
  } catch (error) {
    record.censusError = scrubErrorText(error?.message || String(error)).slice(0, 300);
  }

  // 像素证人。census 失败也照拍——半个证人好过没有证人。
  try {
    const shotPath = path.join(outDir, shotFile);
    if (screenshot) await screenshot(shotPath);
    else if (session) await opencli(['browser', session, 'screenshot', shotPath], { env, windowMode, timeoutMs });
    else throw new Error('no session for screenshot');
    record.shotFile = shotFile;
  } catch (error) {
    record.screenshotError = scrubErrorText(error?.message || String(error)).slice(0, 300);
  }
  return record;
}

/**
 * 把一条 SceneRecord 压成一句可以拼进 Error.message 的话（已剥敏的路径与状态）。
 * 失败分支的错误消息必须带证据路径——「一句结论文案」正是这轮重构要杀的形态。
 */
export function sceneSummaryLine(record) {
  if (!record) return '现场取证未执行';
  const parts = [];
  if (record.censusFile) parts.push(`census=${path.join(record.dir || '', record.censusFile)}`);
  else parts.push(`census失败(${record.censusError || 'unknown'})`);
  if (record.shotFile) parts.push(`shot=${path.join(record.dir || '', record.shotFile)}`);
  else parts.push(`截图失败(${record.screenshotError || 'unknown'})`);
  return `现场证据：${parts.join(' ')}`;
}

/**
 * 缺省证据目录：有 --out 就贴着输出文件（`x.json.evidence/`，同
 * lib-batch-evidence 的约定），否则进 `.backlink/evidence/<script>/<runTag>`
 * （`.backlink/` 与 `backlink/evidence/` 都在 .gitignore 里，不入库）。
 */
export function defaultSceneDir({ out = null, script, runTag = null } = {}) {
  if (out) return `${out}.evidence`;
  const stamp = runTag || new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('.backlink', 'evidence', String(script || 'scene'), stamp);
}
