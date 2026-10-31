// mixed 订阅：明文链接（每行一个）与 base64 版本。链接格式逐项对齐上游 _worker.js 401–455 行。
import { joinHostPort } from '../../lib/text.js';
import { toProxyDescriptor } from './params.js';

/** TLS 分片参数（上游 353 行） */
function fragmentParam(f) {
  if (f === 'Shadowrocket') return `&fragment=${encodeURIComponent('1,40-60,30-50,tlshello')}`;
  if (f === 'Happ') return `&fragment=${encodeURIComponent('3,1,tlshello')}`;
  return '';
}

/** ECH 参数（上游 401 行）：ech=<SNI+>DNS */
function echParam(ech) {
  if (!ech) return '';
  return `&ech=${encodeURIComponent((ech.sni ? ech.sni + '+' : '') + ech.dns)}`;
}

/**
 * 单个 ProxyDescriptor → 分享链接
 * @param {import('../../types.js').ProxyDescriptor & {grpcUserAgent?:string}} d
 * @param {{loonOrSurge?:boolean, name?:string}} [opt]
 */
export function descriptorToLink(d, opt = {}) {
  const name = encodeURIComponent(opt.name ?? d.name);
  const hp = joinHostPort(d.server, d.port);
  let path = d.path;
  if (opt.loonOrSurge) path = path.replace(/,/g, '%2C');
  if (d.type === 'ss') {
    // 上游 449–451：路径里插入 enc=，转义 = 与 , ；mux=0；v2ray-plugin websocket
    let p = (path.includes('?') ? path.replace('?', '?enc=' + d.ss.method + '&') : path + '?enc=' + d.ss.method).replace(/([=,])/g, '\\$1');
    p += ';mux=0';
    const plugin = 'v2ray-plugin;mode=websocket;host=' + d.host + ';path=' + p + (d.tls ? ';tls' : '');
    return `ss://${btoa(d.ss.method + ':' + d.uuid)}@${hp}?plugin=v2${encodeURIComponent(plugin.slice(2))}${echParam(d.ech)}${fragmentParam(d.tlsFragment)}#${name}`;
  }
  let type = d.network;
  if (d.network === 'grpc') type = `grpc&mode=${d.grpcMode === 'multi' ? 'multi' : 'gun'}`;
  else if (d.network === 'xhttp') type = `xhttp&mode=stream-one&extra=${encodeURIComponent(JSON.stringify(d.xhttpExtra))}`;
  const hostField = d.network === 'grpc' ? 'authority' : 'host';
  const pathField = d.network === 'grpc' ? 'serviceName' : 'path';
  return `${d.type}://${d.uuid}@${hp}?security=tls&type=${type}${echParam(d.ech)}&${hostField}=${d.host}&fp=${d.fingerprint}&sni=${d.sni}`
    + `&${pathField}=${encodeURIComponent(path)}${fragmentParam(d.tlsFragment)}&encryption=none&alpn=${encodeURIComponent(d.alpn.join(','))}`
    + (d.skipCertVerify ? '&allowInsecure=1' : '')
    + `#${name}`;
}

/**
 * @param {import('../../types.js').ResolvedNode[]} nodes
 * @param {object} ctx SubContext
 * @param {(n:any)=>string} [nameOf] 显示名（appendType 等）
 */
export function renderMixedLinks(nodes, ctx, nameOf) {
  const ua = String(ctx.userAgent || '').toLowerCase();
  const loonOrSurge = ua.includes('loon') || ua.includes('surge');
  const links = [];
  const others = [];
  for (const n of nodes) {
    if (n.origin === 'link') { if (n.link) others.push(n.link); continue; }
    if (!n.address) continue;
    const d = toProxyDescriptor(n, ctx);
    links.push(descriptorToLink(d, { loonOrSurge, name: nameOf ? nameOf(d) : d.name }));
  }
  // 与上游一致：其他节点链接在前
  return others.concat(links).join('\n');
}

/** UTF-8 安全的 base64 */
export function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function renderMixedBase64(nodes, ctx, nameOf) {
  return base64Utf8(renderMixedLinks(nodes, ctx, nameOf));
}
