#!/usr/bin/env node
/**
 * check-doc-links.mjs —— 全仓 Markdown 相对链接体检。
 *
 * 【为什么需要它，以及它和已有闸门的分工】
 * `backlink/scripts/validate-skill-xml.mjs` 只查 SKILL.md 里 `<ref>` / `<law-ref>` 的指针；
 * `rankup/scripts/validate-rankup.mjs` 只做 rankup 自己的机械断言。
 * **两者都看不到 references/*.md 内部互相引用的那些普通 Markdown 链接。**
 *
 * 2026-08-24 第一次跑它就抓出 4 条断链，全是老的、两个闸门都漏掉的：
 *   backlink/references/harvest.md 里三条写成 `](scripts/x)`——
 *     那是相对 references/ 解析的，实际指向 references/scripts/x，不存在；正确是 `../scripts/x`
 *   rankup/references/lifecycle.md 里一条写成 `](references/seo-growth.md)`——
 *     同目录文件多写了一层 references/
 *
 * 这类错误的共同点是**看上去完全正常**：路径拼写没错、目标文件真实存在，
 * 只是相对基准算错了一层。只有当有人真的去点它时才发现是断的，而那时候已经晚了。
 *
 * 用法：node scripts/check-doc-links.mjs        （断链时退出码 1）
 * 依赖：无。
 * 已验证日期：2026-08-24
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath 而非 URL.pathname：win32 上 pathname 是 "/C:/..."，resolve 会拼出 "C:\C:\..."。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 递归收集要检查的 Markdown。跳过 node_modules 与 .git 之类。
 * 也跳过 `*-workspace/`：那是 eval 跑分与实验产物（.gitignore 里就有这条），
 * 里面躺着 Skill 的历史快照——快照只复制单个 Skill 子目录，指向兄弟 Skill 的
 * `../../backlink/...` 必然解析不到。把它算进门禁，等于让快照数量决定门禁红绿。
 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
    if (name.endsWith("-workspace")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = collect(ROOT);
let checked = 0;
const broken = [];

for (const file of files) {
  const dir = dirname(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = m[2];
    // 外链、锚点、协议链接不在本脚本职责内
    if (/^(https?:|#|mailto:|tel:)/.test(target)) continue;
    checked++;
    // 去掉锚点再解析；目录链接（结尾 /）也算数
    const bare = target.split("#")[0];
    if (!bare) continue;
    const abs = normalize(join(dir, bare));
    if (!existsSync(abs)) {
      broken.push({ file: file.slice(ROOT.length + 1), target });
    }
  }
}

if (broken.length) {
  console.error(`✗ ${broken.length} 条断链：\n`);
  for (const b of broken) console.error(`  ${b.file}\n    → ${b.target}`);
  console.error(
    `\n提示：最常见的成因不是拼错文件名，是**相对基准算错一层**——` +
      `\nreferences/ 里指向 scripts/ 要写 ../scripts/，指向同目录文件不要再加一层目录名。`,
  );
  process.exit(1);
}

console.log(`✓ ${files.length} 个 Markdown / ${checked} 条相对链接，全部可解析`);
