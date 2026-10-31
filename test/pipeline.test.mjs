// 端到端：通过 Worker 入口 fetch() 走完整订阅流程（mock KV + 假 fetch），以及 Cron 与后台页面。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { resetRulesState } from '../src/control/rulesfeed.js';
import { runScheduled, maintenanceTask } from '../src/control/cron.js';
import { createStore } from '../src/control/store.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { adminHtml, loginHtml } from '../src/admin/ui.js';
import { memKV, fakeFetch } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetRulesState(); });
afterEach(() => { globalThis.fetch = realFetch; });

const UA_CLASH = 'clash-verge/v2.0';
function setup(extraSettings = {}) {
  const settings = {
    schema: 2,
    preferred: { custom: { enabled: true, text: '1.2.3.4:443#日本-住宅-01\n5.6.7.8#美国-住宅-01' }, random: { enabled: true, count: 4 } },
    hosts: { unmanaged: ['vp2.example.com', 'vp3.example.com'] },
    rules: { configText: '' , configUrl: '' },
    ...extraSettings,
  };
  const kv = memKV({ 'nt.settings': settings, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pass123', KEY: 'mykey' };
  const id = deriveIdentity(env, 'vp.example.com');
  const tasks = [];
  const ctx = { waitUntil: (p) => tasks.push(p) };
  return { kv, env, id, ctx, tasks };
}
const req = (path, ua = 'v2rayN/6', init = {}) => {
  const r = new Request('https://vp.example.com' + path, { headers: { 'User-Agent': ua, 'CF-Connecting-IP': '1.2.3.4', ...(init.headers || {}) }, method: init.method || 'GET', body: init.body });
  return r;
};

test('订阅：token 正确 → base64 订阅、头部齐全、热路径零 KV 写', async () => {
  const { kv, env, id, ctx, tasks } = setup();
  globalThis.fetch = fakeFetch({});
  const res = await worker.fetch(req('/sub?token=' + id.subToken), env, ctx);
  assert.equal(res.status, 200);
  const text = new TextDecoder().decode(Uint8Array.from(atob(await res.text()), (c) => c.charCodeAt(0)));
  const lines = text.split('\n');
  assert.equal(lines.length, 6, text); // 2 优质 + 4 兜底
  assert.ok(lines[0].startsWith(`vless://${id.uuid}@1.2.3.4:443?`));
  assert.ok(lines.every((l) => /host=vp[23]\.example\.com/.test(l)), '承载域名来自号池');
  assert.equal(res.headers.get('Profile-Update-Interval'), '1');
  assert.match(res.headers.get('Content-Disposition'), /attachment/);
  assert.equal(kv.writes, 0);
  await Promise.allSettled(tasks);
});

test('订阅：错误 token → 伪装页；/<KEY> 直接返回订阅（不跳转，省一次主站请求），与 /sub?token= 内容一致', async () => {
  const { env, id, ctx } = setup();
  globalThis.fetch = fakeFetch({});
  const bad = await worker.fetch(req('/sub?token=bad'), env, ctx);
  assert.ok(!(await bad.text()).includes('vless://'));
  const q = await worker.fetch(req('/mykey?clash'), env, ctx);
  assert.equal(q.status, 200);
  assert.match(q.headers.get('Content-Type'), /yaml/);
  const viaSub = await worker.fetch(req('/sub?clash&token=' + id.subToken), env, ctx);
  assert.equal(viaSub.headers.get('X-NT-Opts'), q.headers.get('X-NT-Opts'));
  // 不是自定义 KEY 的路径不受影响
  assert.ok(!(await (await worker.fetch(req('/otherkey?clash'), env, ctx)).text()).includes('proxies:'));
});

test('订阅：Clash UA → YAML（内置规则回退 provider）', async () => {
  const { env, id, ctx, tasks } = setup();
  globalThis.fetch = fakeFetch({});
  const res = await worker.fetch(req('/sub?token=' + id.subToken, UA_CLASH), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /yaml/);
  const body = await res.text();
  assert.ok(body.includes('proxy-groups:') && body.includes('"lazy":true'));
  assert.ok(body.includes('"name":"日本-住宅-01"'));
  assert.ok(body.includes('MATCH,'));
  await Promise.allSettled(tasks);
});

test('订阅：同 IP 超过每分钟限额 → 429', async () => {
  const { env, id, ctx } = setup({ sub: { rateLimitPerMinute: 2 } });
  globalThis.fetch = fakeFetch({});
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await worker.fetch(req('/sub?token=' + id.subToken, 'x', { headers: { 'CF-Connecting-IP': '9.9.9.9' } }), env, ctx)).status);
  assert.deepEqual(codes, [200, 200, 429]);
});

test('后台：未登录跳登录页；登录后 state 与 preview 可用', async () => {
  const { env, id, ctx } = setup();
  globalThis.fetch = fakeFetch({});
  const r1 = await worker.fetch(req('/admin', 'Mozilla/5.0'), env, ctx);
  assert.equal(r1.status, 302);
  const lg = await worker.fetch(req('/login', 'Mozilla/5.0'), env, ctx);
  assert.match(await lg.text(), /name="password"/);
  const cookie = 'auth=' + authCookieValue('Mozilla/5.0', id);
  const h = { Cookie: cookie, 'X-Requested-With': 'nt', 'Content-Type': 'application/json' };
  const page = await worker.fetch(req('/admin', 'Mozilla/5.0', { headers: h }), env, ctx);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<nav>/);
  const st = await (await worker.fetch(req('/admin/api/state', 'Mozilla/5.0', { headers: h }), env, ctx)).json();
  assert.equal(st.ok, true);
  assert.equal(st.pool.hosts.length, 2);
  const pv = await (await worker.fetch(req('/admin/api/preview', 'Mozilla/5.0', { headers: h, method: 'POST', body: JSON.stringify({ format: 'clash' }) }), env, ctx)).json();
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(pv.nodes.length, 6);
  assert.ok(pv.body.includes('proxies:'));
});

test('Cron：维护任务轮转；runScheduled 刷新规则与 CIDR', async () => {
  assert.equal(maintenanceTask(0).kind, 'rules');
  assert.equal(maintenanceTask(2 * 5 * 60e3).kind, 'cidr');
  const kinds = new Set(Array.from({ length: 16 }, (_, i) => maintenanceTask((i * 4 + 2) * 5 * 60e3).isp));
  assert.deepEqual([...kinds].sort(), ['cf', 'cmcc', 'ct', 'cu']);
  const kv = memKV({ 'nt.settings': { schema: 2, rules: { configUrl: 'https://r.test/ini' } }, 'nt.accounts': [] });
  const store = createStore({ kv });
  const f = fakeFetch({ 'https://r.test/ini': 'custom_proxy_group=A`select`.*\nruleset=A,[]FINAL' });
  const rep = await runScheduled({ env: { KV: kv }, now: 0, fetchFn: f, store });
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.maintenance.built, true);
  assert.ok([...kv.m.keys()].some((k) => k.startsWith('nt.rules.clash.')));
});

test('UI：自包含、无外部资源、转义站点名', () => {
  const a = adminHtml({ version: '1.0.0', siteName: '<x>' });
  const l = loginHtml({ siteName: 'nt', error: '密码<错>' });
  for (const html of [a, l]) {
    assert.ok(!/<(script|link)[^>]+(src|href)=["']?https?:/i.test(html), '无外部脚本/样式');
    assert.ok(!/@import|url\(http/i.test(html));
    assert.ok(html.includes('prefers-color-scheme:dark'));
  }
  assert.ok(a.includes('&lt;x&gt;') && !a.includes('<x>'));
  assert.ok(l.includes('密码&lt;错&gt;'));
  // 内联脚本语法正确
  const js = a.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
});

test('KV 里保存的站点名是 edgetunnel：订阅文件名与后台页面都显示 nicetunnel', async () => {
  const { kv, env, id, ctx } = setup({ site: { name: 'edgetunnel' } });
  globalThis.fetch = fakeFetch({});
  const sub = await worker.fetch(req('/sub?token=' + id.subToken), env, ctx);
  assert.match(sub.headers.get('Content-Disposition'), /filename\*=utf-8''nicetunnel$/);
  const h = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id) };
  const page = await (await worker.fetch(req('/admin', 'Mozilla/5.0', { headers: h }), env, ctx)).text();
  assert.match(page, /<title>nicetunnel · 后台<\/title>/);
  assert.ok(!/edgetunnel/i.test(page.replace(/<script>[\s\S]*<\/script>/, '')), '页面可见部分不含 edgetunnel');
});

test('隐藏后台入口 LOGIN_PATH：/login、/admin、/admin/api 对未登录者是 nginx 404；秘密路径能登录；Bearer 脚本照常可用', async () => {
  const { env: base, ctx } = setup();
  const env = { ...base, LOGIN_PATH: '/s3cret-door/' };
  globalThis.fetch = fakeFetch({});
  for (const p of ['/login', '/admin', '/admin/', '/admin/api/state']) {
    const r = await worker.fetch(req(p), env, ctx);
    assert.equal(r.status, 404, p);
    assert.match(await r.text(), /<center>nginx<\/center>/, p);
  }
  const page = await worker.fetch(req('/s3cret-door'), env, ctx);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /action="\/s3cret-door"/);
  // 密码错误：跳回秘密路径而不是 /login
  const bad = await worker.fetch(req('/s3cret-door', 'v2rayN/6', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'password=wrong' }), env, ctx);
  assert.equal(bad.status, 302);
  assert.equal(bad.headers.get('Location'), '/s3cret-door?error=1');
  const ok = await worker.fetch(req('/s3cret-door', 'v2rayN/6', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'password=' + encodeURIComponent(env.ADMIN) }), env, ctx);
  assert.equal(ok.status, 302);
  const cookie = ok.headers.get('Set-Cookie').split(';')[0];
  const admin = await worker.fetch(req('/admin', 'v2rayN/6', { headers: { Cookie: cookie } }), env, ctx);
  assert.equal(admin.status, 200, '登录后 /admin 正常');
  const api = await worker.fetch(req('/admin/api/state', 'curl/8', { headers: { Authorization: 'Bearer ' + env.ADMIN } }), env, ctx);
  assert.equal(api.status, 200, 'Bearer 脚本不受影响');
  // 不设 LOGIN_PATH 时行为不变
  assert.equal((await worker.fetch(req('/login'), base, ctx)).status, 200);
});

test('LOGIN_PATH 与 KEY 相同：代理客户端拿订阅（不再拿到登录页 HTML 报 YAML 错误），浏览器拿登录页，自检提示', async () => {
  const { env: base, ctx } = setup();
  const env = { ...base, LOGIN_PATH: base.KEY };
  globalThis.fetch = fakeFetch({});
  for (const ua of ['clash-verge/v2.0.3', 'mihomo/1.18', 'FlClash/0.8 Mozilla/5.0', 'sing-box 1.9']) {
    const r = await worker.fetch(req('/' + base.KEY, ua), env, ctx);
    const text = await r.text();
    assert.ok(!text.includes(':root{color-scheme'), ua + ' 不应拿到后台页面');
    assert.ok(!text.includes('<html'), ua + ' 拿到的是订阅');
  }
  const page = await worker.fetch(req('/' + base.KEY, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130'), env, ctx);
  assert.match(await page.text(), /action="\/[^"]+"[\s\S]*管理员密码/);
  const api = await worker.fetch(req('/admin/api/state', 'curl/8', { headers: { Authorization: 'Bearer ' + env.ADMIN } }), env, ctx);
  const st = await api.json();
  assert.ok(st.checks.some((c) => c.id === 'login-path-key'));
});

test('后台页面带登录地址：设置 LOGIN_PATH 时登录失效跳到隐藏入口；API 回伪装页也视为未登录', async () => {
  const { adminHtml } = await import('../src/admin/ui.js');
  assert.match(adminHtml({ loginPath: '/s3cret-door' }), /<body data-login="\/s3cret-door">/);
  const js = adminHtml({}).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.ok(js.includes("location.href = document.body.dataset.login || '/login'"));
});
