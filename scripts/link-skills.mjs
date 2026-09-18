#!/usr/bin/env node
// 把本仓库的每个 Skill 符号链接进多个 IDE 的全局技能目录,使全局只有一个真源。
// 只负责 yan-skills 这条 git 仓库(yan-labs)的本地开发态:本地改仓库、全局即时反映。
// 第三方导入的 skill(如 impeccable)不归这里管,由 `npx skills` CLI 统一处理链接。
//
//   node scripts/link-skills.mjs           建立或修复链接
//   node scripts/link-skills.mjs --check   只检查,发现漂移时退出 1
//
// 分层约定(configuration 单点就是本仓库):
//   hub        ~/.agents/skills   枢纽,每个 Skill 直接链接到本仓库(Codex / Cursor agent 通用读取)
//   claude     ~/.claude/skills   镜像,链接到 hub(Claude Code 读取)
//   trae       ~/.trae-cn/skills  镜像,链接到 hub(TRAE 读取)
//   doubao     ~/Doubao/skills    镜像,链接到 hub(豆包读取)
//   workbuddy  ~/.workbuddy/skills 镜像,链接到 hub(WorkBuddy 读取)
//
// `skills add` / `skills update` 会把链接换成实体目录副本,双份维护随之回归;重跑本脚本恢复。

import { lstat, mkdir, readdir, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hubSkills = path.join(homedir(), ".agents", "skills");

// 处理顺序即依赖顺序:枢纽先建,镜像把链接指到枢纽上。
const TARGETS = [
  { label: "hub (~/.agents/skills)",   dir: hubSkills,
    linkTo: (name) => path.join(repoRoot, name) },
  { label: "claude (~/.claude/skills)", dir: path.join(homedir(), ".claude", "skills"),
    linkTo: (name) => path.join(hubSkills, name) },
  { label: "trae (~/.trae-cn/skills)",  dir: path.join(homedir(), ".trae-cn", "skills"),
    linkTo: (name) => path.join(hubSkills, name) },
  { label: "doubao (~/Doubao/skills)",  dir: path.join(homedir(), "Doubao", "skills"),
    linkTo: (name) => path.join(hubSkills, name) },
  { label: "workbuddy (~/.workbuddy/skills)", dir: path.join(homedir(), ".workbuddy", "skills"),
    linkTo: (name) => path.join(hubSkills, name) },
];

// --help 必须在任何文件系统写操作之前早退:check-help.mjs 会对全仓 CLI 跑
// `node <script> --help`,没有这个守卫时那次"体检"会真的执行一轮全局重链接+备份。
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`link-skills.mjs —— 把本仓库的每个 Skill 符号链接进各 IDE 的全局技能目录

只服务 yan-skills 本仓库的本地开发态。
第三方导入的 skill 用 \`npx skills\` CLI 管理,不归本脚本。

分层(configuration 单点 = 本仓库):
  hub       ~/.agents/skills   链接到本仓库(真源)
  claude    ~/.claude/skills   链接到 hub
  trae      ~/.trae-cn/skills  链接到 hub
  doubao    ~/Doubao/skills    链接到 hub
  workbuddy ~/.workbuddy/skills 链接到 hub

用法:
  node scripts/link-skills.mjs             建立或修复链接
  node scripts/link-skills.mjs --check     只检查,发现漂移时退出 1
  node scripts/link-skills.mjs --help      显示本帮助(不做任何修改)`);
  process.exit(0);
}

const checkOnly = process.argv.includes("--check");

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

// 仓库里带 SKILL.md 的一级子目录就是一个 Skill。
async function discoverSkills() {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (await exists(path.join(repoRoot, entry.name, "SKILL.md"))) {
      skills.push(entry.name);
    }
  }
  return skills.sort();
}

// 已经指向期望位置(通常经符号链接扁平化后落到同一真源)的链接视为正常,其余一律需要处理。
async function inspect(name, source, target) {
  if (!(await exists(target))) return { name, source, target, state: "missing" };

  const info = await lstat(target);
  if (!info.isSymbolicLink()) return { name, source, target, state: "real-directory" };

  const resolved = path.resolve(path.dirname(target), await readlink(target));
  if ((await realpath(resolved).catch(() => resolved)) === (await realpath(source))) {
    return { name, source, target, state: "linked" };
  }
  return { name, source, target, state: "wrong-target", resolved };
}

// 同一天可能修复多次,而当天的备份目录里已经有同名条目;rename 到非空目录会
// 直接抛 ENOTEMPTY 并中断整轮修复。逐个后缀试到空位为止,保证每次备份都不覆盖。
async function freeBackupPath(base, stamp, name) {
  const dir = path.join(base, `.backup-${stamp}`);
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(dir, suffix === 0 ? name : `${name}-${suffix}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function relink({ name, source, target, state }, stamp, base) {
  if (state === "real-directory") {
    // 实体目录可能含有本机专属文件(.env 等),备份而不是删除。
    const backup = await freeBackupPath(base, stamp, name);
    await mkdir(path.dirname(backup), { recursive: true });
    await rename(target, backup);
    console.log(`  已备份被替换的实体目录 -> ${path.relative(homedir(), backup)}`);
  } else if (state === "wrong-target") {
    await unlink(target);
  }
  // Windows 非管理员进程建目录符号链接会 EPERM,junction 不需要特权。
  await symlink(source, target, process.platform === "win32" ? "junction" : undefined);
  console.log(`  已链接 ${name} -> ${source}`);
}

const skills = await discoverSkills();
if (skills.length === 0) {
  console.error("仓库里没有找到任何含 SKILL.md 的 Skill 目录");
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
let anyDrift = false;

for (const target of TARGETS) {
  console.log(`\n== ${target.label} ==`);
  await mkdir(target.dir, { recursive: true });
  const drift = [];

  for (const name of skills) {
    const source = target.linkTo(name);
    const dest = path.join(target.dir, name);
    const report = await inspect(name, source, dest);
    if (report.state === "linked") {
      console.log(`OK   ${name}`);
      continue;
    }
    drift.push(report);
    anyDrift = true;
    console.log(`漂移 ${name}: ${report.state}`);
    if (!checkOnly) await relink(report, stamp, target.dir);
  }

  if (drift.length === 0) {
    console.log(`${skills.length} 个 Skill 全部指向期望位置。`);
  } else if (checkOnly) {
    console.error(`${drift.length} 个 Skill 未指向期望位置。运行 node scripts/link-skills.mjs 修复。`);
  } else {
    console.log(`已修复 ${drift.length} 个 Skill。`);
  }
}

if (checkOnly && anyDrift) process.exit(1);
