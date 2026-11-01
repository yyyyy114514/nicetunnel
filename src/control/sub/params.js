// 节点参数映射：ResolvedNode + Settings → ProxyDescriptor（所有渲染器共用）。
// 等价上游 _worker.js 404–456 行（订阅链接构造）与 4794–4815 行（获取传输协议配置 / 获取传输路径参数值）。

/** SS 非 TLS 时的端口映射（上游 445–447 行） */
export const TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
export const NOTLS_PORTS = [80, 2052, 2082, 2086, 2095, 8080];

/** 上游 获取本机标识：XHTTP 混淆头名/键由 UUID 派生（数据面据此识别本机请求） */
export function localMark(uuid) {
  const u = String(uuid || '');
  return [u.slice(1, 7), '_' + u.slice(25, 31)];
}

/** XHTTP extra（上游 4797–4803 叉混淆JSON） */
export function xhttpExtra(uuid) {
  const [header, key] = localMark(uuid);
  return { xPaddingObfsMode: true, xPaddingMethod: 'tokenish', xPaddingPlacement: 'queryInHeader', xPaddingHeader: header, xPaddingKey: key };
}

/**
 * 订阅协议：Surge 不支持 VLESS，上游在 Surge 下把非 ss 协议强制改为 trojan（350 行）。
 * @param {object} settings
 * @param {string} [format]
 */
export function effectiveProtocol(settings, format) {
  const p = settings?.node?.protocol || 'vless';
  if (format === 'surge' && p !== 'ss') return 'trojan';
  return p;
}

/**
 * @param {import('../../types.js').ResolvedNode} node
 * @param {import('../../types.js').SubContext & {format?:string, randomPath?:(p:string)=>string, generatorMode?:boolean}} ctx
 * @returns {import('../../types.js').ProxyDescriptor}
 */
export function toProxyDescriptor(node, ctx) {
  const s = ctx.settings;
  const n = s.node;
  const type = /** @type {'vless'|'trojan'|'ss'} */ (effectiveProtocol(s, ctx.format));
  const network = /** @type {'ws'|'grpc'|'xhttp'} */ (type === 'ss' ? 'ws' : n.transport || 'ws');
  let port = Number(node.port) || 443;
  let tls = true;
  if (type === 'ss' && !n.ss?.tls) {
    tls = false;
    const i = TLS_PORTS.indexOf(port);
    if (i > -1) port = NOTLS_PORTS[i];
  }
  // 路径：生成器模式固定 '/'；随机路径在渲染时按上游 随机路径() 生成（每次订阅都不同，与上游一致）
  let path = node.path || '/';
  if (ctx.generatorMode) path = '/';
  else if (n.randomPath && typeof ctx.randomPath === 'function') path = ctx.randomPath(path);
  // 多用户专属订阅：节点路径前面加 /_u<用户ID>（节点据此找出该用户、换成他的 UUID，再去掉前缀）
  if (ctx.muPrefix && !ctx.generatorMode) path = ctx.muPrefix + (path.startsWith('/') ? path : '/' + path);
  if (network === 'grpc') path = path.split('?')[0] || '/';

  const host = node.host || 'example.com';
  const alpn = String(n.alpn || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    name: node.name,
    type,
    server: node.address,
    port,
    uuid: ctx.uuid,
    tls,
    sni: host,
    host,
    network,
    path,
    grpcMode: network === 'grpc' ? n.grpcMode || 'gun' : undefined,
    grpcUserAgent: network === 'grpc' && n.grpcUserAgent ? n.grpcUserAgent : undefined,
    fingerprint: n.fingerprint || 'chrome',
    alpn,
    skipCertVerify: !!n.skipCertVerify,
    ech: n.ech?.enabled && tls ? { dns: n.ech.dns || '', sni: n.ech.sni || '' } : null,
    tlsFragment: n.tlsFragment || null,
    ss: type === 'ss' ? { method: n.ss?.method || 'aes-128-gcm' } : null,
    udp: !!s.sub?.udp,
    xudp: !!s.sub?.xudp,
    xhttpExtra: network === 'xhttp' ? xhttpExtra(ctx.uuid) : null,
  };
}

/** 从路径中拆出 0-RTT 参数（ed=2560）：Clash/sing-box 用独立字段表达 */
export function splitEarlyData(path) {
  const m = String(path).match(/([?&])ed=(\d+)(&?)/);
  if (!m) return { path, ed: 0 };
  let p = path.replace(m[0], m[1] === '?' ? (m[3] ? '?' : '') : (m[3] ? '&' : ''));
  if (p.endsWith('?') || p.endsWith('&')) p = p.slice(0, -1);
  return { path: p || '/', ed: Number(m[2]) };
}

/** 节点名后缀/前缀处理（sub.appendType：subconverter 的 append_type，名字前加 [类型]） */
export function displayName(desc, settings) {
  return settings?.sub?.appendType ? `[${desc.type.toUpperCase()}] ${desc.name}` : desc.name;
}
