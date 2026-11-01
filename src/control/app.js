// 主站路由（控制面）。数据面请求已在 index.js 先行分发。
// 路由与上游 cmliu/edgetunnel fetch() 82–503 行对应：/<KEY> 快速订阅、/login、/admin*、/logout、/sub、/locations、/robots.txt、伪装页。
import { createStore } from './store.js';
import { normalizeAccounts } from './accounts.js';
import * as accountsMod from './accounts.js';
import * as usageMod from './usage.js';
import * as allocatorMod from './allocator.js';
import * as sourcesMod from './sources.js';
import * as poolMod from './pool.js';
import * as bestMod from './bestfeed.js';
import * as regionsMod from './regions.js';
import { detectIsp } from '../lib/isp.js';
import { UUID_RE } from './identity.js';
import { handleLogin, handleLogout, requireAuth, isAuthed, bearerToken, safeEqual } from './auth.js';
import { trackRequest } from './logs.js';
import { verifySubToken, readyAccountSet } from './users.js';
import { buildSubscription, pollAndPersist } from './pipeline.js';
import { refreshRulesStep, getRulesStatus, fetchAndSaveIni } from './rulesfeed.js';
import { detectFormatInfo } from './sub/index.js';
import { handleAdminRequest } from '../admin/api.js';
import { adminHtml, loginHtml } from '../admin/ui.js';
import { camouflage, clientIp } from '../dataplane/adapter.js';
import { checkProxy } from '../dataplane/check.js';
import { SIGNATURE } from '../dataplane/edt-core.js';

export const VERSION = '__NT_VERSION__';

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const redirect = (loc, status = 302) => new Response('重定向中...', { status, headers: { Location: loc } });

// ---- 订阅限速（isolate 内近似） ----
const rate = new Map();
export function rateLimited(ip, perMinute, now) {
  if (!perMinute) return false;
  const minute = Math.floor(now / 60e3);
  const key = ip + '|' + minute;
  const n = (rate.get(key) || 0) + 1;
  rate.set(key, n);
  if (rate.size > 5000) for (const k of rate.keys()) { if (!k.endsWith('|' + minute)) rate.delete(k); }
  return n > perMinute;
}

/** 上游"优选订阅生成器"模式判定（305 行）：BEST_SUB 开启 + 占位 host/uuid + edgetunnel UA */
function isGeneratorRequest(env, url, ua) {
  return ['1', 'true'].includes(env.BEST_SUB) && url.searchParams.get('host') === 'example.com'
    && url.searchParams.get('uuid') === '00000000-0000-4000-8000-000000000000'
    && ua.toLowerCase().includes('tunnel (https://github.com/' + SIGNATURE[1] + '/edge');
}

/** 管理后台依赖（注入给 admin/api.js；同一对象复用，限频状态在 isolate 内共享） */
let adminDeps = null;
function getAdminDeps() {
  if (adminDeps) return adminDeps;
  adminDeps = {
    accounts: accountsMod, usage: usageMod, allocator: allocatorMod, sources: sourcesMod, pool: poolMod, best: bestMod, regions: regionsMod, detectIsp,
    checkProxy,
    version: VERSION,
    pollUsage: (o) => pollAndPersist(o),
    rules: { refreshRuleset: (o) => refreshRulesStep(o), getStatus: (o) => getRulesStatus(o), fetchIni: (o) => fetchAndSaveIni(o) },
    buildSubscription: (o) => buildSubscription(o),
  };
  return adminDeps;
}

/**
 * @param {{request: Request, env: any, ctx: any, url: URL, identity: object}} p
 */
export async function handleMain({ request, env, ctx, url, identity }) {
  const now = Date.now();
  const path = url.pathname.slice(1);
  let lower = path.toLowerCase();
  const ua = request.headers.get('User-Agent') || 'null';
  const ip = clientIp(request);
  const waitUntil = (p) => { try { ctx?.waitUntil?.(Promise.resolve(p).catch(() => {})); } catch { /* 测试环境 */ } };

  if (url.protocol === 'http:') return redirect(url.href.replace(`http://${url.hostname}`, `https://${url.hostname}`), 301);
  if (!identity.adminPassword) return html(noAdminPage(), 404);
  if (lower === 'robots.txt') return new Response('User-agent: *\nDisallow: /', { headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });

  const store = createStore({ kv: env.KV, normalizeAccounts });
  // 后台只认 ADMIN 一类变量（不回退到 UUID / KEY，它们会随订阅外泄）；没设时后台各入口返回"未设置管理员密码"
  const adminLogin = identity.adminLogin ?? identity.adminPassword;
  const appCtx = {
    request, url, env, executionCtx: ctx, now, identity: { ...identity, adminPassword: adminLogin }, store, ip, ua, loc: request.cf?.country || '',
    fetchFn: globalThis.fetch, adminDeps: getAdminDeps(),
    uuid: identity.uuid, secretKey: identity.secretKey, adminPassword: adminLogin,
  };

  // 隐藏后台入口（可选）：设置环境变量 LOGIN_PATH 后，登录页只在 /<LOGIN_PATH>；未登录访问 /login、/admin、/admin/api/*
  // 一律拿伪装 404（带 Authorization 头的脚本照常走 Bearer 鉴权），扫描器看不到这里有后台
  const hidden = String(env.LOGIN_PATH || '').trim().replace(/^\/+|\/+$/g, '');

  // /<KEY> 快速订阅：直接按 /sub?token=… 处理。上游是 302 跳转到 /sub，客户端每次更新订阅要打两次主站，
  // 这里省掉跳转那一次（主站订阅请求数减半）；客户端看到的内容完全一样。
  // LOGIN_PATH 与 KEY 设成同一个值时：浏览器打开是登录页，代理客户端拿订阅（否则客户端会拿到登录页 HTML，
  // 报 "Unexpected scalar at node end" 之类的 YAML 解析错误）。自检会提示把两者设成不同的值。
  const isKeyPath = path === identity.secretKey && identity.hasCustomKey;
  const browserUa = /mozilla/i.test(ua) && !/clash|mihomo|stash|verge|sing-?box|surge|shadowrocket|quantumult|loon|v2ray|nekobox|hiddify|karing|flclash/i.test(ua);
  const keyToLogin = isKeyPath && hidden && path === hidden && browserUa;
  if (isKeyPath && !keyToLogin) {
    url = new URL(url.href);
    url.searchParams.set('token', identity.subToken);
    lower = 'sub';
  }

  const fixLoc = (r) => {
    const loc = hidden && r.headers.get('Location');
    if (!loc || !loc.startsWith('/login')) return r;
    const h = new Headers(r.headers);
    h.set('Location', '/' + hidden + loc.slice(6));
    return new Response(r.body, { status: r.status, headers: h });
  };
  const notFound = () => camouflage(request, url, env.URL || 'nginx');
  // 订阅以外的路径都可能要校验后台 cookie：先取签名密钥（isolate 内缓存 1 小时）
  if (lower !== 'sub' && adminLogin) {
    appCtx.authSecret = await store.getAuthSecret();
    // 带了 cookie 却校验不过：可能是首次部署时的密钥竞态，重新读一次 KV 再试
    if (/(?:^|;\s*)auth=/.test(request.headers.get('Cookie') || '') && !isAuthed(appCtx)) {
      const fresh = await store.getAuthSecret({ refresh: true });
      if (fresh && fresh !== appCtx.authSecret) appCtx.authSecret = fresh;
    }
  }
  // 隐藏入口下只有带正确 Bearer 令牌的脚本才能绕过伪装（随便带个 Authorization 头不行，否则会暴露后台存在）
  const bearerOk = () => { const t = bearerToken(request); return !!t && !!adminLogin && safeEqual(t, adminLogin); };
  if (hidden && lower !== 'sub') {
    if (path === hidden) lower = 'login';
    else if (lower === 'login') return notFound();
    else if ((lower === 'admin' || lower.startsWith('admin/') || lower === 'locations') && !isAuthed(appCtx) && !bearerOk()) return notFound();
  }

  if (lower === 'login') {
    const settings = await store.getSettings();
    return fixLoc(await handleLogin({ ...appCtx, settings }, { loginHtml: () => loginHtml({ siteName: settings.site.name, action: hidden ? '/' + hidden : '/login' }) }));
  }
  if (lower === 'logout' || UUID_RE.test(lower)) return fixLoc(handleLogout(appCtx));

  if (lower === 'admin' || lower === 'admin/' || lower.startsWith('admin/') || lower === 'locations') {
    const r = await handleAdminRequest(appCtx);
    if (r) return r;
    if (lower === 'admin' || lower === 'admin/') {
      const denied = requireAuth(appCtx, { api: false });
      if (denied) return denied;
      const settings = await store.getSettings();
      waitUntil(trackRequest({ ...appCtx, settings }, { type: 'Admin_Login' }));
      return html(adminHtml({ version: VERSION, siteName: settings.site.name, loginPath: hidden ? '/' + hidden : '/login' }));
    }
    if (lower.startsWith('admin/')) {
      const denied = requireAuth(appCtx, { api: false });
      if (denied) return denied;
      return redirect('/admin');
    }
  }

  if (lower === 'sub') {
    const token = url.searchParams.get('token');
    const generatorMode = isGeneratorRequest(env, url, ua);
    // 多用户专属订阅：/sub?u=<用户ID>.<签名>
    const userTok = generatorMode ? '' : (url.searchParams.get('u') || '');
    if (!userTok && token !== identity.subToken && !generatorMode) return camouflage(request, url, env.URL || 'nginx');
    const stored = await store.getSettings();
    let user = null, muReady = null;
    if (userTok) {
      const v = await verifySubToken({ store, settings: stored, token: userTok });
      if (!v.ok && v.code === 'banned') return new Response('此链接已停用', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (!v.ok) return camouflage(request, url, env.URL || 'nginx');
      user = { id: v.user.id, uuid: v.uuid, token: v.token };
      muReady = await readyAccountSet(store);
    }
    // 反代 IP 为 auto 时，各站点用自己的环境变量 PROXYIP，没设就用公共默认反代（多人共用、常慢或不可用）。
    // 主站设了 PROXYIP 而节点站点没设，就会出现"主站的节点好用、节点账号的节点连不上 / 断"——
    // 套 Cloudflare 的网站只能经反代 IP 访问。这里把主站的 PROXYIP 写进订阅路径，所有节点统一使用。
    const mainProxyIp = String(env.PROXYIP || '').trim();
    // （设置了链式代理账号时 buildNodePath 优先用链式代理，这里写入的 proxyip 不生效，行为不变）
    const settings = mainProxyIp && stored.proxy?.proxyip === 'auto'
      ? { ...stored, proxy: { ...stored.proxy, proxyip: mainProxyIp } }
      : stored;
    if (!generatorMode && rateLimited(ip, settings.sub.rateLimitPerMinute, now)) {
      return new Response('请求过于频繁，请稍后再试', { status: 429, headers: { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    // 生成器模式与上游一致：mixed 且非浏览器 UA → base64（486 行）
    const fi = generatorMode ? { format: 'base64' } : detectFormatInfo(url, ua);
    const format = fi.format;
    try {
      const out = await buildSubscription({
        store, settings, identity, request, url, now, waitUntil, format, ip, ua, generatorMode, unsupportedFormat: fi.unsupported, user, muReady,
        // 生成器模式不需要 token、也不限速：不接受 sub=（否则匿名请求可以让主站去抓任意地址）；用户订阅也不接受
        subParam: generatorMode || user ? '' : (url.searchParams.get('sub') || ''),
      });
      waitUntil(trackRequest({ ...appCtx, settings }, {
        type: generatorMode ? 'Get_Best_SUB' : 'Get_SUB',
        msg: `${format} ${out.nodes.length} 节点${user ? ' · 用户 ' + user.id : ''}`,
        usage: { used: out.summary.used, total: out.summary.budget },
      }));
      return new Response(out.body, { status: 200, headers: out.headers });
    } catch (e) {
      console.error('[sub] 生成失败', e);
      return new Response('订阅生成失败，请稍后再试', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }

  // 已登录时访问根路径直接进后台（方便）；否则伪装
  if (lower === '' && isAuthed(appCtx)) return redirect('/admin');
  const settings = await store.getSettings().catch(() => null);
  return camouflage(request, url, env.URL || settings?.camouflage?.url || 'nginx');
}

function noAdminPage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nicetunnel</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;line-height:1.7">
<h2>尚未设置管理员密码</h2><p>请在 Cloudflare 控制台为此 Worker/Pages 添加环境变量 <code>ADMIN</code>（后台密码），保存后重新部署。</p></body>`;
}
