// 安全审计修复：后台密码只认 ADMIN、KV 读失败不覆盖设置、生成器模式不接受 sub=、来源缓存上限、
// 旧版 GET 接口拒绝跨站、隐藏入口不因任意 Authorization 头暴露、地区路由参数限制
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState, createStore } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { SOURCE_CACHE_MAX } from '../src/control/sources.js';
import { unsafeRegex } from '../src/dataplane/pool-route.js';
import { DEFAULT_REGION_RE } from '../src/lib/pool-parse.js';
import { memKV, fakeFetch, settingsWith, TEST_AUTH_KEY, UUID } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); });
afterEach(() => { globalThis.fetch = realFetch; });
const call = (env, path, headers = {}) => worker.fetch(new Request('https://vp.example.com' + path, { headers }), env, { waitUntil() {} });

test('H1：只配了 UUID（没配 ADMIN）时，Bearer UUID / KEY 不能调用后台接口，订阅照常', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({}), 'nt.accounts': [{ id: 'n1', hosts: ['n1.com'], role: 'node', enabled: true, auth: { apiToken: 'SECRET_TOKEN_' + 'x'.repeat(30) } }] });
  const env = { KV: kv, UUID, KEY: 'quick' };
  for (const pw of [UUID, 'quick']) {
    const r = await call(env, '/admin/api/export', { Authorization: 'Bearer ' + pw });
    assert.notEqual(r.status, 200, pw);
    assert.ok(!(await r.text()).includes('SECRET_TOKEN_'));
  }
  const login = await call(env, '/login');
  assert.ok(!(await login.text()).includes('type="password"'), '没设 ADMIN 不给登录页');
  globalThis.fetch = fakeFetch({});
  const id = deriveIdentity(env, 'vp.example.com');
  assert.equal((await call(env, '/sub?token=' + id.subToken, { 'User-Agent': 'clash' })).status, 200, '订阅不受影响');
  // 配了 ADMIN：Bearer ADMIN 可以，Bearer UUID 不行
  const env2 = { ...env, ADMIN: 'admin-pw' };
  assert.equal((await call(env2, '/admin/api/export', { Authorization: 'Bearer admin-pw' })).status, 200);
  assert.equal((await call(env2, '/admin/api/export', { Authorization: 'Bearer ' + UUID })).status, 401);
});

test('H2：KV 读取出错时不把默认设置写回 KV；JSON 损坏也不写', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({ site: { name: 'MY-SITE' } }) });
  const get = kv.get;
  let fail = true;
  kv.get = async (k, o) => { if (fail && k === 'nt.settings') throw new Error('KV GET failed: 503'); return get(k, o); };
  const store = createStore({ kv });
  await assert.rejects(store.getSettings(), /503/);
  assert.equal(JSON.parse(kv.m.get('nt.settings')).site.name, 'MY-SITE', '原设置还在');
  fail = false;
  assert.equal((await store.getSettings()).site.name, 'MY-SITE');
  // 已缓存后再抖动：继续用旧缓存
  resetStoreState();
  const s2 = createStore({ kv, now: () => 0 });
  await s2.getSettings();
  fail = true;
  const s3 = createStore({ kv, now: () => 60e3 });
  assert.equal((await s3.getSettings()).site.name, 'MY-SITE');
  // 损坏的 JSON：本次用默认值，但不覆盖
  resetStoreState();
  fail = false;
  kv.m.set('nt.settings', '{broken');
  const writes = kv.writes;
  await createStore({ kv }).getSettings();
  assert.equal(kv.m.get('nt.settings'), '{broken');
  assert.equal(kv.writes, writes);
});

test('M1：来源缓存有上限', () => {
  assert.ok(SOURCE_CACHE_MAX > 0 && SOURCE_CACHE_MAX <= 256);
});

test('M1：生成器模式（BEST_SUB）忽略 sub= 参数，不去外拉', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({}), 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw', BEST_SUB: 'true' };
  const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); return new Response('', { status: 404 }); };
  const r = await call(env, '/sub?host=example.com&uuid=00000000-0000-4000-8000-000000000000&sub=https://evil.example/x', { 'User-Agent': 'edgetunnel (https://github.com/cmliu/edgetunnel)' });
  assert.ok(r.status < 500);
  assert.ok(!hits.some((u) => u.includes('evil.example')), JSON.stringify(hits));
});

test('L1：旧版 GET /admin/check 拒绝跨站请求（同源照常）', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({}), 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw' };
  const id = deriveIdentity(env, 'vp.example.com');
  const h = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0' };
  const r = await call(env, '/admin/check?socks5=1.2.3.4:1080', { ...h, 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  globalThis.fetch = fakeFetch({});
  const ok = await call(env, '/admin/check?socks5=1.2.3.4:1080', { ...h, 'Sec-Fetch-Site': 'same-origin' });
  assert.notEqual(ok.status, 403);
});

test('L2：设了 LOGIN_PATH 后，带任意 Authorization 头访问 /admin/api 仍是伪装页；正确的 Bearer 照常', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({}), 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw', LOGIN_PATH: 'hide' };
  globalThis.fetch = fakeFetch({});
  const r = await call(env, '/admin/api/state', { Authorization: 'Bearer nope' });
  assert.ok(!(r.headers.get('Content-Type') || '').includes('json'), '不是 JSON 401');
  assert.equal((await call(env, '/admin/api/state', { Authorization: 'Bearer pw' })).status, 200);
});

test('L5：地区路由的过滤正则：过长或嵌套量词拒绝，默认正则可用', () => {
  assert.ok(!unsafeRegex(DEFAULT_REGION_RE));
  assert.ok(unsafeRegex('(a+)+$'));
  assert.ok(unsafeRegex('(\\d*)*x'));
  assert.ok(unsafeRegex('a'.repeat(201)));
});
