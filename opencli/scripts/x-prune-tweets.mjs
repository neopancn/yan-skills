#!/usr/bin/env node
/**
 * x-prune-tweets.mjs —— 删除自己 X 账号「某日期之后」的全部帖子，可断点续跑。
 *
 * 用法：
 *   node x-prune-tweets.mjs --profile <ctxId> --cutoff YYYY-MM-DD --account <handle> \
 *        [--limit N] [--interval 6] [--passes 2] [--keep-retweets] [--dry-run] \
 *        [--state <path>] [--seed <tweets.json>] [--write-window dedicated]
 *
 * 参数：
 *   --profile   持有该 X 登录态的 Browser Bridge profile（`opencli profile list`）
 *   --cutoff    YYYY-MM-DD。**该日当天保留**，从该日之后（本地时区次日 00:00）开始删
 *   --account   必填（非 dry-run）。与 whoami 完全一致才动手——不一致直接拒（防删错号）
 *   --limit     本轮最多删几条。X 的读配额和逐条删除都很紧，分块跑
 *   --interval  两次删除之间的秒数，默认 6（另加 0~1/3 随机抖动）
 *   --passes    删完后重新枚举补漏几轮，默认 2；`--no-rescan` 关掉
 *   --seed      用已下载的 `twitter tweets -f json` 文件初始化待删清单，**不花读配额**
 *   --keep-retweets  只删自己发的，转推保留（默认连转推一起 `unretweet`）
 *   --write-window   删除用的窗口模式，默认 dedicated（枚举走 background）
 *   --dry-run   只打印计划，不发任何写命令
 *
 * 依赖：本机 Chrome/Edge 开着且对应 profile 已登录 x.com；`opencli doctor` 三行 [OK]。
 *
 * 已知坑（2026-10-11 在 @neo1235190 实测）：
 *   - **时间线读取有硬配额**：连跑几次枚举就 `HTTP 429: UserTweets fetch failed —
 *     session quota; retry after 15-30 min`。所以待删清单落进 state 账本，删除轮次
 *     默认不再枚举；要补漏用 --seed 或隔 20 分钟再开 rescan。
 *   - `twitter tweets` 分页返回**不是严格降序**（页边界交叠），一轮枚举不是全集；
 *     置顶帖也不在返回里，X 时间线 API 只回溯最近约 800 条。要真全量用官方数据存档。
 *   - `--window background` 删不动：隐藏标签页被节流，X 的操作栏(caret)挂载比卡片更晚，
 *     报 "Could not find the More context menu"。delete/unretweet 是 UI 策略，必须真渲染。
 *   - 转推 `is_retweet: true` 走 `unretweet`，不是 `delete`。
 *   - 出现 rate limit / 掉登录 / 桥断 三种信号时**立即停**，不重试（重试会把账号推去
 *     临时锁定）。同一 --state 再跑即从账本继续。
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';

import { opencli, firstJson, parseFlags, required, sleepStep } from './opencli-core.mjs';

const RATE_LIMIT = /rate.?limit|too many requests|429|fetch failed|something went wrong|重试过多/i;
const AUTH_LOST = /AUTH_REQUIRED|auth cookies|not logged in/i;
const BROWSER_LOST = /BROWSER_CONNECT|not connected|session_not_found|No active session/i;

const flags = parseFlags(process.argv.slice(2));
const profile = required(flags, 'profile');
const cutoffDay = required(flags, 'cutoff');
const dryRun = flags['dry-run'] === true;
const keepRetweets = flags['keep-retweets'] === true;
const interval = Number(flags.interval ?? 6);
const maxDeletes = flags.limit ? Number(flags.limit) : Infinity;
const passes = flags['no-rescan'] === true ? 0 : Number(flags.passes ?? 2);
const writeWindow = typeof flags['write-window'] === 'string' ? flags['write-window'] : 'dedicated';
const maxConsecutiveFailures = Number(flags['max-failures'] ?? 3);

if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay)) throw new Error('--cutoff 要写成 YYYY-MM-DD');
if (!Number.isFinite(interval) || interval < 0) throw new Error('--interval 要是非负秒数');

const cutoffAt = new Date(`${cutoffDay}T23:59:59.999`).getTime();
const createdAt = (tweet) => new Date(tweet.created_at).getTime();

function statePathFor(handle) {
  if (typeof flags.state === 'string' && flags.state) return flags.state;
  return join(homedir(), '.opencli', 'prune', `${profile}-${handle}-${cutoffDay}.json`);
}

function readState(path) {
  const empty = { deleted: [], failed: [], plan: [] };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
      failed: Array.isArray(parsed.failed) ? parsed.failed : [],
      plan: Array.isArray(parsed.plan) ? parsed.plan : [],
    };
  } catch {
    return empty;
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, path);
}

async function runOpencli(args, options = {}) {
  return await opencli(['--profile', profile, ...args], { allowFailure: true, timeoutMs: 60_000 * 15, ...options });
}

async function whoami() {
  const res = await runOpencli(['twitter', 'whoami', '-f', 'json', '--window', 'background', '--site-session', 'persistent']);
  if (res.code !== 0) throw new Error(`whoami 失败：${res.stderr || res.stdout}`);
  return String(firstJson(res.stdout).username || '');
}

/** 枚举时间线。429 时返回 null，让调用方决定是退避还是用账本里的 plan。 */
async function enumerate() {
  const res = await runOpencli(['twitter', 'tweets', '--limit', '1000', '--page-delay', '2',
    '-f', 'json', '--window', 'background', '--site-session', 'persistent', '--keep-tab', 'false']);
  if (res.code !== 0) {
    const text = `${res.stdout}\n${res.stderr}`;
    if (RATE_LIMIT.test(text)) return null;
    throw new Error(`枚举失败：${text.slice(0, 300)}`);
  }
  const list = firstJson(res.stdout);
  return Array.isArray(list) ? list : null;
}

function candidatesOf(tweets, doneIds) {
  return tweets
    .filter((t) => createdAt(t) > cutoffAt)
    .filter((t) => !(keepRetweets && t.is_retweet))
    .filter((t) => t.url)
    .map((t) => ({ id: String(t.id), url: t.url, isRetweet: !!t.is_retweet, created_at: t.created_at }))
    .filter((t) => !doneIds.has(t.id));
}

function mergePlan(state, items) {
  const byId = new Map(state.plan.map((item) => [String(item.id), item]));
  for (const item of items) byId.set(item.id, item);
  state.plan = [...byId.values()];
}

function failureKind(text) {
  if (BROWSER_LOST.test(text)) return 'browser';
  if (AUTH_LOST.test(text)) return 'auth';
  if (RATE_LIMIT.test(text)) return 'rate-limit';
  return 'unknown';
}

async function main() {
  const handle = await whoami();
  const expected = typeof flags.account === 'string' ? flags.account.replace(/^@/, '').trim() : '';
  if (!dryRun) {
    if (!expected) throw new Error('非 dry-run 必须带 --account <handle> 明示要操作哪个号');
    if (expected.toLowerCase() !== handle.toLowerCase()) {
      throw new Error(`profile "${profile}" 登录的是 @${handle}，和要求的 @${expected} 不一致——拒绝执行`);
    }
  }

  const path = statePathFor(handle.toLowerCase());
  const state = readState(path);
  const doneIds = new Set(state.deleted.map((d) => String(d.id ?? d)));

  // 待删清单的来源，按省配额的程度排序：账本里已有的 plan → --seed 文件 → 现场枚举。
  if (typeof flags.seed === 'string' && flags.seed) {
    mergePlan(state, candidatesOf(JSON.parse(readFileSync(flags.seed, 'utf8')), doneIds));
    writeState(path, state);
  }
  if (!state.plan.length) {
    const list = await enumerate();
    if (!list) throw new Error('时间线枚举被限流(429)，且账本里没有 plan。等 20 分钟或带 --seed 再跑。');
    mergePlan(state, candidatesOf(list, doneIds));
    writeState(path, state);
  }

  const queue = state.plan.filter((item) => !doneIds.has(String(item.id)));
  console.log(`账号 @${handle}｜截止 ${cutoffDay}（含）之前保留｜账本已删 ${doneIds.size} 条｜待删 ${queue.length} 条（转推 ${queue.filter((q) => q.isRetweet).length}）`);
  console.log(`state=${path}`);

  if (dryRun) {
    for (const item of queue.slice(0, 12)) console.log(`  ${item.created_at}  ${item.isRetweet ? '[转推]' : '[原帖]'}  ${item.url}`);
    return { mode: 'dry-run', planned: queue.length };
  }

  let deletedNow = 0;
  let consecutiveFailures = 0;
  let stopReason = '';

  for (const item of queue) {
    if (deletedNow >= maxDeletes) { stopReason = 'limit'; break; }
    const cmd = item.isRetweet ? 'unretweet' : 'delete';
    const res = await runOpencli(['twitter', cmd, item.url, '-f', 'json',
      '--window', writeWindow, '--site-session', 'persistent', '--keep-tab', 'false']);
    const text = `${res.stdout}\n${res.stderr}`;
    const ok = (() => {
      try {
        const parsed = firstJson(res.stdout);
        const row = Array.isArray(parsed) ? parsed[0] : parsed;
        return res.code === 0 && !!row && (row.status === 'success' || /success/i.test(String(row.message || '')));
      } catch { return false; }
    })();

    if (ok) {
      consecutiveFailures = 0;
      deletedNow += 1;
      state.deleted.push({ ...item, at: new Date().toISOString() });
      doneIds.add(String(item.id));
      writeState(path, state);
      console.log(`  ✔ [${deletedNow}] ${item.created_at} ${item.url}`);
    } else {
      const kind = failureKind(text);
      consecutiveFailures += 1;
      state.failed.push({ ...item, at: new Date().toISOString(), kind, message: text.replace(/\s+/g, ' ').trim().slice(0, 300) });
      writeState(path, state);
      console.log(`  ✖ (${kind}, 连续 ${consecutiveFailures}) ${item.url}`);
      console.log(`     ${text.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
      if (kind !== 'unknown') { stopReason = kind; break; }
      if (consecutiveFailures >= maxConsecutiveFailures) { stopReason = 'consecutive-failures'; break; }
    }

    await sleepStep(interval + Math.random() * (interval / 3));
  }

  // 补漏扫描会吃读配额；被 429 挡下就跳过，不当失败。
  let remaining = state.plan.filter((i) => !doneIds.has(String(i.id))).length;
  let rescanDone = 0;
  for (let pass = 1; pass <= passes && !stopReason; pass += 1) {
    const list = await enumerate();
    if (!list) { console.log(`  补漏扫描第 ${pass} 轮被限流(429)，跳过`); stopReason = 'rescan-rate-limited'; break; }
    rescanDone += 1;
    const fresh = candidatesOf(list, doneIds);
    mergePlan(state, fresh);
    writeState(path, state);
    remaining = state.plan.filter((i) => !doneIds.has(String(i.id))).length;
    console.log(`  补漏第 ${pass} 轮：枚举 ${list.length} 条，新发现 ${fresh.length} 条，账本外待删 ${remaining} 条`);
    if (!fresh.length) break;
    stopReason = 'limit'; // 新发现的留给下一轮删除，不在本次调用里无限扩张
  }

  const summary = {
    mode: 'run',
    account: handle,
    cutoff: cutoffDay,
    deletedThisRun: deletedNow,
    deletedTotal: state.deleted.length,
    failedTotal: state.failed.length,
    remainingKnown: remaining,
    rescans: rescanDone,
    stopReason,
    state: path,
  };
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (stopReason && stopReason !== 'limit' && stopReason !== 'rescan-rate-limited') {
    console.log(`\n停在「${stopReason}」。同一 --state 重跑继续：`);
    console.log(`  node x-prune-tweets.mjs --profile ${profile} --cutoff ${cutoffDay} --account ${handle} --no-rescan`);
  }
  return summary;
}

main().then((summary) => {
  process.exit(summary.stopReason ? 2 : 0);
}).catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
