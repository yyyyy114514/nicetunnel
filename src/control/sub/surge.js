// Surge 配置渲染（原生，无 SUBAPI）。与上游 Surge订阅配置文件热补丁（5318–5335 行）效果对齐：
// trojan + ws=true + ws-path（逗号转 %2C）+ ws-headers=Host；首行 #!MANAGED-CONFIG。
// Surge 不支持 VLESS / gRPC / XHTTP / v2ray-plugin：协议强制 trojan（params.effectiveProtocol），传输统一 WS（数据面同样接受 WS）；
// SS 节点（v2ray-plugin）Surge 无法使用，跳过并计入警告。

/** Surge 代理名不能含 `,` 与 `=` */
export const surgeName = (s) => String(s).replace(/[,=]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {import('../../types.js').ProxyDescriptor} d
 * @returns {string|null}
 */
export function surgeProxyLine(d, name) {
  if (d.type !== 'trojan') return null;
  const parts = [
    `${name} = trojan`, d.server, String(d.port), `password=${d.uuid}`, `sni=${d.sni}`,
    `skip-cert-verify=${d.skipCertVerify}`, 'ws=true', `ws-path=${d.path.replace(/,/g, '%2C')}`, `ws-headers=Host:"${d.host}"`,
  ];
  if (d.udp) parts.push('udp-relay=true');
  if (d.ech) parts.push('ech=true');
  return parts.join(', ');
}

/** 汇聚链接（已解析）→ Surge 行；只支持 trojan(ws/tcp)、vmess(ws/tcp)、ss(无插件)、hysteria2、tuic */
export function surgeLinkLine(l, name) {
  const ws = l.network === 'ws' ? [`ws=true`, `ws-path=${String(l.path || '/').replace(/,/g, '%2C')}`, ...(l.host ? [`ws-headers=Host:"${l.host}"`] : [])] : [];
  if (l.network !== 'ws' && l.network !== 'tcp') return null;
  if (l.type === 'trojan') return [`${name} = trojan`, l.server, l.port, `password=${l.password}`, ...(l.sni ? [`sni=${l.sni}`] : []), `skip-cert-verify=${!!l.skipCertVerify}`, ...ws].join(', ');
  if (l.type === 'vmess') return [`${name} = vmess`, l.server, l.port, `username=${l.uuid}`, `tls=${!!l.tls}`, ...(l.sni ? [`sni=${l.sni}`] : []), 'vmess-aead=true', ...ws].join(', ');
  if (l.type === 'ss' && !l.plugin) return [`${name} = ss`, l.server, l.port, `encrypt-method=${l.cipher}`, `password=${l.password}`, 'udp-relay=true'].join(', ');
  if (l.type === 'hysteria2') return [`${name} = hysteria2`, l.server, l.port, `password=${l.password}`, ...(l.sni ? [`sni=${l.sni}`] : [])].join(', ');
  if (l.type === 'tuic') return [`${name} = tuic`, l.server, l.port, `token=${l.password || l.uuid}`, ...(l.sni ? [`sni=${l.sni}`] : [])].join(', ');
  return null;
}

/**
 * @param {{proxyLines: string[], groups: import('./groups.js').ResolvedGroup[], rules: {rules:string, providers?:any[]}|null,
 *          managedUrl: string, updateHours: number, intervalOf?: (ini:number)=>number}} o
 */
export function renderSurge({ proxyLines, groups, rules, managedUrl, updateHours, intervalOf = (x) => Number(x) || 300 }) {
  const out = [
    `#!MANAGED-CONFIG ${managedUrl} interval=${Math.round((Number(updateHours) || 1) * 3600)} strict=false`,
    '',
    '[General]',
    'loglevel = notify',
    'dns-server = 223.5.5.5, 119.29.29.29, system',
    'skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local',
    'internet-test-url = http://www.gstatic.com/generate_204',
    'proxy-test-url = http://www.gstatic.com/generate_204',
    '',
    '[Proxy]',
    ...proxyLines,
    '',
    '[Proxy Group]',
  ];
  for (const g of groups) {
    const members = g.proxies.map(surgeName).join(', ');
    if (g.type === 'select') out.push(`${surgeName(g.name)} = select, ${members}`);
    else {
      const interval = intervalOf(g.interval);
      const extra = [`url=${g.url || 'http://www.gstatic.com/generate_204'}`, `interval=${interval}`];
      if (g.type === 'url-test' && g.tolerance !== undefined) extra.push(`tolerance=${g.tolerance}`);
      if (g.timeout !== undefined) extra.push(`timeout=${g.timeout}`);
      const type = g.type === 'load-balance' ? 'load-balance' : g.type;
      out.push(`${surgeName(g.name)} = ${type}, ${members}, ${extra.join(', ')}`);
    }
  }
  out.push('', '[Rule]');
  if (rules?.rules) out.push(rules.rules);
  else out.push('FINAL,' + surgeName(groups[0]?.name || 'DIRECT'));
  return out.join('\n') + '\n';
}
