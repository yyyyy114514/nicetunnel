// 分享链接解析：把汇聚订阅里自带的完整节点链接（origin='link'）转成通用结构，供 Clash / Surge / sing-box 渲染。
// 支持 vless / trojan / vmess / ss（SIP002 + v2ray-plugin）；hysteria2 / tuic 尽力而为。无法解析返回 null（渲染器跳过并计入警告）。
import { safeDecode, decodeBase64Utf8 } from '../../lib/text.js';

/**
 * @typedef {Object} ParsedLink
 * @property {'vless'|'trojan'|'vmess'|'ss'|'hysteria2'|'tuic'} type
 * @property {string} name
 * @property {string} server
 * @property {number} port
 * @property {string} [uuid]       vless/vmess/tuic
 * @property {string} [password]   trojan/ss/hysteria2/tuic
 * @property {string} [cipher]     ss / vmess
 * @property {number} [alterId]
 * @property {boolean} tls
 * @property {string} [sni]
 * @property {string} [host]
 * @property {'tcp'|'ws'|'grpc'|'xhttp'|'h2'|'http'} network
 * @property {string} [path]
 * @property {string} [serviceName]
 * @property {string} [grpcMode]
 * @property {string[]} [alpn]
 * @property {string} [fingerprint]
 * @property {boolean} [skipCertVerify]
 * @property {string} [flow]
 * @property {{publicKey:string, shortId:string}} [reality]
 * @property {{enable:boolean, sni?:string}} [ech]
 * @property {object} [plugin]     ss v2ray-plugin: {mode, host, path, tls, mux}
 */

/** 去掉 IPv6 方括号 */
const unbracket = (h) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);
const b64 = (s) => decodeBase64Utf8(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
const truthy = (v) => v === '1' || v === 'true';

/** 用 URL 解析 scheme://userinfo@host:port?query#name；非特殊 scheme 下 URL 会保留 host */
function parseStd(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  const port = Number(u.port);
  if (!u.hostname || !(port > 0 && port < 65536)) return null;
  return { u, server: unbracket(u.hostname), port, user: safeDecode(u.username), name: safeDecode(u.hash.slice(1)), q: u.searchParams };
}

function commonTransport(q, out) {
  const net = (q.get('type') || 'tcp').toLowerCase();
  out.network = /** @type {any} */ (['ws', 'grpc', 'xhttp', 'h2', 'http', 'tcp'].includes(net) ? net : 'tcp');
  const sec = (q.get('security') || '').toLowerCase();
  out.tls = sec === 'tls' || sec === 'reality' || out.tls === true;
  out.sni = q.get('sni') || q.get('peer') || undefined;
  out.host = q.get('host') || q.get('authority') || undefined;
  if (out.network === 'grpc') {
    out.serviceName = q.get('serviceName') || q.get('path') || '';
    out.grpcMode = q.get('mode') || 'gun';
  } else out.path = q.get('path') || undefined;
  const alpn = q.get('alpn');
  if (alpn) out.alpn = alpn.split(',').map((s) => s.trim()).filter(Boolean);
  if (q.get('fp')) out.fingerprint = q.get('fp');
  if (truthy(q.get('allowInsecure') || q.get('insecure') || '')) out.skipCertVerify = true;
  if (q.get('flow')) out.flow = q.get('flow');
  if (sec === 'reality') out.reality = { publicKey: q.get('pbk') || '', shortId: q.get('sid') || '' };
  if (q.get('ech')) out.ech = { enable: true, sni: q.get('ech').includes('+') ? q.get('ech').split('+')[0] : undefined };
  return out;
}

function parseVmess(link) {
  const txt = b64(link.slice(8).trim());
  if (!txt) return null;
  let j;
  try { j = JSON.parse(txt); } catch { return null; }
  const port = Number(j.port);
  if (!j.add || !(port > 0)) return null;
  const net = String(j.net || 'tcp').toLowerCase();
  /** @type {ParsedLink} */
  const out = {
    type: 'vmess', name: String(j.ps || ''), server: unbracket(String(j.add)), port, uuid: String(j.id || ''),
    alterId: Number(j.aid) || 0, cipher: j.scy || 'auto', tls: String(j.tls || '').toLowerCase() === 'tls',
    network: /** @type {any} */ (['ws', 'grpc', 'h2', 'http', 'tcp', 'xhttp'].includes(net) ? net : 'tcp'),
  };
  if (j.sni) out.sni = String(j.sni);
  if (j.host) out.host = String(j.host);
  if (out.network === 'grpc') out.serviceName = String(j.path || '');
  else if (j.path) out.path = String(j.path);
  if (j.alpn) out.alpn = String(j.alpn).split(',').filter(Boolean);
  if (j.fp) out.fingerprint = String(j.fp);
  return out;
}

function parseSs(link) {
  // SIP002：ss://base64(method:password)@host:port/?plugin=…#name；或旧式 ss://base64(method:password@host:port)#name
  const hashAt = link.indexOf('#');
  const name = hashAt > -1 ? safeDecode(link.slice(hashAt + 1)) : '';
  let body = hashAt > -1 ? link.slice(5, hashAt) : link.slice(5);
  if (!body.includes('@')) {
    const dec = b64(body.split('?')[0]);
    if (!dec) return null;
    body = dec;
  }
  const at = body.lastIndexOf('@');
  let userinfo = body.slice(0, at);
  if (!userinfo.includes(':')) userinfo = b64(safeDecode(userinfo)) || '';
  else userinfo = safeDecode(userinfo);
  const ci = userinfo.indexOf(':');
  if (ci < 0) return null;
  const p = parseStd('ss://x@' + body.slice(at + 1).replace(/^([^/?]*)\/?\?/, '$1/?'));
  if (!p) return null;
  /** @type {ParsedLink} */
  const out = { type: 'ss', name, server: p.server, port: p.port, cipher: userinfo.slice(0, ci), password: userinfo.slice(ci + 1), tls: false, network: 'tcp' };
  const plugin = p.q.get('plugin');
  if (plugin && /^v2ray-plugin|^obfs-local|^simple-obfs/.test(plugin)) {
    const parts = plugin.split(';');
    const opts = { name: parts[0], mode: 'websocket', host: '', path: '/', tls: false, mux: true };
    for (const kv of parts.slice(1)) {
      const i = kv.indexOf('=');
      const k = i > -1 ? kv.slice(0, i) : kv;
      const v = i > -1 ? kv.slice(i + 1).replace(/\\([=,;])/g, '$1') : '';
      if (k === 'tls') opts.tls = true;
      else if (k === 'mode') opts.mode = v;
      else if (k === 'host') opts.host = v;
      else if (k === 'path') opts.path = v;
      else if (k === 'mux') opts.mux = v !== '0';
    }
    out.plugin = opts;
    if (opts.name.startsWith('v2ray')) { out.network = 'ws'; out.tls = opts.tls; out.host = opts.host; out.path = opts.path; out.sni = opts.host; }
  }
  return out;
}

/**
 * @param {string} link
 * @returns {ParsedLink|null}
 */
export function parseNodeLink(link) {
  const s = String(link || '').trim();
  const scheme = s.slice(0, s.indexOf('://')).toLowerCase();
  try {
    if (scheme === 'vmess') return parseVmess(s);
    if (scheme === 'ss') return parseSs(s);
    if (scheme === 'vless' || scheme === 'trojan') {
      const p = parseStd(s);
      if (!p || !p.user) return null;
      /** @type {any} */
      const out = { type: scheme, name: p.name, server: p.server, port: p.port, tls: scheme === 'trojan' && p.q.get('security') !== 'none' };
      if (scheme === 'vless') out.uuid = p.user; else out.password = p.user;
      return commonTransport(p.q, out);
    }
    if (scheme === 'hysteria2' || scheme === 'hy2') {
      const p = parseStd(s.replace(/^hy2:/i, 'hysteria2:'));
      if (!p) return null;
      return { type: 'hysteria2', name: p.name, server: p.server, port: p.port, password: p.user, tls: true, network: 'tcp', sni: p.q.get('sni') || undefined, skipCertVerify: truthy(p.q.get('insecure') || '') };
    }
    if (scheme === 'tuic') {
      const p = parseStd(s);
      if (!p) return null;
      const pw = safeDecode(p.u.password);
      return { type: 'tuic', name: p.name, server: p.server, port: p.port, uuid: p.user, password: pw, tls: true, network: 'tcp', sni: p.q.get('sni') || undefined, alpn: p.q.get('alpn') ? p.q.get('alpn').split(',') : undefined };
    }
  } catch { /* 非法链接 */ }
  return null;
}
