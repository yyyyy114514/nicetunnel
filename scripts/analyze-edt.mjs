// 开发用：分析上游 edgetunnel/_worker.js 的顶层符号依赖，找出数据面所需最小闭包
// 用法：node scripts/analyze-edt.mjs <上游_worker.js> [roots,逗号分隔]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = ['/opt/node-tools/node_modules', '/opt/npm-tools/node_modules'];
const acorn = require(require.resolve('acorn', { paths: P }));
const walk = require(require.resolve('acorn-walk', { paths: P }));

const file = process.argv[2];
const roots = (process.argv[3] || '').split(',').filter(Boolean);
let src = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
// 截断末尾的超大注释：html1101 结束后的 `/*` 起
const cut = src.indexOf('\n/*\n\nGenesis');
if (cut > 0) src = src.slice(0, cut) + '\n';
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

const decls = new Map(); // name -> {kind,node,start,end,line}
let defaultExport = null;
for (const n of ast.body) {
  if (n.type === 'ExportDefaultDeclaration') { defaultExport = n; continue; }
  if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') decls.set(n.id.name, { kind: n.type, node: n, line: n.loc.start.line });
  else if (n.type === 'VariableDeclaration') for (const d of n.declarations) collect(d.id, n, d);
}
function collect(id, stmt, d) {
  if (id.type === 'Identifier') decls.set(id.name, { kind: stmt.kind, node: d, stmt, line: d.loc.start.line });
  else if (id.type === 'ObjectPattern') id.properties.forEach(p => collect(p.value || p.argument, stmt, d));
  else if (id.type === 'ArrayPattern') id.elements.forEach(e => e && collect(e, stmt, d));
  else if (id.type === 'AssignmentPattern') collect(id.left, stmt, d);
}
function refsIn(node) {
  const s = new Set();
  walk.full(node, n => { if (n.type === 'Identifier' && decls.has(n.name)) s.add(n.name); });
  return s;
}
const deps = new Map();
for (const [name, d] of decls) deps.set(name, refsIn(d.node));
const defRefs = defaultExport ? refsIn(defaultExport) : new Set();

console.log(`顶层声明 ${decls.size} 个；export default 位于第 ${defaultExport?.loc.start.line}-${defaultExport?.loc.end.line} 行；其直接引用 ${defRefs.size} 个`);
// 写入全局可变量（let）在非 default 区域被引用的情况
const lets = [...decls].filter(([, d]) => d.kind === 'let').map(([n]) => n);
console.log('模块级 let：', lets.join(', '));

if (roots.length) {
  const seen = new Set(); const q = [...roots];
  for (const r of roots) if (!decls.has(r)) console.log('!! 根不存在：', r);
  while (q.length) { const n = q.pop(); if (seen.has(n) || !decls.has(n)) continue; seen.add(n); deps.get(n).forEach(x => q.push(x)); }
  const list = [...seen].sort((a, b) => decls.get(a).line - decls.get(b).line);
  console.log(`\n数据面闭包：${list.length} 个顶层符号`);
  for (const n of list) console.log(String(decls.get(n).line).padStart(5), decls.get(n).kind.padEnd(19), n);
  console.log('\n闭包中引用到的 let 变量：', lets.filter(l => seen.has(l)).join(', '));
  const notIn = [...decls.keys()].filter(n => !seen.has(n)).sort((a, b) => decls.get(a).line - decls.get(b).line);
  console.log(`\n不在闭包内（控制面/无关）：${notIn.length} 个`);
  console.log(notIn.map(n => `${decls.get(n).line}:${n}`).join('  '));
}
