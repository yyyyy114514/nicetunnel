// Clash（mihomo）YAML 渲染。不依赖外部 SUBAPI；节点参数与上游 Clash订阅配置文件热补丁（4821–5036 行）的最终效果对齐：
// DNS 基础块、ECH(ech-opts + nameserver-policy)、gRPC UA。
// 输出约定：代理/组/规则提供者均用 JSON 流式写法（JSON 是 YAML 1.2 的子集，go-yaml 可直接解析，免去转义问题）。
import { toProxyDescriptor, splitEarlyData } from './params.js';
import { parseNodeLink } from './linkparse.js';

const BASE_HEAD = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
`;

// 与上游 baseDnsBlock 一致
const BASE_DNS = `dns:
  enable: true
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
    - 114.114.114.114
  use-hosts: true
  nameserver:
    - https://sm2.doh.pub/dns-query
    - https://dns.alidns.com/dns-query
  fallback:
    - 8.8.4.4
    - 208.67.220.220
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4
      - 127.0.0.1/32
      - 0.0.0.0/32
    domain:
      - '+.google.com'
      - '+.facebook.com'
      - '+.youtube.com'
`;

/**
 * ProxyDescriptor → mihomo 代理对象
 * @param {import('../../types.js').ProxyDescriptor & {grpcUserAgent?:string, xudp?:boolean}} d
 */
export function clashProxy(d, name) {
  /** @type {Record<string, any>} */
  const p = { name, type: d.type, server: d.server, port: d.port };
  if (d.type === 'ss') {
    Object.assign(p, { cipher: d.ss.method, password: d.uuid, udp: d.udp, plugin: 'v2ray-plugin' });
    p['plugin-opts'] = { mode: 'websocket', tls: d.tls, host: d.host, path: d.path, mux: false };
    if (d.tls && d.skipCertVerify) p['plugin-opts']['skip-cert-verify'] = true;
    return p;
  }
  if (d.type === 'vless') { p.uuid = d.uuid; p.encryption = ''; } else p.password = d.uuid;
  p.udp = d.udp;
  if (d.type === 'vless' && d.xudp) p['packet-encoding'] = 'xudp';
  p.tls = true;
  p[d.type === 'vless' ? 'servername' : 'sni'] = d.sni;
  p['client-fingerprint'] = d.fingerprint;
  if (d.alpn.length) p.alpn = d.alpn;
  p['skip-cert-verify'] = d.skipCertVerify;
  if (d.network === 'grpc') {
    p.network = 'grpc';
    p['grpc-opts'] = { 'grpc-service-name': d.path.replace(/^\//, '') };
    if (d.grpcUserAgent) p['grpc-opts']['grpc-user-agent'] = d.grpcUserAgent;
  } else {
    // xhttp：mihomo 对 VLESS XHTTP 及上游的 xPadding 混淆参数支持情况未确认，统一回退 WS（数据面同时接受 WS，不影响连通）
    const { path, ed } = splitEarlyData(d.path);
    p.network = 'ws';
    p['ws-opts'] = { path, headers: { Host: d.host } };
    if (ed) { p['ws-opts']['max-early-data'] = ed; p['ws-opts']['early-data-header-name'] = 'Sec-WebSocket-Protocol'; }
  }
  if (d.ech) {
    p['ech-opts'] = { enable: true };
    if (d.ech.sni) p['ech-opts']['query-server-name'] = d.ech.sni;
  }
  return p;
}

/**
 * 汇聚订阅里的完整链接 → mihomo 代理对象；不支持返回 null
 * @param {import('./linkparse.js').ParsedLink} l
 */
export function clashProxyFromLink(l, name) {
  /** @type {Record<string, any>} */
  const p = { name, type: l.type, server: l.server, port: l.port };
  if (l.type === 'ss') {
    Object.assign(p, { cipher: l.cipher, password: l.password, udp: true });
    if (l.plugin?.name?.startsWith('v2ray')) {
      p.plugin = 'v2ray-plugin';
      p['plugin-opts'] = { mode: l.plugin.mode || 'websocket', tls: !!l.plugin.tls, host: l.plugin.host, path: l.plugin.path, mux: !!l.plugin.mux };
    } else if (l.plugin) return null;
    return p;
  }
  if (l.type === 'hysteria2') {
    Object.assign(p, { password: l.password, sni: l.sni, 'skip-cert-verify': !!l.skipCertVerify });
    return p;
  }
  if (l.type === 'tuic') {
    Object.assign(p, { uuid: l.uuid, password: l.password, sni: l.sni, alpn: l.alpn || ['h3'] });
    return p;
  }
  if (l.type === 'vmess') Object.assign(p, { uuid: l.uuid, alterId: l.alterId || 0, cipher: l.cipher || 'auto' });
  else if (l.type === 'vless') { p.uuid = l.uuid; if (l.flow) p.flow = l.flow; }
  else p.password = l.password;
  p.udp = true;
  if (l.tls || l.type === 'trojan') {
    p.tls = true;
    if (l.sni) p[l.type === 'trojan' ? 'sni' : 'servername'] = l.sni;
    if (l.fingerprint) p['client-fingerprint'] = l.fingerprint;
    if (l.alpn?.length) p.alpn = l.alpn;
    if (l.skipCertVerify) p['skip-cert-verify'] = true;
    if (l.reality) p['reality-opts'] = { 'public-key': l.reality.publicKey, 'short-id': l.reality.shortId };
    if (l.ech) p['ech-opts'] = { enable: true, ...(l.ech.sni ? { 'query-server-name': l.ech.sni } : {}) };
  }
  if (l.network === 'ws') {
    const { path, ed } = splitEarlyData(l.path || '/');
    p.network = 'ws';
    p['ws-opts'] = { path, ...(l.host ? { headers: { Host: l.host } } : {}) };
    if (ed) { p['ws-opts']['max-early-data'] = ed; p['ws-opts']['early-data-header-name'] = 'Sec-WebSocket-Protocol'; }
  } else if (l.network === 'grpc') {
    p.network = 'grpc';
    p['grpc-opts'] = { 'grpc-service-name': l.serviceName || '' };
  } else if (l.network === 'h2' || l.network === 'http') {
    p.network = l.network;
    if (l.network === 'h2') p['h2-opts'] = { path: l.path || '/', ...(l.host ? { host: [l.host] } : {}) };
  } else if (l.network === 'xhttp') return null;
  return p;
}

/** YAML 列表项（JSON 流式） */
const item = (obj, indent = '  ') => `${indent}- ${JSON.stringify(obj)}`;

/**
 * @param {{proxies: {name:string, desc?:any, link?:any}[], groups: import('./groups.js').ResolvedGroup[],
 *          rules: {rules:string, providers?: {name:string,url:string,behavior:string,format:string,interval?:number}[]}|null,
 *          ctx: object, intervalOf?: (ini:number)=>number}} o
 * @returns {string}
 */
export function renderClash({ proxies, groups, rules, ctx, intervalOf = (x) => Number(x) || 300 }) {
  const out = [BASE_HEAD];
  // DNS：ECH 开启时为承载域名指定 ECH DNS（上游 nameserver-policy 逻辑）
  let dns = BASE_DNS;
  const echDesc = proxies.find((p) => p.desc?.ech)?.desc;
  if (echDesc) {
    const hosts = [...new Set(proxies.filter((p) => p.desc?.ech).map((p) => p.desc.host).concat(echDesc.ech.sni ? [echDesc.ech.sni] : []))];
    dns += '  nameserver-policy:\n' + hosts.map((h) => `    ${JSON.stringify(h)}: ${JSON.stringify(echDesc.ech.dns)}`).join('\n') + '\n';
  }
  out.push(dns);

  out.push('proxies:');
  for (const p of proxies) out.push(item(p.obj));
  if (!proxies.length) out.push(item({ name: 'DIRECT-placeholder', type: 'direct' }));

  out.push('proxy-groups:');
  for (const g of groups) {
    /** @type {Record<string, any>} */
    const o = { name: g.name, type: g.type, proxies: g.proxies };
    if (g.type !== 'select') {
      o.url = g.url || 'http://www.gstatic.com/generate_204';
      o.interval = intervalOf(g.interval);
      if (g.tolerance !== undefined && g.type === 'url-test') o.tolerance = g.tolerance;
      if (g.timeout !== undefined) o.timeout = g.timeout;
      // 只在组被选中使用时才测速：客户端测速每次 = 每节点 1 次 Worker 请求，是额度大头
      o.lazy = true;
      if (g.type === 'load-balance') o.strategy = 'consistent-hashing';
    }
    out.push(item(o));
  }

  if (rules?.providers?.length) {
    out.push('rule-providers:');
    for (const pr of rules.providers) {
      out.push(`  ${JSON.stringify(pr.name)}: ${JSON.stringify({ type: 'http', behavior: pr.behavior, format: pr.format, url: pr.url, path: `./ruleset/${pr.name}.${pr.format === 'yaml' ? 'yaml' : 'list'}`, interval: pr.interval || 86400 })}`);
    }
  }
  out.push('rules:');
  const body = rules?.rules || '';
  // 规则块已在 Cron 侧规范化（不含需要引号的字符），这里只做一次原生 split/join
  // 规则块在 Cron 侧已预先缩进成 YAML 列表（rules.yaml）：热路径只做拼接，不再对几万行做 split/join（免费版 CPU 只有 10ms）
  if (rules?.yaml) out.push(rules.yaml);
  else if (body) out.push('  - ' + body.split('\n').join('\n  - '));
  else out.push('  - MATCH,' + (groups.find((g) => !g.notice)?.name || 'DIRECT'));
  return out.join('\n') + '\n';
}

export { parseNodeLink };
