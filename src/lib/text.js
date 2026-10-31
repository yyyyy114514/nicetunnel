// 文本与地址解析小工具（纯函数，无依赖）。语义对齐上游 edgetunnel 的 整理成数组 / 订阅内容地址正则。

/**
 * 等价上游 整理成数组()：按 Tab、双引号、单引号、CR、LF、逗号切分，去掉空项。
 * 注意：上游**不按空格切分**（备注里可含空格，如 "CF优选 12ms"）；这里额外对每项 trim，结果对合法行无影响。
 * @param {string} text
 * @returns {string[]}
 */
export function splitList(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const raw of text.split(/[\t"'\r\n,]+/)) {
    const s = raw.trim();
    if (s) out.push(s);
  }
  return out;
}

// 上游同款：域名 / IPv4 / [IPv6] + 可选端口 + 可选 #备注（_worker.js 订阅内容 map 内的 regex）
const ADDRESS_LINE_RE = /^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::(\d+))?(?:#(.+))?$/;

/**
 * 解析一行地址：`addr[:port][#备注]`。
 * @param {string} line
 * @returns {{address:string, port:number|null, remark:string|null}|null} address 中 IPv6 不带方括号；不合法返回 null
 */
export function parseAddressLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.trim().match(ADDRESS_LINE_RE);
  if (!m) return null;
  let address = m[1];
  if (address.startsWith('[')) address = address.slice(1, -1);
  let port = null;
  if (m[2] !== undefined) {
    port = Number(m[2]);
    if (!(port > 0 && port < 65536)) return null;
  }
  return { address, port, remark: m[3] === undefined ? null : m[3] };
}

/** 把地址与端口拼回 `addr:port`（IPv6 加方括号） */
export function joinHostPort(address, port) {
  return (isIPv6(address) ? `[${address}]` : address) + ':' + port;
}

/** @param {string} s */
export function isIPv4(s) {
  if (typeof s !== 'string') return false;
  const p = s.split('.');
  if (p.length !== 4) return false;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return false;
  }
  return true;
}

/** 宽松 IPv6 判定（可带方括号）；仅用于分类，不做完整 RFC 校验 */
export function isIPv6(s) {
  if (typeof s !== 'string') return false;
  const t = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (!t.includes(':') || !/^[\da-fA-F:.]+$/.test(t)) return false;
  const dbl = t.split('::').length - 1;
  if (dbl > 1) return false;
  const groups = t.split(':').filter((g) => g !== '');
  if (groups.length > 8 || (dbl === 0 && groups.length < 3)) return false;
  return groups.every((g) => /^[\da-fA-F]{1,4}$/.test(g) || isIPv4(g));
}

/** IPv4 → 无符号 32 位整数；非法返回 NaN */
export function ipv4ToInt(ip) {
  if (!isIPv4(ip)) return NaN;
  const p = ip.split('.');
  return ((Number(p[0]) << 24) | (Number(p[1]) << 16) | (Number(p[2]) << 8) | Number(p[3])) >>> 0;
}

/** 无符号 32 位整数 → IPv4 */
export function intToIpv4(n) {
  n = n >>> 0;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/**
 * 解析 IPv4 CIDR（裸 IP 视为 /32），返回规范化后的网络地址与掩码。
 * @param {string} cidr
 * @returns {{base:number, prefix:number, size:number, text:string}|null}
 */
export function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const [ip, pre, extra] = cidr.trim().split('/');
  if (extra !== undefined || !isIPv4(ip)) return null;
  const prefix = pre === undefined ? 32 : /^\d{1,2}$/.test(pre) ? Number(pre) : NaN;
  if (!(prefix >= 0 && prefix <= 32)) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = (ipv4ToInt(ip) & mask) >>> 0;
  return { base, prefix, size: 2 ** (32 - prefix), text: `${intToIpv4(base)}/${prefix}` };
}

/**
 * IPv4 CIDR 是否包含某 IP（仅 IPv4；任一非法返回 false）
 * @param {string} cidr
 * @param {string} ip
 */
export function cidrContains(cidr, ip) {
  const c = parseCidr(cidr);
  const n = ipv4ToInt(ip);
  if (!c || Number.isNaN(n)) return false;
  const mask = c.prefix === 0 ? 0 : (0xffffffff << (32 - c.prefix)) >>> 0;
  return ((n & mask) >>> 0) === c.base;
}

/** decodeURIComponent 的不抛异常版本 */
export function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 标准 base64 → UTF-8 文本；失败返回 null */
export function decodeBase64Utf8(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/** 判断整段文本（去空白后）是否像标准 base64（上游 请求优选API 同款判定） */
export function looksLikeBase64(text) {
  const clean = String(text || '').replace(/\s/g, '');
  return clean.length > 0 && clean.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(clean);
}
