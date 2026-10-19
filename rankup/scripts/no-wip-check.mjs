#!/usr/bin/env node
// 构建期用户文案检查：零依赖，可单文件拷贝；无登录态依赖。
// 输入为已渲染 HTML、sitemap/feed XML 或 llms.txt，不扫描组件源码或 JS bundle。
// 静态 HTML 不能证明水合后文案与功能闭环，仍需逐入口回读。验证日期：2026-10-03。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NO_WIP_TERMS = [
  'coming soon', 'under construction', 'work in progress', 'WIP', 'TBD', 'TODO',
  'stay tuned', 'check back', 'launching soon', 'not yet available',
  'will be added', 'will be available', 'in development',
  '待定', '建设中', '敬请期待', '即将上线', '即将推出', '开发中', '正在建设', '待上线', '待补充',
];
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = NO_WIP_TERMS.map(term => ({ term, re: new RegExp(
  /[a-z]/i.test(term) ? `(?<![a-z0-9_])${escape(term).replace(/ /g, '\\s+')}(?![a-z0-9_])` : escape(term), 'giu') }));
const decode = s => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ensp|emsp|thinsp|Tab|NewLine);/gi, (all, key) => {
  if (key[0] === '#') { const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10); return n <= 0x10ffff ? String.fromCodePoint(n) : all; }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', tab: '\t', newline: '\n' })[key.toLowerCase()];
});
const attributes = tag => Object.fromEntries([...tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4])]));

export function scanDocument(source, { format = 'html' } = {}) {
  const hits = [];
  const check = (value, location, offset) => {
    for (const { term, re } of matchers) {
      re.lastIndex = 0;
      for (const m of value.matchAll(re)) hits.push({ term, location, line: source.slice(0, offset).split('\n').length + value.slice(0, m.index).split('\n').length - 1, excerpt: value.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25).replace(/\s+/g, ' ') });
    }
  };
  if (format === 'text') { check(decode(source), 'text', 0); return hits; }
  const stack = [];
  let text = '', textOffset = 0;
  const flush = () => { if (text) check(decode(text), 'text', textOffset); text = ''; };
  const block = /^(?:html|head|body|div|p|section|article|header|footer|nav|main|h[1-6]|li|ul|ol|table|tr|td|th|form|button|br|title|entry|item)$/;
  const token = /<(script|style)\b[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g;
  for (const m of source.matchAll(token)) {
    const part = m[0];
    const rawElement = part.match(/^<(script|style)\b([^>]*)>([\s\S]*)<\/\1\s*>$/i);
    if (rawElement) {
      flush();
      if (rawElement[1].toLowerCase() === 'script' && attributes(rawElement[2]).type?.toLowerCase() === 'application/ld+json') {
        const visit = (v, path) => { if (typeof v === 'string') check(v, path, m.index); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`); };
        try { visit(JSON.parse(rawElement[3]), 'JSON-LD'); } catch { check(decode(rawElement[3]), 'JSON-LD (invalid JSON)', m.index); }
      }
      continue;
    }
    if (part.startsWith('<!--') || /^<![^[]/.test(part)) continue;
    if (!part.startsWith('<') || part.startsWith('<![CDATA[')) {
      const parent = stack.at(-1);
      if (parent?.name === 'script' && parent.ld) parent.raw += part;
      else if (!stack.some(n => n.skip)) {
        const value = part.startsWith('<![CDATA[') ? part.slice(9, -3) : part;
        const fragment = decode(value);
        if (format === 'xml' && /<[a-z][^>]*>/i.test(fragment)) {
          flush();
          for (const hit of scanDocument(fragment)) hits.push({ ...hit, location: `feed fragment ${hit.location}`, line: source.slice(0, m.index).split('\n').length + hit.line - 1 });
        } else { if (!text) textOffset = m.index; text += value; }
      }
      continue;
    }
    const name = part.match(/^<\/?([\w:-]+)/)?.[1].toLowerCase();
    if (!name) continue;
    if (block.test(name) || /^(script|style|template)$/.test(name)) flush();
    if (part.startsWith('</')) {
      const index = stack.map(n => n.name).lastIndexOf(name);
      if (index >= 0) {
        const node = stack[index];
        if (node.ld) {
          const visit = (v, path) => { if (typeof v === 'string') check(v, path, node.offset); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`); };
          try { visit(JSON.parse(node.raw), 'JSON-LD'); } catch { check(decode(node.raw), 'JSON-LD (invalid JSON)', node.offset); }
        }
        stack.splice(index);
      }
      continue;
    }
    const attrs = attributes(part);
    for (const key of ['alt', 'aria-label', 'title']) if (attrs[key]) check(attrs[key], `<${name}> @${key}`, m.index);
    if (name === 'input' && /^(button|submit|reset)$/i.test(attrs.type || '')) check(attrs.value || '', '<input> @value', m.index);
    if (name === 'meta' && (attrs.name?.toLowerCase() === 'description' || /^(og:|twitter:)/i.test(attrs.property || attrs.name || ''))) check(attrs.content || '', `<meta> @${attrs.property || attrs.name}`, m.index);
    if (!/\/\s*>$/.test(part) && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) stack.push({ name, skip: /^(script|style|template)$/.test(name) || /\bhidden(?:\s|=|>)/i.test(part) || attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || ''), ld: name === 'script' && attrs.type?.toLowerCase() === 'application/ld+json', raw: '', offset: m.index });
  }
  flush();
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log('用法：node no-wip-check.mjs <渲染产物目录或 HTML/XML/TXT 文件...>\n退出码：0 零命中；1 命中；2 输入错误。placeholder 属性、注释、JS/CSS 不检查。\n自测：node no-wip-check.mjs --self-test\n构建后执行；SSR/动态路由先导出 HTML，水合后文案另行回读。');
    process.exit(args.length ? 0 : 2);
  }
  if (args.includes('--self-test')) {
    const bad = scanDocument('<p>Coming <b>soon</b></p>');
    const good = scanDocument('<p>Ready</p><input placeholder="TODO"><style>.wip{}</style><script>const TODO=1;</script><!-- TBD --><div class="coming-soon"></div>');
    if (!bad.length || good.length) process.exit(1);
    console.log('PASS：命中样例失败判据成立；清除后与例外样例零命中。');
    process.exit(0);
  }
  try {
    let count = 0, files = 0;
    const walk = p => {
      if (statSync(p).isDirectory()) { for (const entry of readdirSync(p)) walk(resolve(p, entry)); return; }
      if (!/\.(html?|xml|txt)$/i.test(p)) return;
      files++;
      const hits = scanDocument(readFileSync(p, 'utf8'), { format: extname(p).toLowerCase() === '.txt' ? 'text' : extname(p).toLowerCase() === '.xml' ? 'xml' : 'html' });
      for (const hit of hits) console.error(`${p}:${hit.line} ${hit.location}: ${hit.term} — ${hit.excerpt}`);
      count += hits.length;
    };
    args.forEach(p => walk(resolve(p)));
    if (!files) throw new Error('未找到可检查的 HTML/XML/TXT；先导出渲染产物');
    console.log(`files=${files} noWipHits=${count}`);
    process.exitCode = count ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
