/**
 * `--window`/`OPENCLI_WINDOW` 的单一入口——`normalizeWindowMode` 及其两个消费者
 * `resolveBrowserWindowArgs`（`opencli()` 用）/`buildBatchBrowserArgs`（`batchBrowser()`
 * 用）。2026-09-14 之前这三处各自写了一份「只认 foreground，其余一律 background」
 * 的二值化三元表达式，把 opencli 实际支持的 `active`/`isolated` 都静默压成了
 * `background`。这里钉住修复之后的透传行为，以及修复前就有的既有行为不能变。
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  ALLOWED_WINDOW_MODES, buildBatchBrowserArgs, normalizeWindowMode, resolveBrowserWindowArgs,
} from '../scripts/opencli-core.mjs';

test('normalizeWindowMode passes through all four opencli-recognised modes', () => {
  for (const mode of ['foreground', 'active', 'background', 'isolated']) {
    assert.equal(normalizeWindowMode(mode), mode);
  }
  assert.deepEqual(ALLOWED_WINDOW_MODES, ['foreground', 'active', 'background', 'isolated', 'dedicated']);
});

// 2026-09-14：dedicated 是新增的第五档（opencli 专用窗口模式，见
// dedicated-window-contract.md）。旧 opencli/旧扩展不认它——调用方要先探测
// 支持才决定用不用，但 normalizeWindowMode 本身只负责透传+校验，跟其余四档
// 待遇一致，不做能力探测。
test('normalizeWindowMode: dedicated is now a recognised fifth mode', () => {
  assert.equal(normalizeWindowMode('dedicated'), 'dedicated');
});

test('normalizeWindowMode falls back on anything unrecognised', () => {
  assert.equal(normalizeWindowMode('nonsense'), 'dedicated');
  assert.equal(normalizeWindowMode(undefined), 'dedicated');
  assert.equal(normalizeWindowMode(null), 'dedicated');
  assert.equal(normalizeWindowMode(''), 'dedicated');
  assert.equal(normalizeWindowMode('nonsense', 'active'), 'active', 'custom fallback is honoured');
});

test('resolveBrowserWindowArgs: active/isolated now really reach the CLI (previously collapsed to background)', () => {
  assert.deepEqual(
    resolveBrowserWindowArgs(['browser', 's1', 'eval', 'x'], { windowMode: 'active' }),
    ['browser', 's1', '--window', 'active', 'eval', 'x'],
  );
  assert.deepEqual(
    resolveBrowserWindowArgs(['browser', 's1', 'eval', 'x'], { windowMode: 'isolated' }),
    ['browser', 's1', '--window', 'isolated', 'eval', 'x'],
  );
});

test('resolveBrowserWindowArgs: explicit foreground is unchanged; default is dedicated', () => {
  assert.deepEqual(
    resolveBrowserWindowArgs(['browser', 's1', 'eval', 'x'], { windowMode: 'foreground' }),
    ['browser', 's1', '--window', 'foreground', 'eval', 'x'],
  );
  assert.deepEqual(
    resolveBrowserWindowArgs(['browser', 's1', 'eval', 'x'], {}),
    ['browser', 's1', '--window', 'dedicated', 'eval', 'x'],
    'no windowMode/env at all defaults to dedicated',
  );
  assert.deepEqual(
    resolveBrowserWindowArgs(['browser', 's1', 'eval', 'x'], { env: { OPENCLI_WINDOW: 'foreground' } }),
    ['browser', 's1', '--window', 'foreground', 'eval', 'x'],
  );
});

test('resolveBrowserWindowArgs: an unrecognised requested value falls back to dedicated', () => {
  assert.deepEqual(
    resolveBrowserWindowArgs(['browser', 's1', 'eval', 'x'], { windowMode: 'typo' }),
    ['browser', 's1', '--window', 'dedicated', 'eval', 'x'],
  );
});

test('resolveBrowserWindowArgs: an explicit --window already in args is left completely alone', () => {
  const args = ['browser', 's1', '--window', 'isolated', 'open', 'https://example.com'];
  assert.deepEqual(resolveBrowserWindowArgs(args, { windowMode: 'active' }), args, 'explicit args win, options are ignored');
});

test('resolveBrowserWindowArgs: sessions/cleanup are bare subcommands, never get --window spliced in', () => {
  assert.deepEqual(resolveBrowserWindowArgs(['browser', 'sessions', '-f', 'json'], { windowMode: 'active' }), ['browser', 'sessions', '-f', 'json']);
  assert.deepEqual(resolveBrowserWindowArgs(['browser', 'cleanup'], { windowMode: 'active' }), ['browser', 'cleanup']);
});

test('buildBatchBrowserArgs: active/isolated now really reach the CLI', () => {
  assert.deepEqual(
    buildBatchBrowserArgs('s1', [{ cmd: 'eval', args: { js: '1' } }], { windowMode: 'active' }),
    ['browser', 's1', '--window', 'active', 'batch', '--commands', JSON.stringify([{ cmd: 'eval', args: { js: '1' } }])],
  );
});

test('buildBatchBrowserArgs: explicit foreground is unchanged; default is dedicated', () => {
  const commands = [{ cmd: 'eval', args: { js: '1' } }];
  assert.deepEqual(
    buildBatchBrowserArgs('s1', commands, { windowMode: 'foreground' }),
    ['browser', 's1', '--window', 'foreground', 'batch', '--commands', JSON.stringify(commands)],
  );
  assert.deepEqual(
    buildBatchBrowserArgs('s1', commands, {}),
    ['browser', 's1', '--window', 'dedicated', 'batch', '--commands', JSON.stringify(commands)],
  );
  assert.deepEqual(
    buildBatchBrowserArgs('s1', commands, { windowMode: 'typo' }),
    ['browser', 's1', '--window', 'dedicated', 'batch', '--commands', JSON.stringify(commands)],
    'unrecognised value falls back to dedicated',
  );
});
