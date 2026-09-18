// 为什么有这个文件（2026-09-18 sgtushu 体检，Windows 实测）：
// opencli 经 npm 全局安装后在 Windows 上只有 opencli.cmd 批处理壳，
// Node 的 execFileSync("opencli", ...) 解析不到它（ENOENT）；改 shell:true
// 又会被 cmd.exe 按空格/元字符拆参，eval 里的多行 JS 直接烂掉。
// 实测干净的出路：把 .cmd 壳解析到其旁边 node_modules 里的 opencli main.js，
// 用 node.exe 直跑——argv 全程不经 shell，多行 JS、引号、`&` 都原样送达。
// 找不到 main.js 才退回 shell:true 单串调用；走这条兜底路时参数不能含空格
// （seo-webcafe.mjs 的 base64 包装就是为此准备的，正常情况下用不到）。
//
// 用法：
//   import { opencliRun, opencliRunAsync, opencliAvailable, opencliUsesCmd } from "./lib-opencli.mjs";
//   opencliRun(["browser", session, "eval", js], { encoding: "utf8", timeout: 30000 })
// 环境变量 RANKUP_OPENCLI（或调用点传 { bin }）可指定完整路径（.cmd / .exe / main.js 均可）。

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

function mainJsBeside(shimPath) {
  const main = join(
    dirname(shimPath),
    "node_modules", "@jackwener", "opencli", "dist", "src", "main.js",
  );
  return existsSync(main) ? main : null;
}

/** 把一个「命令名或完整路径」推导成 { bin, prefixArgs, shell } 的 spawn 形态。 */
function derive(bin) {
  if (/\.(m?js)$/i.test(bin)) return { bin: process.execPath, prefixArgs: [bin], shell: false };
  if (/\.(cmd|bat)$/i.test(bin)) {
    const main = mainJsBeside(bin);
    if (main) return { bin: process.execPath, prefixArgs: [main], shell: false };
    return { bin, prefixArgs: [], shell: true };
  }
  // .exe / 裸命令名：Windows 上裸名要靠 cmd 解析，其他平台直接 spawn。
  return { bin, prefixArgs: [], shell: process.platform === "win32" && !/\.(exe)$/i.test(bin) };
}

let _resolved;
export function resolveOpencli(opts = {}) {
  const override = opts.bin || process.env.RANKUP_OPENCLI;
  if (override) return derive(override);
  if (_resolved) return _resolved;
  if (process.platform === "win32") {
    let shim = null;
    try {
      // where.exe 直接 spawn（不经 cmd），避开 DEP0190 的 shell+args 拼接告警
      const out = execFileSync("where.exe", ["opencli.cmd"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000,
      });
      shim = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
    } catch { /* PATH 里没有 opencli，保持未解析状态走兜底 */ }
    _resolved = shim ? derive(shim) : { bin: "opencli", prefixArgs: [], shell: true };
  } else {
    _resolved = { bin: "opencli", prefixArgs: [], shell: false };
  }
  return _resolved;
}

/** 同步跑一条 opencli 命令，返回 stdout（参数数组不经 shell 拆解）。 */
export function opencliRun(args, opts = {}) {
  const r = resolveOpencli(opts);
  const { bin: _bin, ...rest } = opts;
  return execFileSync(r.bin, [...r.prefixArgs, ...args], { shell: r.shell, ...rest });
}

/** 异步版，返回 { stdout, stderr }。 */
export async function opencliRunAsync(args, opts = {}) {
  const r = resolveOpencli(opts);
  const { bin: _bin, ...rest } = opts;
  return pExecFile(r.bin, [...r.prefixArgs, ...args], { shell: r.shell, ...rest });
}

let _available;
export function opencliAvailable(opts = {}) {
  if (!opts.bin && _available !== undefined) return _available;
  try {
    opencliRun(["--version"], { stdio: "ignore", timeout: 15000, ...opts });
    if (!opts.bin) _available = true;
    return true;
  } catch {
    if (!opts.bin) _available = false;
    return false;
  }
}

/** true = 当前走的是 cmd 兜底路（参数不能含空格）。直连 node 路为 false。 */
export function opencliUsesCmd(opts = {}) {
  return resolveOpencli(opts).shell === true;
}
