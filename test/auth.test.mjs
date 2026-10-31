import test from 'node:test';
import assert from 'node:assert/strict';
import { md5md5 } from '../src/lib/md5.js';
import {
  handleLogin, handleLogout, requireAuth, checkCsrf, isAuthed, readCookie, verifyAuthCookie,
  createLoginThrottle, isLogoutPath, clientIp, authSetCookie,
} from '../src/control/auth.js';
import { authCookieValue, AUTH_TTL_SEC } from '../src/control/identity.js';

const identity = { uuid: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', secretKey: 'k3y', adminPassword: 'pass\n', host: 'vp.x' };
const UA = 'Mozilla/5.0 Test';
const T0 = 1_800_000_000_000;
const cookieOf = (ua = UA, o = {}) => authCookieValue(ua, identity, { now: T0, ...o });

const ctxOf = (request, extra = {}) => ({ request, url: new URL(request.url), identity, now: T0, ...extra });
const loginReq = (body, headers = {}) => new Request('https://vp.x/login', {
  method: 'POST', body, headers: { 'User-Agent': UA, 'CF-Connecting-IP': '1.2.3.4', ...headers },
});

test('cookie：<过期秒>.<签名>，服务端校验过期；旧版固定值（md5md5(UA+KEY+ADMIN)）不再有效', () => {
  const v = cookieOf('null');
  assert.match(v, /^[0-9]{10}[.][0-9a-f]{32}$/);
  const r = new Request('https://vp.x/admin', { headers: { Cookie: `a=1; auth=${v}; b=2` } });
  assert.ok(isAuthed(ctxOf(r)));
  assert.equal(readCookie(r), v);
  assert.ok(!isAuthed(ctxOf(r, { now: T0 + AUTH_TTL_SEC * 1000 + 1000 })), '过期后失效');
  const old = new Request('https://vp.x/admin', { headers: { Cookie: `auth=${md5md5('null' + 'k3y' + 'pass\n')}` } });
  assert.ok(!isAuthed(ctxOf(old)));
  assert.equal(authSetCookie('v'), 'auth=v; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax');
});

test('cookie 签名密钥：用 KV 里的随机密钥签的 cookie，换了密钥（或拿推导密钥伪造）都无效', () => {
  const v = cookieOf(UA, { secret: 'a'.repeat(64) });
  const r = new Request('https://vp.x/admin', { headers: { 'User-Agent': UA, Cookie: `auth=${v}` } });
  assert.ok(isAuthed(ctxOf(r, { authSecret: 'a'.repeat(64) })));
  assert.ok(!isAuthed(ctxOf(r, { authSecret: 'b'.repeat(64) })));
  assert.ok(!isAuthed(ctxOf(r)), '没有 KV 密钥时用推导密钥，不认 KV 密钥签的');
  assert.ok(!verifyAuthCookie('9999999999.' + 'f'.repeat(32), UA, identity, 'x', T0), '过期时间超出 24 小时的伪造值');
  // 改了密码，旧 cookie 立刻失效
  assert.ok(!isAuthed(ctxOf(new Request('https://vp.x/admin', { headers: { 'User-Agent': UA, Cookie: `auth=${cookieOf()}` } }), { identity: { ...identity, adminPassword: 'new' } })));
});

test('JSON 登录成功：Set-Cookie 带签名 cookie，返回 ok+success；密码比较去掉换行', async () => {
  const res = await handleLogin(ctxOf(loginReq(JSON.stringify({ password: 'pass' }), { 'Content-Type': 'application/json' })), { throttle: createLoginThrottle() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, success: true });
  assert.equal(res.headers.get('Set-Cookie'), `auth=${cookieOf()}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`);
});

test('上游前端 fetch 提交 urlencoded 表单 → JSON；浏览器原生表单 → 302 /admin', async () => {
  const t = createLoginThrottle();
  const r1 = await handleLogin(ctxOf(loginReq('password=pass', { 'Content-Type': 'application/x-www-form-urlencoded' })), { throttle: t });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).success, true);
  const r2 = await handleLogin(ctxOf(loginReq('password=pass', { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html,application/xhtml+xml' })), { throttle: t });
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('Location'), '/admin');
  assert.match(r2.headers.get('Set-Cookie'), /^auth=[0-9]{10}[.][0-9a-f]{32};/);
});

test('登录失败 401；同一 IP 10 分钟内失败 5 次 → 429 throttled（含 retryAfter），窗口过后恢复', async () => {
  const throttle = createLoginThrottle();
  const bad = () => loginReq(JSON.stringify({ password: 'nope' }), { 'Content-Type': 'application/json' });
  for (let i = 0; i < 5; i++) {
    const r = await handleLogin(ctxOf(bad(), { now: T0 + i }), { throttle });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'bad_password');
  }
  const blocked = await handleLogin(ctxOf(loginReq(JSON.stringify({ password: 'pass' }), { 'Content-Type': 'application/json' }), { now: T0 + 10 }), { throttle });
  assert.equal(blocked.status, 429);
  const j = await blocked.json();
  assert.equal(j.code, 'throttled');
  assert.ok(j.retryAfter > 0 && j.retryAfter <= 600);
  assert.equal(blocked.headers.get('Retry-After'), String(j.retryAfter));
  // 其他 IP 不受影响
  const other = await handleLogin(ctxOf(loginReq(JSON.stringify({ password: 'pass' }), { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' })), { throttle });
  assert.equal(other.status, 200);
  // 10 分钟后恢复
  const later = await handleLogin(ctxOf(loginReq(JSON.stringify({ password: 'pass' }), { 'Content-Type': 'application/json' }), { now: T0 + 600_001 }), { throttle });
  assert.equal(later.status, 200);
});

test('已登录 GET /login → 302 /admin；未登录返回登录页（可注入）', async () => {
  const r1 = await handleLogin(ctxOf(new Request('https://vp.x/login', { headers: { 'User-Agent': UA, Cookie: `auth=${cookieOf()}` } })));
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('Location'), '/admin');
  const r2 = await handleLogin(ctxOf(new Request('https://vp.x/login', { headers: { 'User-Agent': UA } })), { loginHtml: () => '<p>LOGIN</p>' });
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), '<p>LOGIN</p>');
});

test('登录成功默认钩子：记 Admin_Login 日志（通过 store.appendLog）', async () => {
  const appended = [];
  const store = { getSettings: async () => ({ log: { enabled: true }, notify: { telegram: { enabled: false } } }), appendLog: (e) => appended.push(e), flushLogs: async () => false };
  const waits = [];
  const res = await handleLogin(ctxOf(loginReq(JSON.stringify({ password: 'pass' }), { 'Content-Type': 'application/json' }), { store, executionCtx: { waitUntil: (p) => waits.push(p) } }), { throttle: createLoginThrottle() });
  assert.equal(res.status, 200);
  await Promise.all(waits);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'Admin_Login');
  assert.equal(appended[0].ip, '1.2.3.4');
});

test('requireAuth：API 未登录 401 JSON；页面 302 /login；已登录放行；未设密码 503', async () => {
  const api = requireAuth(ctxOf(new Request('https://vp.x/admin/api/state')));
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { ok: false, error: '未登录或登录已过期', code: 'unauthorized' });
  const page = requireAuth(ctxOf(new Request('https://vp.x/admin')));
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('Location'), '/login');
  assert.equal(requireAuth(ctxOf(new Request('https://vp.x/admin', { headers: { 'User-Agent': UA, Cookie: `auth=${cookieOf()}` } }))), null);
  // UA 变化 → cookie 失效（与上游一致）
  assert.equal(requireAuth(ctxOf(new Request('https://vp.x/admin', { headers: { 'User-Agent': 'Other', Cookie: `auth=${cookieOf()}` } }))).status, 302);
  const none = requireAuth({ request: new Request('https://vp.x/admin/api/state'), identity: { ...identity, adminPassword: '' } });
  assert.equal(none.status, 503);
  assert.equal((await none.json()).code, 'no_admin');
});

test('CSRF：POST/PUT/DELETE 需 X-Requested-With: nt', async () => {
  assert.equal(checkCsrf(new Request('https://vp.x/a')), null);
  const r = checkCsrf(new Request('https://vp.x/a', { method: 'PUT', body: '{}' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'csrf');
  assert.equal(checkCsrf(new Request('https://vp.x/a', { method: 'POST', headers: { 'X-Requested-With': 'nt' } })), null);
  assert.equal(checkCsrf(new Request('https://vp.x/a', { method: 'DELETE', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status, 403);
});

test('退出：清 cookie（与上游一致）并 302 /login；UUID 路径同样视为退出', () => {
  const r = handleLogout();
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/login');
  assert.equal(r.headers.get('Set-Cookie'), 'auth=; Path=/; Max-Age=0; HttpOnly');
  assert.ok(isLogoutPath('/logout'));
  assert.ok(isLogoutPath('LOGOUT'));
  assert.ok(isLogoutPath('/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'));
  assert.ok(!isLogoutPath('/admin'));
});

test('clientIp 请求头优先级与上游一致', () => {
  assert.equal(clientIp(new Request('https://x/', { headers: { 'X-Real-IP': '2.2.2.2', 'CF-Connecting-IP': '1.1.1.1' } })), '1.1.1.1');
  assert.equal(clientIp(new Request('https://x/', { headers: { 'X-Forwarded-For': '3.3.3.3' } })), '3.3.3.3');
  assert.equal(clientIp(new Request('https://x/')), '未知IP');
});

test('节流器 key 数量有上限', () => {
  const t = createLoginThrottle({ maxKeys: 10 });
  for (let i = 0; i < 50; i++) t.fail('ip' + i, 0);
  assert.ok(t.size() <= 10);
});
