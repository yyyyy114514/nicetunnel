// 开发脚本：从上游 cmliu/edgetunnel 的 _worker.js 逐字摘出"数据面"闭包，生成 src/dataplane/edt-core.js
//
// 目的：协议实现（VLESS/Trojan/SS、WS/gRPC/XHTTP、TLS 客户端、SOCKS5/HTTP/HTTPS/TURN/SSTP 链式代理）
//       复杂且无法在本地真机验证，因此不手改，只做"按依赖摘取 + 追加导出"，上游更新时可重放此脚本。
//
// 用法：node scripts/vendor-edt.mjs <上游 _worker.js 路径> [上游仓库目录(取 git HEAD 用)]
//
// 许可证：上游为 GPL-2.0，生成物沿用并保留署名（见 NOTICE.md）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const P = ['/opt/node-tools/node_modules', '/opt/npm-tools/node_modules'];
const acorn = require(require.resolve('acorn', { paths: P }));
const walk = require(require.resolve('acorn-walk', { paths: P }));

const here = path.dirname(fileURLToPath(import.meta.url));
const upstreamFile = process.argv[2];
const upstreamDir = process.argv[3] || path.dirname(upstreamFile);
if (!upstreamFile) { console.error('用法: node scripts/vendor-edt.mjs <上游 _worker.js> [上游仓库目录]'); process.exit(1); }

// 数据面入口：被适配器直接调用的符号（闭包会自动带上它们依赖的一切）
const ROOTS = [
  '处理WS请求', '处理gRPC请求', '处理叉HTTP请求', '反代参数获取', '获取本机标识',
  'base64SecretEncode', 'base64SecretDecode', '获取SOCKS5账号', '获取代理默认端口',
  'nginx', 'html1101', '整理成数组', '特征码字典',
  // 代理检查(/admin/check)与订阅辅助：同样逐字取自上游
  'socks5Connect', 'httpConnect', 'httpsConnect', 'turnConnect', 'sstpConnect', 'TlsClient',
  '创建请求TCP连接器', '拼接字节数据', 'isIPHostname', '识别运营商', '随机路径', '替换星号为随机字符',
];
// 追加导出的别名（左：上游符号，右：对外英文名）
const EXPORTS = {
  处理WS请求: 'handleWebSocket',
  处理gRPC请求: 'handleGrpc',
  处理叉HTTP请求: 'handleXhttp',
  反代参数获取: 'parseProxyParams',
  获取本机标识: 'getLocalMark',
  base64SecretEncode: 'base64SecretEncode',
  base64SecretDecode: 'base64SecretDecode',
  获取SOCKS5账号: 'parseChainAccount',
  获取代理默认端口: 'defaultChainPort',
  nginx: 'nginxPage',
  html1101: 'html1101Page',
  整理成数组: 'splitList',
  特征码字典: 'SIGNATURE',
  socks5Connect: 'socks5Connect',
  httpConnect: 'httpConnect',
  httpsConnect: 'httpsConnect',
  turnConnect: 'turnConnect',
  sstpConnect: 'sstpConnect',
  TlsClient: 'TlsClient',
  创建请求TCP连接器: 'createTcpConnector',
  拼接字节数据: 'concatBytes',
  isIPHostname: 'isIPHostname',
  识别运营商: 'detectIspUpstream',
  随机路径: 'randomPath',
  替换星号为随机字符: 'replaceStars',
  // 仅供测试：直接驱动拨号/故障转移/竞速逻辑（仅建立连接模式）
  forwardataTCP: '__forwardTcpForTest',
};

let src = fs.readFileSync(upstreamFile, 'utf8').replace(/^﻿/, '');
const tailAt = src.indexOf('\n/*\n\nGenesis');
if (tailAt < 0) console.warn('警告：未找到末尾 Genesis 大注释，假定上游已变化，请人工确认体积');
else src = src.slice(0, tailAt) + '\n';

const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
const decls = new Map(); // 名 -> 顶层语句节点
const stmtNames = new Map(); // 语句节点 -> [名]
const addNames = (id, out) => {
  if (!id) return;
  if (id.type === 'Identifier') out.push(id.name);
  else if (id.type === 'ObjectPattern') id.properties.forEach(p => addNames(p.value || p.argument, out));
  else if (id.type === 'ArrayPattern') id.elements.forEach(e => addNames(e, out));
  else if (id.type === 'AssignmentPattern') addNames(id.left, out);
  else if (id.type === 'RestElement') addNames(id.argument, out);
};
for (const n of ast.body) {
  const names = [];
  if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') names.push(n.id.name);
  else if (n.type === 'VariableDeclaration') n.declarations.forEach(d => addNames(d.id, names));
  else continue;
  stmtNames.set(n, names);
  for (const nm of names) decls.set(nm, n);
}
const refs = (node) => { const s = new Set(); walk.full(node, x => { if (x.type === 'Identifier' && decls.has(x.name)) s.add(x.name); }); return s; };
const depCache = new Map();
const depsOf = (stmt) => depCache.get(stmt) || (depCache.set(stmt, refs(stmt)), depCache.get(stmt));

const keep = new Set(); // 保留的语句节点
const queue = [...ROOTS];
for (const r of ROOTS) if (!decls.has(r)) throw new Error('入口符号在上游不存在：' + r + '（上游可能已重构，需人工适配）');
while (queue.length) {
  const nm = queue.pop(); const st = decls.get(nm);
  if (!st || keep.has(st)) continue;
  keep.add(st);
  for (const d of depsOf(st)) queue.push(d);
}

const ordered = ast.body.filter(n => keep.has(n));
const body = ordered.map(n => src.slice(n.start, n.end)).join('\n\n');

// ---- [NT-HOOK] nicetunnel 对上游数据面的最小注入（与当前 src/dataplane/edt-core.js 一一对应） ----
// 上游变化导致锚点漂移时立即报错退出，避免静默丢失钩子。
const applyPatch = (text, search, replace, expect = 1, re = false) => {
  if (re) {
    const matches = text.match(search) || [];
    if (matches.length !== expect) throw new Error(`vendor 补丁失败（正则期望 ${expect} 处，实际 ${matches.length} 处）：${search}`);
    return text.replace(search, replace);
  }
  const count = text.split(search).length - 1;
  if (count !== expect) throw new Error(`vendor 补丁失败（期望 ${expect} 处，实际 ${count} 处）：${JSON.stringify(search.slice(0, 60))}`);
  return text.split(search).join(replace);
};
let patched = body;
patched = applyPatch(patched, 'const CONNECT_TIMEOUT_MS = 9999;',
  'let 链路连接超时毫秒 = 9999; // [NT-HOOK] nicetunnel: 可通过 configure({chainConnectTimeoutMs}) 注入（SSTP/TURN 链路拨号的读写/连接超时）');
patched = patched.replace(/\bCONNECT_TIMEOUT_MS\b/g, '链路连接超时毫秒');

// [NT-HOOK] ctx代理类型 / ctx代理参数 改为 let：链路故障转移时要换成下一台候选
patched = applyPatch(patched, 'const ctx代理类型 = 反代上下文.代理类型 !== undefined ? 反代上下文.代理类型 : null;',
  'let ctx代理类型 = 反代上下文.代理类型 !== undefined ? 反代上下文.代理类型 : null;');
patched = applyPatch(patched, 'const ctx代理参数 = 反代上下文.代理参数 || {};',
  'let ctx代理参数 = 反代上下文.代理参数 || {}; // [NT-HOOK] 链路故障转移时会换成下一台候选');

// [NT-HOOK] 整段替换拨号逻辑：加入"拨号失败先换下一台候选重试"，而不是立刻掐断客户端 WS。
// 替换体放在 assets/vendor/dial-failover.txt（从 src/dataplane/edt-core.js 导出，避免转义失真），
// 用首尾锚点定位上游原文，上游结构变化时立即报错而不是静默丢失钩子。
const replaceRange = (text, startRe, endRe, replacement, label) => {
  const m = startRe.exec(text);
  if (!m) throw new Error(`vendor 补丁失败：找不到起始锚点（${label}）${startRe}`);
  const from = m.index;
  const e = endRe.exec(text.slice(from));
  if (!e) throw new Error(`vendor 补丁失败：找不到结束锚点（${label}）${endRe}`);
  const to = from + e.index + e[0].length;
  return text.slice(0, from) + replacement + text.slice(to);
};
const dialFailover = fs.readFileSync(path.join(here, 'assets', 'vendor', 'dial-failover.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
patched = replaceRange(patched,
  /\t\tconst 当前连接任务 = \(async \(\) => \{/,
  /\n\t\t\}\)\(\);/,
  dialFailover,
  'connecttoPry 拨号块');

// [NT-HOOK] SSTP 链路修正：应答 SSTP/PPP 保活、空闲超时放宽、RST 立即失败、TCP 序号校验。
// 补丁原文存在 assets/vendor/sstp-patches.json（JSON 保留制表符），每处锚点必须恰好命中 1 次。
const sstpPatches = JSON.parse(fs.readFileSync(path.join(here, 'assets', 'vendor', 'sstp-patches.json'), 'utf8'));
for (const p of sstpPatches) patched = applyPatch(patched, p.search, p.replace);
const bodyOut = patched;

let head = 'unknown';
try { head = execFileSync('git', ['-C', upstreamDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* 非 git 目录 */ }
const verMatch = /^const Version = '([^']+)'/m.exec(src);

const exportLines = Object.entries(EXPORTS).map(([a, b]) => (a === b ? `  ${a},` : `  ${a} as ${b},`)).join('\n');
const out = `// @ts-nocheck
// ============================================================================
// 本文件由 scripts/vendor-edt.mjs 自动生成，请勿手改。
// 来源：cmliu/edgetunnel（GPL-2.0），上游版本 ${verMatch ? verMatch[1] : '未知'}，commit ${head}
// 原作者：cmliu、zizifn 及上游贡献者。本文件逐字保留其数据面实现（协议/传输/TLS/链式代理），
// 仅删去与订阅、后台、用量相关的控制面代码，并在末尾追加 configure() 与导出。
// 许可证：GNU GPL v2，见仓库根目录 LICENSE 与 NOTICE.md。
// ============================================================================

${bodyOut}

// ---------------------------------------------------------------------------
// 以下为 nicetunnel 追加（非上游代码）
// ---------------------------------------------------------------------------
/** [NT-HOOK] 链式代理拨号结果回调：链路拨号成功/失败时上报 (ok, hostname, port)。由 adapter 注入，供地区路由健康缓存用；必须在 configure 注入前保持为 null。 */
let 链路结果钩子 = null;
/** [NT-HOOK] 地区路由的链路故障转移次数：当前候选拨不通时最多再换几台重试（0=关闭，行为与上游一致）。 */
let 链路故障转移次数 = 1;
/** [NT-HOOK] SSTP 竞速拨号路数：地区路由时同时拨几台 SSTP 候选（1=关闭，最多 2）。 */
let 链路竞速数 = 2;
/** [NT-HOOK] 首包认证失败回调：(request, message)=>void。由 adapter 注入，只对"凭据不符"按 IP 限流。 */
let 认证失败钩子 = null;
/** [NT-HOOK] 失败日志钩子：log() 里带「失败 / 超时」的行交给它（节点自报统计用）；未注入时为 null，行为与上游一致。 */
let 失败日志钩子 = null;
/** [NT-HOOK] 备用 TCP 连接器（cloudflare:sockets 的 connect）：request.fetcher 不可用时使用；备用TCP连接优先=true 时总是使用。 */
let 备用TCP连接 = null, 备用TCP连接优先 = false;

/**
 * 注入上游原本在 fetch() 里按环境变量赋值的模块级开关。
 * @param {{debug?:boolean, socks5Whitelist?:string[], tcpConcurrentDial?:number, proxyConcurrentDial?:number, preloadRaceDial?:boolean, chainResultHook?:(ok:boolean, hostname:string, port:number)=>void, chainConnectTimeoutMs?:number, chainFailover?:number, chainRace?:number, authFailHook?:(request:Request, message?:string)=>void, failLogHook?:(line:string)=>void, socketConnect?:(options:any, init?:any)=>any, preferSocketConnect?:boolean}} o
 */
export function configure(o = {}) {
  if (o.debug !== undefined) 调试日志打印 = !!o.debug;
  if (Array.isArray(o.socks5Whitelist)) SOCKS5白名单 = o.socks5Whitelist;
  if (Number.isFinite(o.tcpConcurrentDial)) TCP并发拨号数 = Math.max(1, o.tcpConcurrentDial | 0);
  if (Number.isFinite(o.proxyConcurrentDial)) 反代并发拨号数 = Math.max(1, o.proxyConcurrentDial | 0);
  if (o.preloadRaceDial !== undefined) 预加载竞速拨号 = !!o.preloadRaceDial;
  if (typeof o.chainResultHook === 'function') 链路结果钩子 = o.chainResultHook; // [NT-HOOK]
  if (Number.isFinite(o.chainConnectTimeoutMs)) 链路连接超时毫秒 = Math.max(1000, o.chainConnectTimeoutMs | 0); // [NT-HOOK]
  if (Number.isFinite(o.chainFailover)) 链路故障转移次数 = Math.min(4, Math.max(0, o.chainFailover | 0)); // [NT-HOOK]
  if (Number.isFinite(o.chainRace)) 链路竞速数 = Math.min(2, Math.max(1, o.chainRace | 0)); // [NT-HOOK]
  if (typeof o.authFailHook === 'function') 认证失败钩子 = o.authFailHook; // [NT-HOOK]
  if (typeof o.failLogHook === 'function') 失败日志钩子 = o.failLogHook; // [NT-HOOK]
  if (typeof o.socketConnect === 'function') 备用TCP连接 = o.socketConnect; // [NT-HOOK]
  if (o.preferSocketConnect !== undefined) 备用TCP连接优先 = !!o.preferSocketConnect; // [NT-HOOK]
}

export {
${exportLines}
};
`;

const dest = path.join(here, '..', 'src', 'dataplane', 'edt-core.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`已生成 ${path.relative(process.cwd(), dest)}：保留 ${ordered.length} 条顶层语句 / ${keep.size} 个节点，${(out.length / 1024).toFixed(1)} KB（上游 ${(src.length / 1024).toFixed(0)} KB）`);
