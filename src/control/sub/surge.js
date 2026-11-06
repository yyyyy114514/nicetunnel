// Surge 配置渲染（原生，无 SUBAPI）。与上游 Surge订阅配置文件热补丁（5318–5335 行）效果对齐：
// trojan + ws=true + ws-path（逗号转 %2C）+ ws-headers=Host；首行 #!MANAGED-CONFIG。
// Surge 不支持 VLESS / gRPC / XHTTP / v2ray-plugin：协议强制 trojan（params.effectiveProtocol），传输统一 WS（数据面同样接受 WS）；
// SS 节点（v2ray-plugin）Surge 无法使用，跳过并计入警告。

// Surge 配置是逐行、逗号分隔的纯文本：第三方订阅里的字段一旦带换行，就能另起一段（例如 [Script] 下发远程脚本）；
// 带逗号或引号则能多塞参数。所以链接字段先校验：有控制字符直接丢弃整条；主机名/端口必须合法；密码有逗号时加引号。
const HAS_CTRL = /[\x00-\x1f\x7f]/;
const HOST_RE = /^[A-Za-z0-9._:\[\]-]{1,253}$/;
/** 任一字段带控制字符（换行等）→ true */
export const hasCtrl = (...vals) => vals.some((v) => v !== undefined && v !== null && HAS_CTRL.test(String(v)));
const okHost = (v) => HOST_RE.test(String(v || ''));
const okPort = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535; };
/** 参数值：含逗号用双引号包起来；含双引号无法安全表示 → null */
const sval = (v) => { const t = String(v ?? ''); if (t.includes('"')) return null; return t.includes(',') ? `"${t}"` : t; };
const spath = (v) => { const t = String(v || '/'); return t.includes('"') ? null : t.replace(/,/g, '%2C'); };
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';

/** Surge 代理名不能含 `,` 与 `=` */
export const surgeName = (s) => String(s).replace(/[,=]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {import('../../types.js').ProxyDescriptor} d
 * @returns {string|null}
 */
export function surgeProxyLine(d, name) {
  if (d.type !== 'trojan') return null;
  if (hasCtrl(d.server, d.port, d.uuid, d.sni, d.host, d.path) || [d.uuid, d.sni, d.host, d.path].some((v) => String(v ?? '').includes('"')) || !okPort(d.port)) return null;
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
  if (l.network !== 'ws' && l.network !== 'tcp') return null;
  if (hasCtrl(l.server, l.port, l.password, l.uuid, l.sni, l.host, l.path, l.cipher)) return null;
  if (!okHost(l.server) || !okPort(l.port) || (l.sni && !okHost(l.sni)) || (l.host && !okHost(l.host))) return null;
  if (l.cipher && !/^[A-Za-z0-9._-]{1,40}$/.test(l.cipher)) return null;
  const path = spath(l.path);
  const pw = sval(l.password), id = sval(l.uuid), token = sval(l.password || l.uuid);
  if (path === null || pw === null || id === null || token === null) return null;
  const ws = l.network === 'ws' ? [`ws=true`, `ws-path=${path}`, ...(l.host ? [`ws-headers=Host:"${l.host}"`] : [])] : [];
  if (l.type === 'trojan') return [`${name} = trojan`, l.server, l.port, `password=${pw}`, ...(l.sni ? [`sni=${l.sni}`] : []), `skip-cert-verify=${!!l.skipCertVerify}`, ...ws].join(', ');
  if (l.type === 'vmess') return [`${name} = vmess`, l.server, l.port, `username=${id}`, `tls=${!!l.tls}`, ...(l.sni ? [`sni=${l.sni}`] : []), 'vmess-aead=true', ...ws].join(', ');
  if (l.type === 'ss' && !l.plugin) return [`${name} = ss`, l.server, l.port, `encrypt-method=${l.cipher}`, `password=${pw}`, 'udp-relay=true'].join(', ');
  if (l.type === 'hysteria2') return [`${name} = hysteria2`, l.server, l.port, `password=${pw}`, ...(l.sni ? [`sni=${l.sni}`] : [])].join(', ');
  if (l.type === 'tuic') return [`${name} = tuic`, l.server, l.port, `token=${token}`, ...(l.sni ? [`sni=${l.sni}`] : [])].join(', ');
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
      const extra = [`url=${!g.url || hasCtrl(g.url) || /[,\s]/.test(g.url) ? DEFAULT_TEST_URL : g.url}`, `interval=${interval}`];
      if (g.type === 'url-test' && g.tolerance !== undefined) extra.push(`tolerance=${g.tolerance}`);
      if (g.timeout !== undefined) extra.push(`timeout=${g.timeout}`);
      const type = g.type === 'load-balance' ? 'load-balance' : g.type;
      out.push(`${surgeName(g.name)} = ${type}, ${members}, ${extra.join(', ')}`);
    }
  }
  out.push('', '[Rule]');
  if (rules?.rules) out.push(String(rules.rules).split(/\r?\n/).filter((x) => !/^\s*\[/.test(x)).join('\n'));
  else out.push('FINAL,' + surgeName(groups.find((g) => !g.notice)?.name || 'DIRECT'));
  return out.join('\n') + '\n';
}
