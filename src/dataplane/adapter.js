// 数据面适配：把请求分发给上游逐字摘取的协议实现（edt-core.js）。
// 分发顺序与上游 fetch() 一致（_worker.js 20–82 行）：version → WebSocket → POST(gRPC/XHTTP)；其余返回 null 交给控制面/伪装页。
import {
  configure, handleWebSocket, handleGrpc, handleXhttp, parseProxyParams, getLocalMark,
  SIGNATURE, detectIspUpstream, nginxPage, html1101Page, splitList,
} from './edt-core.js';
import { UUID_RE } from '../control/identity.js';
import { resolvePoolRoute, reportChainResult } from './pool-route.js';
import { DATAPLANE_VERSION, CAPS } from './contract.js';
import { buildLabel } from '../build-info.js';
import { reportAuthFail, isBlocked } from './guard.js';
import { bump, recordFail, snapshotStats } from './stats.js';
import { muCheck, muInfo } from './mu-guard.js';

export const UPSTREAM_VERSION_NUMBER = 20261008222327; // 与上游 EDT_版本号 同格式；/version 接口返回

/** 上游的 URL 预处理：去掉 %5C 与反斜杠，修正被编码的 '?'（20–27 行） */
export function normalizeRequestUrl(raw) {
  let text = raw.replace(/%5[Cc]/g, '').replace(/\\/g, '');
  const hashAt = text.indexOf('#');
  const body = hashAt === -1 ? text : text.slice(0, hashAt);
  if (!body.includes('?') && /%3f/i.test(body)) {
    const hash = hashAt === -1 ? '' : text.slice(hashAt);
    text = body.replace(/%3f/i, '?') + hash;
  }
  return new URL(text);
}

export function clientIp(request) {
  const h = request.headers;
  return h.get('CF-Connecting-IP') || h.get('True-Client-IP') || h.get('X-Real-IP') || h.get('X-Forwarded-For') || h.get('Fly-Client-IP') || h.get('X-Appengine-Remote-Addr') || h.get('X-Cluster-Client-IP') || '未知IP';
}

let whitelistCache = null;

// 上游所有出站 TCP 都走 request.fetcher.connect（未写进官方文档的运行时属性）。部分环境（例如一些 Pages 项目、
// 较旧的兼容日期）可能没有它，此时每条代理连接都会失败，而客户端"测速"只测到 CF 入口仍显示正常。
// 这里按需加载官方的 cloudflare:sockets connect() 作为备用；只在第一次需要时 import，Node 测试环境里加载失败即为 null。
let socketsConnect; // undefined=未尝试，null=不可用
export async function loadSocketsConnect(importer = () => import('cloudflare:sockets')) {
  if (socketsConnect !== undefined) return socketsConnect;
  try { const m = await importer(); socketsConnect = typeof m?.connect === 'function' ? m.connect : null; } catch { socketsConnect = null; }
  return socketsConnect;
}
export const resetSocketsConnect = () => { socketsConnect = undefined; };
const hasFetcher = (request) => typeof request?.fetcher?.connect === 'function';
/** SOCKET_API=sockets 时总是用 cloudflare:sockets（排查用）；默认优先 request.fetcher，没有才用备用 */
const preferSockets = (env) => String(env.SOCKET_API || '').toLowerCase() === 'sockets';
/** 本节点出站 TCP 用的是哪条路（检测节点时显示） */
export async function socketInfo(request, env) {
  const fetcher = hasFetcher(request);
  const sockets = !!(fetcher && !preferSockets(env) ? socketsConnect : await loadSocketsConnect());
  return { fetcher, sockets, using: preferSockets(env) && sockets ? 'sockets' : fetcher ? 'fetcher' : sockets ? 'sockets' : 'none' };
}
/** 首包解析错误是否为"凭据不符"（只有扫描/爆破会出现；合法客户端 UUID 与密码一定对） */
export const isCredentialFailure = (message) => /invalid (uuid|password)/i.test(String(message || ''));
const GUARD_OFF = (env) => ['0', 'false', 'off'].includes(String(env.GUARD ?? '').toLowerCase());
const DEFAULT_WHITELIST = ['*tapecontent.net', '*cloudatacdn.com', '*loadshare.org', '*cdn-centaurus.com', 'scholar.google.com'];

/**
 * 滥用防护：这些出站端口默认一律拒绝（PORT_GUARD=0 关闭）。
 * 代理被举报进 T&S 审查的头号来源是第三方拿到订阅链接后借道发垃圾邮件（SMTP）；
 * 挡住这些端口能直接消灭绝大多数「别人拿你的节点干坏事 → 受害方举报 → 账号被审查」的链路。
 */
const BLOCKED_OUTBOUND_PORTS = new Set([25, 465, 587, 2525]);
export const isBlockedOutboundPort = (port) => BLOCKED_OUTBOUND_PORTS.has(Number(port));
/** 出站连接守卫：注入数据面 configure({connectGuardHook})，在每条 TCP 建立前调用；被拦端口抛错即拒绝连接。 */
export const outboundPortGuard = (opt) => {
  const port = Number(opt?.port);
  if (BLOCKED_OUTBOUND_PORTS.has(port)) {
    bump('portBlocked');
    recordFail('[TCP] 出站端口被拒：' + (opt?.hostname || '') + ':' + port);
    throw new Error('outbound port blocked: ' + port);
  }
};
const PORT_GUARD_OFF = (env) => ['0', 'false', 'off'].includes(String(env.PORT_GUARD ?? '').toLowerCase());

/** 按环境变量设置上游模块级开关（39–55 行）。与上游不同：移动用户的单路拨号只作用于本次计算，不会"粘"在 isolate 上。 */
async function applyEnv(request, env) {
  if (whitelistCache === null) {
    whitelistCache = env.GO2SOCKS5 ? [...new Set(DEFAULT_WHITELIST.concat(await splitList(env.GO2SOCKS5)))] : DEFAULT_WHITELIST;
  }
  const tcp = Math.max(1, Number(env.TCP_CONCURRENT_DIAL) || 2);
  configure({
    debug: ['1', 'true'].includes(env.DEBUG),
    preloadRaceDial: ['1', 'true'].includes(env.PRELOAD_RACE_DIAL),
    proxyConcurrentDial: Math.max(1, Number(env.PROXY_CONCURRENT_DIAL) || 1),
    // 全局只放环境变量的值；按运营商调整的值随本次连接的反代上下文传进数据面（见 handleDataPlane），
    // 否则同一实例里并发的连接会读到别人（例如移动用户）设的值
    tcpConcurrentDial: tcp,
    chainResultHook: (ok, hostname, port) => { bump(ok ? 'chainOk' : 'chainFail'); reportChainResult(ok, hostname, port); },
    failLogHook: recordFail,
    chainConnectTimeoutMs: Math.max(1000, Number(env.CHAIN_TIMEOUT) || 5999),
    chainFailover: env.CHAIN_FAILOVER === undefined ? 1 : Math.max(0, Number(env.CHAIN_FAILOVER) || 0),
    chainRace: env.CHAIN_RACE === undefined ? 2 : Math.max(1, Number(env.CHAIN_RACE) || 1),
    // 只把"凭据不对"（UUID / Trojan 密码不符）算作认证失败。正常客户端也会触发其它解析错误——
    // 例如 mihomo/Xray 开 XUDP 时 UDP 走 Mux（命令 3，上游回 Invalid command）、首包被拆短等；
    // 之前这些也计数，普通用户的 UDP 流量几分钟就把自己的 IP 封 30 分钟，表现为节点"连不上、断"
    authFailHook: GUARD_OFF(env) ? null : (req, message) => { if (isCredentialFailure(message)) { bump('authFail'); reportAuthFail(clientIp(req)); } },
    socks5Whitelist: whitelistCache,
    preferSocketConnect: preferSockets(env),
    // 出站端口守卫：两条连接路径（fetcher / 备用）都先过这里再建立 TCP
    connectGuardHook: PORT_GUARD_OFF(env) ? null : outboundPortGuard,
  });
  // 没有 request.fetcher（或要求优先用 sockets）时才去加载 cloudflare:sockets，正常情况零开销
  if (!hasFetcher(request) || preferSockets(env)) {
    const c = await loadSocketsConnect();
    if (c) configure({ socketConnect: c });
    else { bump('noSocket'); recordFail('[TCP] 本节点既没有 request.fetcher 也加载不到 cloudflare:sockets，无法建立出站连接'); }
  }
  // 本次连接的并发拨号数：移动用户（没显式设置时）单路
  return { tcpDial: !env.TCP_CONCURRENT_DIAL && tcp !== 1 && detectIspUpstream(request) === 'cmcc' ? 1 : tcp };
}

/** 默认反代 IP（44–49 行） */
async function defaultProxy(request, env) {
  if (env.PROXYIP) {
    const list = await splitList(env.PROXYIP);
    return { ip: list[Math.floor(Math.random() * list.length)], fallback: false };
  }
  const colo = request.cf?.colo || 'SJC';
  return { ip: `${colo}.${SIGNATURE[0]}.${SIGNATURE[1]}SsSs.nEt`.toLowerCase(), fallback: true };
}

/**
 * /version 接口（56–68 行）：只有携带"近似匹配"的 uuid 才返回版本号，否则落到后续处理（伪装页）。
 */
export function versionResponse(url, uuid, edition = 'full', socket = null, mu = null) {
  const q = (url.searchParams.get('uuid') || '').toLowerCase();
  if (!UUID_RE.test(q)) return null;
  const sum8 = (s) => { let n = 0; for (let i = 0; i < 8; i++) { const c = s.charCodeAt(i); n += c <= 57 ? c - 48 : c - 87; } return n; };
  const target = String(uuid).toLowerCase();
  if (sum8(q) === sum8(target) && q.slice(-12) === target.slice(-12)) {
    // Version 与上游 edgetunnel 同名同格式（兼容旧脚本）；Dataplane / Caps / Edition 是本项目的契约字段（见 contract.js）。
    // 带 CORS：后台页面在浏览器里直接检测各个节点站点（只有携带正确 UUID 才会返回，不泄露其它信息）
    // ?stats=1：附带本 isolate 的运行统计（连接、拦截、链路成败、最近错误），供后台"检测节点"排查断连
    const body = { Version: UPSTREAM_VERSION_NUMBER, Dataplane: DATAPLANE_VERSION, Caps: CAPS, Edition: edition, Build: buildLabel() };
    if (url.searchParams.has('stats')) { body.Stats = snapshotStats(); if (socket) body.Socket = socket; if (mu) body.Mu = mu; }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json;charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  }
  return null;
}

/**
 * 数据面分发。返回 Response 表示已处理；返回 null 表示不是代理请求。
 * @param {Request} request
 * @param {Record<string,any>} env
 * @param {URL} url 已规范化的 URL
 * @param {{uuid:string, adminPassword:string}} identity
 */
export async function handleDataPlane(request, env, url, identity, edition = 'full') {
  const path = url.pathname.slice(1).toLowerCase();
  if (path === 'version') {
    const stats = url.searchParams.has('stats');
    const v = versionResponse(url, identity.uuid, edition, stats ? await socketInfo(request, env) : null, stats ? muInfo(env) : null);
    if (v) return v;
    // UUID 不匹配：逐字节沿用普通伪装页，不附加 CORS / no-store 等 nicetunnel 独有响应特征。
    return camouflage(request, url, env.URL || 'nginx');
  }
  if (!identity.adminPassword) return null;
  const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
  const isWs = upgrade === 'websocket';
  // 隐藏后台入口 LOGIN_PATH 的登录表单也是 POST，不能当成 XHTTP 代理流
  const loginPath = String(env.LOGIN_PATH || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const isPostProxy = !isWs && request.method === 'POST' && !path.startsWith('admin/') && path !== 'login' && !(loginPath && path === loginPath);
  if (!isWs && !isPostProxy) return null;
  // 扫描/爆破防护：近期多次认证失败的 IP 直接拿伪装页（不升级 WS），见 guard.js；GUARD=0 关闭
  if (!GUARD_OFF(env) && isBlocked(clientIp(request))) { bump('guardBlocked'); return camouflage(request, url, env.URL || 'nginx'); }
  bump(isWs ? 'ws' : 'post');

  // 多用户专属链接（路径前缀 /_u<ID>）：校验封禁 / 并行限制，换成该用户的 UUID，去掉前缀再交给上游
  const mu = await muCheck(request, env, url, clientIp(request));
  if (mu) {
    if (!mu.ok) { bump('muDeny'); return camouflage(request, url, env.URL || 'nginx'); }
    bump('muOk');
    identity = { ...identity, uuid: mu.uuid };
    url = mu.url;
  }

  const { tcpDial } = await applyEnv(request, env);
  // 地区路由（/video/<密文> 里是 {type:'pool'}）：连接建立时才决定连哪台链式代理，再改写成上游认识的路径
  let 链路候选 = null;
  if (url.pathname.includes('/video/')) {
    const routed = await resolvePoolRoute(url, identity.uuid, { ip: clientIp(request), fetchFn: globalThis.fetch });
    if (routed.error) {
      bump('regionErr');
      recordFail('[地区路由] ' + routed.error);
      return new Response(routed.error, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    url = routed.url;
    链路候选 = routed.candidates || null;
  }
  const dp = await defaultProxy(request, env);
  const proxyCtx = await parseProxyParams(url, identity.uuid, dp.ip, dp.fallback);
  proxyCtx.TCP并发拨号数 = tcpDial;
  // 故障转移候选随连接一起传进数据面：第一台拨号失败时自动换下一台，而不是直接掐断客户端
  if (链路候选?.length > 1) proxyCtx.代理候选 = 链路候选;
  if (isWs) return handleWebSocket(request, identity.uuid, url, proxyCtx);

  const [markHeader, markKey] = getLocalMark(identity.uuid);
  const isXhttp = !!request.headers.get(markHeader) || !!url.searchParams.get(markKey);
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!isXhttp && contentType.startsWith('application/grpc')) return handleGrpc(request, identity.uuid, proxyCtx);
  return handleXhttp(request, identity.uuid, proxyCtx);
}

/**
 * 伪装页（505–528 行）。node 角色默认只返回静态页面，不做外部 fetch（省子请求与 CPU）；
 * 若设置了 URL=https://… 则与上游一样反代该站点。
 */
export async function camouflage(request, url, setting, fetchFn = fetch) {
  let target = setting || 'nginx';
  if (target !== 'nginx' && target !== '1101') {
    target = String(target).trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    if (target.toLowerCase().startsWith('http://')) target = 'https://' + target.substring(7);
    try { const u = new URL(target); target = u.protocol + '//' + u.host; } catch { target = 'nginx'; }
  }
  const html = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  if (target === '1101') return html(await html1101Page(url.host, clientIp(request)));
  if (target !== 'nginx') {
    try {
      const proxyUrl = new URL(target);
      const headers = new Headers(request.headers);
      headers.set('Host', proxyUrl.host);
      headers.set('Referer', proxyUrl.origin);
      headers.set('Origin', proxyUrl.origin);
      const res = await fetchFn(proxyUrl.origin + url.pathname + url.search, { method: request.method, headers, body: request.body, cf: request.cf });
      const ct = res.headers.get('content-type') || '';
      if (/text|javascript|json|xml/.test(ct)) {
        const text = (await res.text()).replaceAll(proxyUrl.host, url.host);
        return new Response(text, { status: res.status, headers: { ...Object.fromEntries(res.headers), 'Cache-Control': 'no-store' } });
      }
      return res;
    } catch { /* 回退 nginx */ }
  }
  // 真实 nginx 只有 / 是欢迎页，其它路径是 404；原来任意路径都回 200 欢迎页，扫描器一眼能认出
  if (url.pathname !== '/' && url.pathname !== '/index.html') return new Response(NGINX_404, { status: 404, headers: { 'Content-Type': 'text/html' } });
  return html(await nginxPage());
}

const NGINX_404 = '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
