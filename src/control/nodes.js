// 节点合并：优质(custom) + 兜底(random) → NodeSpec[]。
// 负责：完整节点路径（上游 5766–5784 行）、链式代理 /video/<密文>（上游 427–436 行）、反代IP池路径（上游 437–440 行）、
// '*' 通配展开、去重、截断、全局唯一命名、稳定 id。
// 数据面函数（base64SecretEncode / parseChainAccount / defaultChainPort / replaceStars）通过 deps 注入，不直接 import edt-core。

import { hash32 } from '../lib/rand.js';
import { joinHostPort, safeDecode, decodeBase64Utf8 } from '../lib/text.js';

/** 备注里的链式代理指令（上游同款正则） */
export const CHAIN_RE = /\$(socks5|http|https|turn|sstp):\/\/([^#\s]+)/i;
const CHAIN_MODES = ['socks5', 'http', 'https', 'turn', 'sstp'];

/**
 * 普通节点的"完整节点路径"（逐行移植上游 5766–5784）。
 * - mode 为 socks5/http/https/turn/sstp 且填了账号：全局 → `${mode}://账号`，标准 → `${mode}=账号`
 * - 否则 proxyip 非 'auto' → `proxyip=值`
 * - 反代参数里的 `?query` 拆出来拼到查询串；最后按 zeroRtt 追加 ed=2560（有 query 用 &，否则 ?）
 * @param {object} settings
 * @returns {{path:string, basePath:string}} basePath 为去掉反代参数后的 PATH（反代IP池路径用）
 */
export function buildNodePath(settings) {
  const node = settings?.node || {};
  const proxy = settings?.proxy || {};
  const zeroRtt = !!node.zeroRtt;
  let param = '';
  const account = proxy.chain?.account || '';
  if (CHAIN_MODES.includes(proxy.mode) && account) param = proxy.chain?.global ? `${proxy.mode}://${account}` : `${proxy.mode}=${account}`;
  else if (proxy.proxyip && proxy.proxyip !== 'auto') param = `proxyip=${proxy.proxyip}`;

  let proxyQuery = '';
  if (param.includes('?')) [param, proxyQuery] = param.split('?');

  const basePath = String(node.path || '/').replace(param, '').replace('//', '/');
  const normalized = basePath === '/' ? '' : basePath.replace(/\/+(?=\?|$)/, '').replace(/\/+$/, '');
  const [pathPart, ...qs] = normalized.split('?');
  const query = qs.length ? '?' + qs.join('?') : '';
  const finalQuery = proxyQuery ? (query ? query + '&' + proxyQuery : '?' + proxyQuery) : query;
  const path = (pathPart || '/') + (pathPart && param ? '/' : '') + param + finalQuery + (zeroRtt ? (finalQuery ? '&' : '?') + 'ed=2560' : '');
  return { path, basePath };
}

/** 反代IP池命中时的路径（上游 439 行：`${PATH}/proxyip=${ip}` 去双斜杠 + ?ed=2560） */
export function proxyIpPath(basePath, proxyIp, zeroRtt) {
  return `${basePath}/proxyip=${proxyIp}`.replace(/\/\//g, '/') + (zeroRtt ? '?ed=2560' : '');
}

/**
 * 解析备注里的链式指令并生成 /video/<密文> 路径。解析失败返回 null（上游：忽略该指令，备注保持原样）。
 * @returns {{path:string, remark:string, chain:string}|null}
 */
export function resolveChain(remark, { uuid, zeroRtt, deps }) {
  const m = String(remark || '').match(CHAIN_RE);
  if (!m) return null;
  const { base64SecretEncode, parseChainAccount, defaultChainPort } = deps || {};
  if (typeof base64SecretEncode !== 'function' || typeof parseChainAccount !== 'function') return null;
  try {
    const type = m[1].toLowerCase();
    const acc = parseChainAccount(m[2], typeof defaultChainPort === 'function' ? defaultChainPort(type) : 80);
    const data = { type, ...acc };
    const path = `/video/${base64SecretEncode(JSON.stringify(data), uuid) + (zeroRtt ? '?ed=2560' : '')}`;
    const user = acc.username ? `${acc.username}@` : '';
    return { path, remark: remark.replace(m[0], '').trim(), chain: `${type}://${user}${acc.hostname}:${acc.port}` };
  } catch {
    return null;
  }
}

/** 稳定 id：hash(address|port|path|link)，16 位十六进制 */
export function nodeId({ address = '', port = '', path = '', link = '' }) {
  const s = `${address}|${port}|${path}|${link}`;
  return hash32(s).toString(16).padStart(8, '0') + hash32(s, 0x9747b28c).toString(16).padStart(8, '0');
}

/** 名字去重：重名时追加 -2、-3 …（保留原关键字，分组正则仍能命中） */
export function makeUniqueNamer(used = new Set()) {
  return (base) => {
    let name = base, k = 2;
    while (used.has(name)) name = `${base}-${k++}`;
    used.add(name);
    return name;
  };
}

/** 从完整链接里取显示名：#片段，或 vmess base64 JSON 的 ps */
function linkName(link) {
  const hi = link.indexOf('#');
  if (hi > -1) return safeDecode(link.slice(hi + 1)).trim();
  if (/^vmess:\/\//i.test(link)) {
    const txt = decodeBase64Utf8(link.slice(8).trim());
    try { return String(JSON.parse(txt).ps || '').trim(); } catch { return ''; }
  }
  return '';
}

/**
 * 合并优质与兜底节点。
 * @param {{custom: import('./sources.js').CustomEntry[]|{entries:any[]}, random: import('../types.js').NodeSpec[], settings: object, uuid: string,
 *          deps: {base64SecretEncode:Function, parseChainAccount:Function, defaultChainPort:Function, replaceStars?:Function}}} o
 * @returns {import('../types.js').NodeSpec[]} 顺序：优质地址 → 优质链接 → 兜底；name 全局唯一
 */
export function buildNodeSpecs({ custom, random, settings, uuid, deps = {} }) {
  const list = Array.isArray(custom) ? custom : custom?.entries || [];
  const zeroRtt = !!settings?.node?.zeroRtt;
  const { path: normalPath, basePath } = buildNodePath(settings);
  const maxNodes = Number(settings?.preferred?.custom?.maxNodes) || 0;

  // 反代IP池：来自 proxyip=true 来源的 addr:port（上游 请求优选API 第 4 项）。
  // 上游用 p.includes(地址) 子串匹配，会把 1.2.3.4 误配到 11.2.3.45；这里按地址精确匹配。
  const proxyPool = new Map();
  for (const e of list) {
    if (e.kind === 'addr' && e.proxyIp && !proxyPool.has(e.address)) proxyPool.set(e.address, joinHostPort(e.address, e.port));
  }

  const seen = new Set();
  const customSpecs = [];
  const linkSpecs = [];
  for (const e of list) {
    if (e.kind === 'link') {
      if (!e.link || seen.has('L|' + e.link)) continue;
      seen.add('L|' + e.link);
      linkSpecs.push({ id: nodeId({ link: e.link }), base: linkName(e.link), origin: 'link', link: e.link, tags: [e.best ? 'best' : 'custom', 'link'], best: !!e.best });
      continue;
    }
    if (e.kind !== 'addr' || !e.address) continue;
    const port = Number(e.port) || 443;
    let remark = e.remark || '';
    let path = normalPath, chain;
    // 优选订阅只提供 CF 入口 IP，来自第三方：不解析备注里的链式指令（否则一行 `IP#名$socks5://…@攻击者:端口`
    // 就能让用户流量改走别人的代理）。指令部分从名字里去掉
    if (e.best && remark.includes('$')) remark = remark.slice(0, remark.indexOf('$')).trim();
    const c = e.best ? null : resolveChain(remark, { uuid, zeroRtt, deps });
    if (c) ({ path, remark, chain } = c);
    else if (proxyPool.has(e.address)) path = proxyIpPath(basePath, proxyPool.get(e.address), zeroRtt);
    const key = `${e.address}|${port}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 通配地址：id/去重/默认名都用原始模式（保证稳定），地址本身按请求展开（上游 替换星号为随机字符）
    const address = e.wildcard && typeof deps.replaceStars === 'function' ? deps.replaceStars(e.address) : e.address;
    const origin = e.best ? 'best' : 'custom';
    const spec = { id: nodeId({ address: e.address, port, path }), base: e.best ? `CF-${settings?.preferred?.best?.namePrefix || '优选'}-${remark || e.address}` : remark || `优质-${e.address}`, origin, address, port, path, tags: chain ? [origin, 'chain'] : [origin] };
    if (chain) spec.chain = chain;
    customSpecs.push(spec);
  }

  // maxNodes 只限制"优质(自定义)"；优选订阅另有 best.maxNodes（在 bestfeed 里已截断）
  const limit = (list) => (maxNodes > 0 ? list.slice(0, maxNodes) : list);
  const isBest = (s) => s.origin === 'best' || s.best;
  let chosen = limit(customSpecs.filter((s) => !isBest(s))).concat(customSpecs.filter(isBest), limit(linkSpecs.filter((s) => !isBest(s))), linkSpecs.filter(isBest));

  const nameOf = makeUniqueNamer();
  const out = [];
  for (const s of chosen) {
    const { base, best, ...spec } = s; // eslint-disable-line no-unused-vars
    spec.name = nameOf(base || (spec.origin === 'link' ? '节点' : `优质-${spec.address}`));
    // 链接自带 #名字且被改名时同步改写片段，保证客户端看到的名字与分组匹配一致
    if (spec.origin === 'link' && spec.name !== base && spec.link.includes('#')) spec.link = spec.link.slice(0, spec.link.indexOf('#') + 1) + encodeURIComponent(spec.name);
    out.push(spec);
  }
  for (const r of Array.isArray(random) ? random : []) {
    const key = `${r.address}|${r.port}|${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, name: nameOf(r.name) });
  }
  return out;
}
