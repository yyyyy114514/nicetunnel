// sing-box 配置渲染（rule action / rule_set；不使用已移除的 geoip/geosite 数据库）。
// DNS 默认用 1.12+ 的新写法（服务器 type + server、route.default_domain_resolver）：旧写法（address: 'https://…'、
// detour: 'direct'、DNS 规则 outbound: 'any'）在 1.12 弃用、1.14 移除，新版客户端拿到旧配置会直接起不来。
// UA 能看出是 1.12 以下的老客户端时继续给旧写法（老客户端不认新写法）。
// 规则：rulesfeed 在 Cron 侧把每个规则集合并为 sing-box 的 headless rule JSON（domain / domain_suffix / ip_cidr …），
// 订阅时只拼接字符串。未展开的规则集以 remote rule_set 引用（需要 .srs/.json 源，普通 .list 文本 sing-box 不支持 → 跳过并告警）。
import { splitEarlyData } from './params.js';

/** ProxyDescriptor → sing-box outbound */
export function singboxOutbound(d, tag) {
  /** @type {Record<string, any>} */
  const o = { type: d.type === 'ss' ? 'shadowsocks' : d.type, tag, server: d.server, server_port: d.port };
  if (d.type === 'ss') {
    Object.assign(o, { method: d.ss.method, password: d.uuid, plugin: 'v2ray-plugin', plugin_opts: `mode=websocket;host=${d.host};path=${d.path}${d.tls ? ';tls' : ''};mux=0` });
    return o;
  }
  if (d.type === 'vless') { o.uuid = d.uuid; if (d.xudp) o.packet_encoding = 'xudp'; } else o.password = d.uuid;
  o.tls = { enabled: true, server_name: d.sni, insecure: d.skipCertVerify, utls: { enabled: true, fingerprint: d.fingerprint } };
  if (d.alpn.length) o.tls.alpn = d.alpn;
  if (d.ech) o.tls.ech = { enabled: true };
  if (d.network === 'grpc') o.transport = { type: 'grpc', service_name: d.path.replace(/^\//, '') };
  else {
    // XHTTP：sing-box 不支持，回退 WS（数据面同样接受）
    const { path, ed } = splitEarlyData(d.path);
    o.transport = { type: 'ws', path, headers: { Host: d.host } };
    if (ed) { o.transport.max_early_data = ed; o.transport.early_data_header_name = 'Sec-WebSocket-Protocol'; }
  }
  return o;
}

/** 解析后的分享链接 → outbound；不支持返回 null */
export function singboxOutboundFromLink(l, tag) {
  /** @type {Record<string, any>} */
  const o = { type: l.type === 'ss' ? 'shadowsocks' : l.type, tag, server: l.server, server_port: l.port };
  if (l.type === 'ss') {
    Object.assign(o, { method: l.cipher, password: l.password });
    if (l.plugin) {
      if (!l.plugin.name.startsWith('v2ray')) return null;
      o.plugin = 'v2ray-plugin';
      o.plugin_opts = `mode=${l.plugin.mode};host=${l.plugin.host};path=${l.plugin.path}${l.plugin.tls ? ';tls' : ''}`;
    }
    return o;
  }
  if (l.type === 'vless') { o.uuid = l.uuid; if (l.flow) o.flow = l.flow; }
  else if (l.type === 'vmess') Object.assign(o, { uuid: l.uuid, alter_id: l.alterId || 0, security: l.cipher || 'auto' });
  else if (l.type === 'tuic') Object.assign(o, { uuid: l.uuid, password: l.password });
  else o.password = l.password;
  if (l.tls || l.type === 'trojan' || l.type === 'hysteria2' || l.type === 'tuic') {
    o.tls = { enabled: true, insecure: !!l.skipCertVerify };
    if (l.sni) o.tls.server_name = l.sni;
    if (l.alpn?.length) o.tls.alpn = l.alpn;
    if (l.fingerprint) o.tls.utls = { enabled: true, fingerprint: l.fingerprint };
    if (l.reality) o.tls.reality = { enabled: true, public_key: l.reality.publicKey, short_id: l.reality.shortId };
  }
  if (l.network === 'ws') {
    const { path, ed } = splitEarlyData(l.path || '/');
    o.transport = { type: 'ws', path, ...(l.host ? { headers: { Host: l.host } } : {}) };
    if (ed) { o.transport.max_early_data = ed; o.transport.early_data_header_name = 'Sec-WebSocket-Protocol'; }
  } else if (l.network === 'grpc') o.transport = { type: 'grpc', service_name: l.serviceName || '' };
  else if (l.network === 'xhttp' || l.network === 'h2' || l.network === 'http') return null;
  return o;
}

/**
 * @param {{outbounds: object[], groups: import('./groups.js').ResolvedGroup[], rules: {rules:string, ruleSets?:object[]}|null, intervalOf?:(ini:number)=>number}} o
 * @returns {string}
 */
/** 从 UA 里读 sing-box 版本（"sing-box 1.11.4"、"SFA/1.11.4 …"）；读不出返回 null */
export function singboxVersion(ua) {
  const m = /sing-?box[\s/]v?(\d+)\.(\d+)/i.exec(String(ua || '')) || /\bSF[AIMT]\/(\d+)\.(\d+)/.exec(String(ua || ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}
/** 1.12 以下的老客户端用旧 DNS 写法；读不出版本的按新版处理 */
export const legacyDnsFor = (ua) => { const v = singboxVersion(ua); return !!v && (v.major < 1 || (v.major === 1 && v.minor < 12)); };

/** DNS 块：新写法（1.12+）或旧写法 */
export function singboxDns(final, legacy) {
  if (legacy) {
    return {
      dns: {
        servers: [
          { tag: 'dns-remote', address: 'https://8.8.8.8/dns-query', detour: final },
          { tag: 'dns-local', address: 'https://223.5.5.5/dns-query', detour: 'direct' },
        ],
        rules: [{ outbound: 'any', server: 'dns-local' }],
        final: 'dns-remote',
        strategy: 'prefer_ipv4',
      },
      route: {},
    };
  }
  return {
    dns: {
      servers: [
        // 远程 DNS 经代理组出去；直连的不写 detour（1.12 起 detour 指向 direct 已弃用）
        { tag: 'dns-remote', type: 'https', server: '8.8.8.8', ...(final && final !== 'direct' ? { detour: final } : {}) },
        { tag: 'dns-local', type: 'https', server: '223.5.5.5' },
      ],
      final: 'dns-remote',
      strategy: 'prefer_ipv4',
    },
    // 代替旧的 DNS 规则 { outbound: 'any', server: 'dns-local' }：解析出站服务器域名用本地 DNS
    route: { default_domain_resolver: { server: 'dns-local' } },
  };
}

export function renderSingbox({ outbounds, groups, rules, intervalOf = (x) => Number(x) || 300, legacyDns = false }) {
  // block 出站在 1.11 起弃用：组成员里的 REJECT 去掉（规则里的 REJECT 由 rulesfeed 转为 action: reject）
  const mapBuiltin = (n) => (n === 'DIRECT' ? 'direct' : n === 'REJECT' || n.startsWith('REJECT-') ? null : n);
  const groupOut = groups.map((g) => {
    let members = g.proxies.map(mapBuiltin).filter(Boolean);
    if (!members.length) members = ['direct'];
    if (g.type === 'select') return { type: 'selector', tag: g.name, outbounds: members };
    // fallback / load-balance 在 sing-box 中没有直接对应，按 urltest 处理
    const sec = intervalOf(g.interval);
    const o = { type: 'urltest', tag: g.name, outbounds: members, url: g.url || 'http://www.gstatic.com/generate_204', interval: `${sec}s`, idle_timeout: `${Math.max(sec * 3, 1800)}s` };
    if (g.tolerance !== undefined) o.tolerance = g.tolerance;
    return o;
  });
  const final = rules?.final && (rules.final === 'direct' || groups.some((g) => g.name === rules.final)) ? rules.final : groups[0]?.name || 'direct';
  const dnsPart = singboxDns(final, legacyDns);
  const config = {
    log: { level: 'info', timestamp: true },
    dns: dnsPart.dns,
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], auto_route: true, strict_route: true, stack: 'mixed' },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds: [...groupOut, ...outbounds, { type: 'direct', tag: 'direct' }],
    route: {
      rules: '__NT_RULES__',
      rule_set: rules?.ruleSets || [],
      final,
      auto_detect_interface: true,
      ...dnsPart.route,
    },
  };
  // 规则块是 Cron 侧预先序列化好的 JSON 片段，直接字符串替换，避免每次请求解析/序列化大对象
  const head = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }, { ip_is_private: true, outbound: 'direct' }];
  const body = JSON.stringify(head).slice(1, -1) + (rules?.rules ? ',' + rules.rules : '');
  return JSON.stringify(config, null, 2).replace('"__NT_RULES__"', () => `[${body}]`); // 用函数：字符串参数会把 $& $$ 当特殊序列
}
