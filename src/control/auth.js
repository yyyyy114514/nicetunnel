// 后台鉴权：登录 / 退出 / cookie 校验 / 登录失败节流 / CSRF 头校验。
// cookie 名称与上游 cmliu/edgetunnel 相同；取值改为 <过期秒>.<签名>（见 identity.js authCookieValue）：服务端校验过期，
// 签名密钥是 KV 里随机生成的 nt.authkey（ctx.authSecret），泄露的 cookie 24 小时后失效，也无法拿来离线破解密码。
// 在上游基础上新增（见 docs/API.md §1）：登录失败节流、变更类请求的 X-Requested-With 头校验、未设密码时拒绝。
import { UUID_RE, AUTH_TTL_SEC, signAuth, authCookieValue, fallbackAuthSecret } from './identity.js';
import { trackRequest } from './logs.js';

export const AUTH_COOKIE = 'auth';
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'nt';
const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** JSON 响应（统一 no-store） */
export function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/** 统一错误格式 {ok:false, error, code, ...extra} */
export function errorResponse(status, code, error, extra = {}, headers = {}) {
  return jsonResponse({ ok: false, error, code, ...extra }, status, headers);
}

const redirect = (location, headers = {}) => new Response('重定向中...', { status: 302, headers: { Location: location, ...headers } });

/** 请求 UA，与上游一致：缺失时为 'null' */
export const requestUa = (request) => request.headers.get('User-Agent') || 'null';

/** 客户端 IP，请求头优先级与上游 访问IP（_worker.js 50 行）一致 */
export function clientIp(request) {
  const h = request.headers;
  return h.get('CF-Connecting-IP') || h.get('True-Client-IP') || h.get('X-Real-IP') || h.get('X-Forwarded-For')
    || h.get('Fly-Client-IP') || h.get('X-Appengine-Remote-Addr') || h.get('X-Cluster-Client-IP') || '未知IP';
}

/** 读取 cookie 值；解析方式与上游相同（split(';') 后找 `name=` 前缀，取第一个 '=' 后到下一个 '=' 前） */
export function readCookie(request, name = AUTH_COOKIE) {
  const cookies = request.headers.get('Cookie') || '';
  return cookies.split(';').find((c) => c.trim().startsWith(name + '='))?.split('=')[1];
}

/**
 * 从 AppContext 取身份（兼容 API.md 的 ctx.identity 与 DESIGN §4.4 的扁平字段）
 * @returns {{uuid:string, secretKey:string, adminPassword:string, subToken?:string, host?:string}}
 */
export function identityOf(ctx) {
  const id = ctx.identity || {};
  return {
    ...id,
    uuid: id.uuid ?? ctx.uuid ?? '',
    secretKey: id.secretKey ?? ctx.secretKey ?? '',
    adminPassword: id.adminPassword ?? ctx.adminPassword ?? '',
  };
}

/** 签名密钥：路由层从 KV 读到的随机值；没有时退回由 KEY+ADMIN 推导 */
const authSecretOf = (ctx, id) => ctx.authSecret || fallbackAuthSecret(id);

/** 校验 cookie：格式、未过期、签名（常量时间比较） */
export function verifyAuthCookie(value, ua, identity, secret, now) {
  const m = /^([0-9]{9,11})[.]([0-9a-f]{32})$/.exec(String(value || ''));
  if (!m) return false;
  const exp = Number(m[1]), t = Math.floor(now / 1000);
  if (exp <= t || exp > t + AUTH_TTL_SEC + 300) return false;
  return safeEqual(m[2], signAuth(ua, identity, secret, exp));
}

/** 构造登录成功的 Set-Cookie（与上游 102 行逐字一致） */
export function authSetCookie(value) {
  return `${AUTH_COOKIE}=${value}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
}
/** 清除 cookie（与上游 302 行逐字一致） */
export const CLEAR_AUTH_COOKIE = `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly`;

/** 是否已登录（cookie 签名有效且未过期） */
export function isAuthed(ctx) {
  const id = identityOf(ctx);
  if (!id.adminPassword) return false;
  const v = readCookie(ctx.request);
  return !!v && verifyAuthCookie(v, requestUa(ctx.request), id, authSecretOf(ctx, id), ctx.now ?? Date.now());
}

/** 上游语义：访问路径为 `logout` 或任意 UUID 时清 cookie 跳 /login（_worker.js 300 行）。path 不含前导 '/' */
export function isLogoutPath(path) {
  const p = String(path || '').replace(/^\/+/, '');
  return p.toLowerCase() === 'logout' || UUID_RE.test(p);
}

// ---------------------------------------------------------------------------
// 登录失败节流（isolate 内近似）
// ---------------------------------------------------------------------------

/**
 * 创建一个节流器：同一 key 在 windowMs 内失败 ≥ max 次即锁定，直到最早一次失败滑出窗口。
 * @param {{max?:number, windowMs?:number, maxKeys?:number}} [o]
 */
export function createLoginThrottle({ max = 5, windowMs = 10 * 60e3, maxKeys = 2000 } = {}) {
  /** @type {Map<string, number[]>} */
  const fails = new Map();
  const live = (key, now) => {
    const arr = (fails.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length) fails.set(key, arr); else fails.delete(key);
    return arr;
  };
  return {
    /** @returns {{blocked:boolean, retryAfter:number}} retryAfter 单位秒 */
    check(key, now) {
      const arr = live(key, now);
      if (arr.length < max) return { blocked: false, retryAfter: 0 };
      return { blocked: true, retryAfter: Math.max(1, Math.ceil((arr[arr.length - max] + windowMs - now) / 1000)) };
    },
    fail(key, now) {
      const arr = live(key, now);
      arr.push(now);
      fails.set(key, arr);
      if (fails.size > maxKeys) fails.delete(fails.keys().next().value); // 防止内存无限增长：淘汰最旧的 key
    },
    reset(key) { fails.delete(key); },
    size: () => fails.size,
  };
}

/** isolate 级默认节流器 */
export const defaultLoginThrottle = createLoginThrottle();

// ---------------------------------------------------------------------------
// 中间件式检查：返回 null 表示通过，否则返回应直接回给客户端的 Response
// ---------------------------------------------------------------------------

/** 未设置管理员密码时的提示 */
export function noAdminResponse(api) {
  const msg = '未设置管理员密码：请在环境变量中设置 ADMIN 后再访问后台';
  if (api) return errorResponse(503, 'no_admin', msg);
  return new Response(msg, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Bearer 鉴权（给脚本用）：Authorization: Bearer <管理员密码>
// ---------------------------------------------------------------------------

/** 从 Authorization 头取 Bearer 令牌；没有返回 '' */
export function bearerToken(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  return m ? m[1].trim() : '';
}

/** 常量时间比较（不因第一个不同字符提前返回，也不因长度不同提前返回） */
export function safeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * 校验 Bearer 令牌。返回 null=没带令牌；{ok:true} / {ok:false, response}。
 * 失败计入节流（同一 IP 10 分钟内 5 次 → 429），防止拿 API 暴力猜密码。成功不受 CSRF 头约束（它不依赖 cookie，天然不受 CSRF 影响）。
 */
export function checkBearer(ctx, throttle = defaultLoginThrottle) {
  const token = bearerToken(ctx.request);
  if (!token) return null;
  const { adminPassword } = identityOf(ctx);
  const key = 'api|' + clientIp(ctx.request);
  const now = ctx.now ?? Date.now();
  const st = throttle.check(key, now);
  if (st.blocked) return { ok: false, response: errorResponse(429, 'throttled', `失败次数过多，请 ${st.retryAfter} 秒后再试`, { retryAfter: st.retryAfter }, { 'Retry-After': String(st.retryAfter) }) };
  if (adminPassword && safeEqual(token, adminPassword)) { throttle.reset(key); return { ok: true }; }
  throttle.fail(key, now);
  return { ok: false, response: errorResponse(401, 'unauthorized', '令牌错误（Authorization: Bearer <管理员密码>）') };
}

/**
 * 鉴权检查。api=true 时未登录返回 401 JSON；否则 302 /login（与上游一致）。
 * @param {object} ctx AppContext
 * @param {{api?:boolean}} [o]
 * @returns {Response|null}
 */
export function requireAuth(ctx, { api } = {}) {
  const isApi = api ?? new URL(ctx.request.url).pathname.startsWith('/admin/api/');
  if (!identityOf(ctx).adminPassword) return noAdminResponse(isApi);
  if (isAuthed(ctx)) return null;
  if (isApi) {
    const b = checkBearer(ctx);
    if (b?.ok) { ctx.viaBearer = true; return null; }
    if (b) return b.response;
    return errorResponse(401, 'unauthorized', '未登录或登录已过期');
  }
  return redirect('/login');
}

/** CSRF：变更类请求必须带 X-Requested-With: nt */
export function checkCsrf(request) {
  if (!MUTATING.has(request.method.toUpperCase())) return null;
  if ((request.headers.get(CSRF_HEADER) || '').toLowerCase() === CSRF_VALUE) return null;
  return errorResponse(403, 'csrf', '缺少安全请求头，已拒绝');
}

// ---------------------------------------------------------------------------
// 登录 / 退出
// ---------------------------------------------------------------------------

/** 判断客户端想要 JSON（fetch/XHR）还是传统表单提交（期望 302） */
function wantsJson(request) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  const accept = (request.headers.get('Accept') || '').toLowerCase();
  if (ct.includes('application/json') || accept.includes('application/json') || request.headers.get(CSRF_HEADER)) return true;
  // 浏览器原生表单提交的 Accept 以 text/html 开头；上游前端用 fetch 提交表单且期望 JSON {success:true}
  return !accept.includes('text/html');
}

/** 从 JSON / urlencoded / multipart 表单中取 password（体积上限 8KB） */
async function readPassword(request) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    try { const fd = await request.formData(); return String(fd.get('password') ?? ''); } catch { return ''; }
  }
  const text = (await request.text()).slice(0, 8192);
  if (ct.includes('application/json') || /^\s*\{/.test(text)) {
    try { const j = JSON.parse(text); return typeof j?.password === 'string' ? j.password : ''; } catch { return ''; }
  }
  return new URLSearchParams(text).get('password') ?? '';
}

const textPage = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

/**
 * GET/POST /login
 * @param {object} ctx AppContext
 * @param {{loginHtml?: () => string, throttle?: ReturnType<typeof createLoginThrottle>, onLogin?: (ctx:object)=>Promise<any>|void}} [opts]
 *   loginHtml: 登录页渲染函数（来自 admin/ui.js，由路由层注入）；onLogin: 登录成功后的异步钩子，默认记日志+TG(adminLogin)
 */
export async function handleLogin(ctx, opts = {}) {
  const { request } = ctx;
  const id = identityOf(ctx);
  const { adminPassword } = id;
  if (!adminPassword) return noAdminResponse(request.method === 'POST' && wantsJson(request));
  const ua = requestUa(request);
  // 已登录访问 /login → 302 /admin（上游 94 行）
  if (request.method !== 'POST') {
    if (isAuthed(ctx)) return redirect('/admin');
    return textPage(opts.loginHtml ? opts.loginHtml() : '<!doctype html><meta charset="utf-8"><title>登录</title><form method="post"><input type="password" name="password" autofocus><button>登录</button></form>');
  }

  const json = wantsJson(request);
  const now = ctx.now ?? Date.now();
  const ip = ctx.ip || clientIp(request);
  const throttle = opts.throttle || defaultLoginThrottle;
  const st = throttle.check(ip, now);
  if (st.blocked) {
    const msg = `登录失败次数过多，请 ${Math.ceil(st.retryAfter / 60)} 分钟后再试`;
    return errorResponse(429, 'throttled', msg, { success: false, retryAfter: st.retryAfter }, { 'Retry-After': String(st.retryAfter) });
  }

  const input = await readPassword(request);
  // 上游比较时去掉密码里的换行（99 行），cookie 计算仍用原值
  if (input && safeEqual(input, String(adminPassword).replace(/[\r\n]/g, ''))) {
    throttle.reset(ip);
    const setCookie = authSetCookie(authCookieValue(ua, id, { secret: authSecretOf(ctx, id), now }));
    const hook = opts.onLogin ? opts.onLogin(ctx) : defaultOnLogin(ctx);
    if (hook && typeof hook.then === 'function') {
      if (ctx.executionCtx?.waitUntil) ctx.executionCtx.waitUntil(hook.catch(() => {}));
      else hook.catch(() => {});
    }
    if (json) return jsonResponse({ ok: true, success: true }, 200, { 'Set-Cookie': setCookie });
    return redirect('/admin', { 'Set-Cookie': setCookie });
  }

  throttle.fail(ip, now);
  if (json) return errorResponse(401, 'bad_password', '密码错误', { success: false });
  return redirect('/login?error=1');
}

/** 默认登录钩子：记录 Admin_Login 日志并按设置发 TG（失败吞掉） */
async function defaultOnLogin(ctx) {
  if (!ctx.store) return;
  try {
    const settings = ctx.settings || (await ctx.store.getSettings());
    await trackRequest({ ...ctx, settings }, { type: 'Admin_Login', msg: '后台登录' });
  } catch { /* 忽略 */ }
}

/** GET /logout（及上游的 /<UUID>）：清 cookie，302 /login */
export function handleLogout() {
  return redirect('/login', { 'Set-Cookie': CLEAR_AUTH_COOKIE });
}
