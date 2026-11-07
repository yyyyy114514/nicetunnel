// 通用节点列表解析（地区路由用；主站与节点站点共用，保证两边对"地区"的理解一致）。
//
// 支持的行（# 开头为注释）：
//   入口地址[:端口]#名称$sstp://用户:密码@主机:端口       edgetunnel 自定义优选格式（gate 输出就是这种）
//   入口地址[:端口]#名称 $socks5://用户:密码@主机:端口    `$` 前允许空格
//   socks5://用户:密码@主机:端口#名称                       没有入口地址的纯链式代理行（入口由主站从优选池补）
// 链式协议：socks5 / http / https / turn / sstp。
//
// 地区 = 从"名称"里提取：
//   1) 用户给定的正则（第 1 捕获组=地区，可选第 2 捕获组=类型），例如 ^(.+?)-(住宅|机房)-\d+$
//   2) 没有给正则或未匹配：按通用规则取名称里第一个 - _ 空格 或数字之前的部分作为地区，类型为空
// 名称里提不出地区的行被忽略。

export const DEFAULT_REGION_RE = '^(.+?)-(住宅|机房)-\\d+$';
const CHAIN_RE = /\$?\s*(socks5|http|https|turn|sstp):\/\/([^#\s$]+)/i;
const ADDR_RE = /^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::(\d+))?$/;

const MAX_RE_LEN = 200;
/** 量词（* + ? {n} {n,m} {n,}，懒惰标记不算）合计上限：有上限的 {0,96} 叠几个也能卡死，所以一起算 */
const MAX_QUANTIFIERS = 3;
/** 分支 | 的上限：(a|a)(a|a)… 每多一组回溯翻倍 */
const MAX_ALTERNATIONS = 3;
/** 节点名称参与正则匹配的最大长度（名称本来就短；限制长度让最坏情况的回溯也有上限） */
export const MAX_REGION_NAME_LEN = 64;
/** 列表最多处理多少条节点行：每行一次地区正则匹配，安全子集里最坏仍是多项式级（实测 5000 行约 1.4 秒，
 *  期间这个 isolate 上的连接都会卡住）。gate 之类的列表通常几百条，2000 足够 */
export const MAX_LIST_LINES = 2000;

/** 数一个（已去掉转义和字符类的）正则里有几个量词 */
function countQuantifiers(flat) {
  let n = 0;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === '*' || c === '+') n++;
    else if (c === '?') { const p = flat[i - 1]; if (p !== '(' && p !== '*' && p !== '+' && p !== '?' && p !== '}') n++; }
    else if (c === '{') { const m = /^\{\d+(?:,\d*)?\}/.exec(flat.slice(i)); if (m) { n++; i += m[0].length - 1; } }
  }
  return n;
}

/**
 * 地区正则的风险检查（主站保存设置、节点解析路径参数都用它）。返回原因，安全时返回 ''。
 * 不靠认"危险写法"（总有绕过，例如 ((a+))+ 、(a|a)+、a{0,96} 叠六个），而是只允许一个很小的安全子集：
 * 分组后面不能跟 * + {n,m}（可选的 ? 可以）；不能有反向引用；所有量词合计最多 3 个；| 最多 3 个。
 * 这样回溯量最多是"名称长度的 3 次方 × 8"，名称又截到 64 个字符，最坏也只是毫秒级。
 * 注意节点端的正则和被匹配的列表都可能来自持有 UUID 的订阅用户，所以上限必须是硬的。
 */
export function regexRisk(src) {
  const s = String(src || '');
  if (s.length > MAX_RE_LEN) return '过长';
  if (/\\[1-9]|\\k</.test(s)) return '含反向引用';
  const flat = s.replace(/\\./g, 'E').replace(/\[(?:\\.|[^\]\\])*\]/g, 'C');
  if (/\)\s*(?:[*+]|\{\d*,?\d*\})/.test(flat)) return '分组后面不能跟 * + {n,m}';
  if (countQuantifiers(flat) > MAX_QUANTIFIERS) return `量词（* + ? {n,m}）超过 ${MAX_QUANTIFIERS} 个`;
  if ((flat.match(/\|/g) || []).length > MAX_ALTERNATIONS) return `分支 | 超过 ${MAX_ALTERNATIONS} 个`;
  return '';
}

const reCache = new Map();
/** 编译地区正则；非法或有回溯风险返回 null（调用方回退到通用规则） */
export function compileRegionRe(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  if (reCache.has(s)) return reCache.get(s);
  let re = null;
  if (!regexRisk(s)) { try { re = new RegExp(s, 'u'); } catch { re = null; } }
  if (reCache.size > 8) reCache.clear();
  reCache.set(s, re);
  return re;
}

/** 名称 → {region, kind}；提不出返回 null */
export function extractRegion(name, regionRe) {
  const s = String(name || '').trim().slice(0, MAX_REGION_NAME_LEN);
  if (!s) return null;
  const re = compileRegionRe(regionRe);
  if (re) {
    const m = s.match(re);
    if (m && m[1]) return { region: m[1].trim(), kind: (m[2] || '').trim() };
  }
  const g = s.match(/^[^-_\s\d]+/u);
  return g ? { region: g[0], kind: '' } : null;
}

/**
 * 解析列表文本。
 * @param {string} text
 * @param {string} [regionRe]
 * @returns {{groups: Map<string, {region:string, kind:string, nodes:{type:string, account:string}[]}>, entries: {address:string, port:number}[], total:number}}
 *   groups 的 key = `${地区}|${类型}`，节点顺序与列表一致（列表里通常已按延迟从低到高排好）
 */
export function parseNodeList(text, regionRe) {
  const groups = new Map();
  const entryMap = new Map();
  let total = 0, seen = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const cm = line.match(CHAIN_RE);
    if (!cm) continue;
    if (++seen > MAX_LIST_LINES) break; // 超出的不再解析（不做正则匹配）
    const before = line.slice(0, cm.index).trim();
    const after = line.slice(cm.index + cm[0].length).trim();
    // 名称：优先 `入口#名称$链式` 里 # 之后；其次链式后面的 #名称
    let name = '', entry = '';
    const hi = before.indexOf('#');
    if (hi >= 0) { entry = before.slice(0, hi).trim(); name = before.slice(hi + 1).trim(); }
    else { entry = before; if (after.startsWith('#')) name = after.slice(1).trim(); }
    if (after.startsWith('#') && !name) name = after.slice(1).trim();
    try { name = decodeURIComponent(name); } catch { /* 保持原样 */ }
    const r = extractRegion(name, regionRe);
    if (!r) continue;
    total++;
    const key = r.region + '|' + r.kind;
    let g = groups.get(key);
    if (!g) { g = { region: r.region, kind: r.kind, nodes: [] }; groups.set(key, g); }
    g.nodes.push({ type: cm[1].toLowerCase(), account: cm[2] });
    const am = entry.match(ADDR_RE);
    // 端口必须是 1~65535（之前 Number(port) || 443 会接受 99999 之类的值）
    if (am) { const port = Number(am[2]); entryMap.set(am[1].replace(/^\[|\]$/g, ''), Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 443); }
  }
  return { groups, entries: [...entryMap].map(([address, port]) => ({ address, port })), total };
}
