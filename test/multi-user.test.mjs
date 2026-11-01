// 多用户专属链接：签名凭据、专属订阅、节点校验（封禁 / 并行限制 / 上报）、在线汇总与下发、后台接口
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState, createStore } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { deriveIdentity, authCookieValue, UUID_RE } from '../src/control/identity.js';
import { userUuid, userSubToken, parseSubToken, ipKey, ipTag, MU_STATE_KEY, newUserId, nodeKeyOf } from '../src/lib/mu.js';
import { muCheck, resetMuGuard } from '../src/dataplane/mu-guard.js';
import { computeOver, mergeOnline, buildState, syncUsers, MU_KEYS, findPagesProject, setupAccount } from '../src/control/users.js';
import { runScheduled, MU_CRON } from '../src/control/cron.js';
import { memKV, fakeFetch, settingsWith, TEST_AUTH_KEY } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetMuGuard(); });
afterEach(() => { globalThis.fetch = realFetch; });
const SECRET = 'c'.repeat(64);
const HEX = (i) => i.toString(16).padStart(32, '0');

test('签名凭据：UUID 是合法 v4、同一用户稳定；订阅令牌格式；IPv6 按 /64 归一', async () => {
  const id = newUserId();
  assert.match(id, /^[a-z0-9]{8}$/);
  const u = await userUuid(SECRET, id);
  assert.ok(UUID_RE.test(u), u);
  assert.equal(u, await userUuid(SECRET, id));
  assert.notEqual(u, await userUuid(SECRET, 'zzzzzzzz'));
  assert.notEqual(u, await userUuid('d'.repeat(64), id), '换密钥就变');
  const t = await userSubToken(SECRET, id);
  assert.deepEqual(parseSubToken(t)?.id, id);
  assert.equal(parseSubToken('abc.def'), null);
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(await ipTag(SECRET, '2001:db8:1:2::9'), await ipTag(SECRET, '2001:db8:1:2:ffff::1'));
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
});

function nodeEnv(state, ae) {
  const kv = memKV({ [MU_STATE_KEY]: state });
  return { NT_MU: kv, ...(ae ? { NT_AE: ae } : {}) };
}
const req = (path, ip = '1.1.1.1') => new Request('https://n1.example.com' + path, { headers: { 'CF-Connecting-IP': ip } });

test('节点：可用用户放行并换成他的 UUID、去掉前缀；删除 / 封禁 / 关闭 / 没有状态都拒绝；普通路径不管', async () => {
  const points = [];
  const ae = { writeDataPoint: (p) => points.push(p) };
  const env = nodeEnv({ v: 2, on: true, key: SECRET, ids: ['aaaa1111'], over: {} }, ae);
  const url = new URL('https://n1.example.com/_uaaaa1111/proxyip=1.2.3.4?ed=2560');
  const r = await muCheck(req(url.pathname), env, url, '1.1.1.1', 1000);
  assert.equal(r.ok, true);
  assert.equal(r.uuid, await userUuid(SECRET, 'aaaa1111'));
  assert.equal(r.url.pathname + r.url.search, '/proxyip=1.2.3.4?ed=2560');
  assert.equal(points.length, 1);
  assert.deepEqual(points[0].blobs.slice(0, 2), ['aaaa1111', await ipTag(SECRET, '1.1.1.1')]);
  // 2 分钟内同一 IP 不再写；超过 2 分钟写一条，带累计连接数
  await muCheck(req('/_uaaaa1111/'), env, new URL('https://n1.example.com/_uaaaa1111/'), '1.1.1.1', 2000);
  assert.equal(points.length, 1);
  await muCheck(req('/_uaaaa1111/'), env, new URL('https://n1.example.com/_uaaaa1111/'), '1.1.1.1', 1000 + 121e3);
  assert.equal(points.length, 2);
  assert.equal(points[1].doubles[0], 2);
  // 不在名单里（删除或封禁）
  assert.deepEqual(await muCheck(req('/_ubbbb2222/'), env, new URL('https://n1.example.com/_ubbbb2222/'), '1.1.1.1', 3000), { ok: false, reason: 'banned' });
  // 普通路径
  assert.equal(await muCheck(req('/?ed=2560'), env, new URL('https://n1.example.com/?ed=2560'), '1.1.1.1'), null);
  // 关闭
  resetMuGuard();
  const off = nodeEnv({ v: 2, on: false, key: SECRET, ids: [], over: {} });
  assert.equal((await muCheck(req('/_uaaaa1111/'), off, new URL('https://n1.example.com/_uaaaa1111/'), '1.1.1.1')).reason, 'disabled');
  // 没绑定 KV
  resetMuGuard();
  assert.equal((await muCheck(req('/_uaaaa1111/'), {}, new URL('https://n1.example.com/_uaaaa1111/'), '1.1.1.1')).ok, false);
});

test('节点：超限用户只放行允许的 IP；被拒的连接也上报（限制保持稳定）', async () => {
  const points = [];
  const tagA = await ipTag(SECRET, '1.1.1.1');
  const env = nodeEnv({ v: 2, on: true, key: SECRET, ids: ['aaaa1111'], over: { aaaa1111: [tagA] } }, { writeDataPoint: (p) => points.push(p) });
  const u = new URL('https://n1.example.com/_uaaaa1111/');
  assert.equal((await muCheck(req(u.pathname, '1.1.1.1'), env, u, '1.1.1.1')).ok, true);
  assert.deepEqual(await muCheck(req(u.pathname, '9.9.9.9'), env, u, '9.9.9.9'), { ok: false, reason: 'over_limit' });
  assert.equal(points.length, 2);
  assert.equal(points[1].blobs[3], '0');
});

test('汇总：先到先得；上一轮放行的 IP 优先保留；单独设置的上限、0 = 不限、封禁的不算', () => {
  const settings = settingsWith({ users: { enabled: true, defaultLimit: 2 } });
  const T = (s) => new Date(1_800_000_000_000 + s * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const byUser = mergeOnline([
    [{ u: 'u1', t: 'a', f: T(10), l: T(200) }, { u: 'u1', t: 'b', f: T(20), l: T(200) }, { u: 'u1', t: 'c', f: T(5), l: T(200) }],
    [{ u: 'u1', t: 'a', f: T(1), l: T(250) }, { u: 'u2', t: 'x', f: T(1), l: T(2) }, { u: 'u2', t: 'y', f: T(1), l: T(2) }, { u: 'u3', t: 'p', f: T(1), l: T(2) }, { u: 'u3', t: 'q', f: T(2), l: T(2) }, { u: 'u3', t: 'r', f: T(3), l: T(2) }],
  ]);
  assert.equal(byUser.get('u1').length, 3);
  const users = [{ id: 'u1', limit: null }, { id: 'u2', limit: 1 }, { id: 'u3', limit: 0 }, { id: 'u4', limit: 1, banned: true }];
  assert.deepEqual(computeOver(users, settings, byUser, {}), { u1: ['a', 'c'], u2: ['x'] });
  assert.deepEqual(computeOver(users, settings, byUser, { u1: ['b', 'c'] }).u1, ['b', 'c'], '上一轮放行的保留');
  const st = buildState({ nodeKey: SECRET, users, settings, over: {} });
  assert.deepEqual(st.ids, ['u1', 'u2', 'u3']);
  assert.deepEqual(buildState({ nodeKey: SECRET, users, settings: settingsWith({}), over: {} }), { v: 2, on: false, key: SECRET, ids: [], over: {} });
});

function cfFake({ online = [], pages = [] } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (u.endsWith('/analytics_engine/sql')) return new Response(JSON.stringify({ data: online }));
    if (u.includes('/storage/kv/namespaces?')) return ok([]);
    if (u.endsWith('/storage/kv/namespaces')) return ok({ id: 'ns1' });
    if (u.includes('/storage/kv/namespaces/ns1/values/')) return ok(null);
    if (u.includes('/pages/projects?')) return ok(pages);
    if (/\/pages\/projects\/[^/]+$/.test(u)) return ok({});
    if (u.endsWith('/retry')) return ok({});
    return new Response('{"success":false,"errors":[{"message":"nope"}]}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

test('节点账号配置：建 KV → 找到 Pages 项目加绑定 → 重试部署', async () => {
  const pages = [{ name: 'proj-a', subdomain: 'proj-a.pages.dev', domains: ['proj-a.pages.dev', 'n1.example.com'], canonical_deployment: { id: 'dep1' } }];
  assert.equal(findPagesProject(pages, ['n1.example.com'])?.name, 'proj-a');
  const f = cfFake({ pages });
  const meta = await setupAccount({ account: { id: 'a', hosts: ['n1.example.com'], auth: { apiToken: 't'.repeat(40) } }, cfId: HEX(1), fetchFn: f, now: 1 });
  assert.equal(meta.err, '');
  assert.deepEqual([meta.nsId, meta.project, meta.bound, meta.redeployed], ['ns1', 'proj-a', true, true]);
  const patch = f.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.body).deployment_configs.production, { kv_namespaces: { NT_MU: { namespace_id: 'ns1' } }, analytics_engine_datasets: { NT_AE: { dataset: 'nicetunnel_mu' } } });
  assert.ok(f.calls.some((c) => c.url.endsWith('/deployments/dep1/retry')));
  // 找不到项目：标记需要手动绑定，KV 仍然建好
  const m2 = await setupAccount({ account: { id: 'b', hosts: ['zz.example.com'], auth: { apiToken: 't'.repeat(40) } }, cfId: HEX(1), fetchFn: cfFake({ pages }), now: 1 });
  assert.equal(m2.nsId, 'ns1');
  assert.equal(m2.manual, true);
});

test('同步：查 AE → 算超限 → 写主站 KV 和各节点账号 KV；没变化不重复写', async () => {
  const kv = memKV({
    'nt.settings': settingsWith({ users: { enabled: true, defaultLimit: 1 } }),
    'nt.accounts': [{ id: 'n1', hosts: ['n1.com'], role: 'node', enabled: true, auth: { apiToken: 't'.repeat(40), accountId: HEX(1) } }],
    [MU_KEYS.users]: [{ id: 'aaaa1111', name: '', limit: null, banned: false, createdAt: 1 }],
    [MU_KEYS.secret]: SECRET,
    [MU_KEYS.accounts]: { n1: { nsId: 'ns1', bound: true } },
  });
  const store = createStore({ kv });
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const f = cfFake({ online: [{ u: 'aaaa1111', t: 'tag1', f: iso(now - 200e3), l: iso(now) }, { u: 'aaaa1111', t: 'tag2', f: iso(now - 100e3), l: iso(now) }] });
  const accounts = await store.getAccounts();
  const r = await syncUsers({ store, settings: await store.getSettings(), accounts, usage: null, fetchFn: f, now });
  assert.deepEqual(r.pushed, ['n1']);
  assert.equal(r.over, 1);
  const st = JSON.parse(kv.m.get(MU_STATE_KEY));
  assert.deepEqual(st.over, { aaaa1111: ['tag1'] });
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.includes('/namespaces/ns1/values/nt.mu.state'));
  const { v, on, key, ids, over } = st;
  assert.deepEqual(JSON.parse(put.body), { v, on, key, ids, over }, '节点账号只拿状态部分');
  assert.equal(key, await nodeKeyOf(SECRET), '下发的是派生的节点密钥');
  assert.ok(!put.body.includes(SECRET), '主密钥不下发');
  const r2 = await syncUsers({ store, settings: await store.getSettings(), accounts, usage: null, fetchFn: f, now: now + 60e3 });
  assert.equal(r2.changed, false);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('每分钟的 Cron 触发器只做多用户同步', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({ users: { enabled: true } }), 'nt.accounts': [], [MU_KEYS.secret]: SECRET });
  const r = await runScheduled({ event: { cron: MU_CRON }, env: { KV: kv }, fetchFn: fakeFetch({}) });
  assert.ok(r.users);
  assert.equal(r.usage, null);
  assert.equal(r.maintenance, null);
});

test('后台 + 订阅：开启后批量生成 → 专属订阅用该用户的 UUID 和路径前缀；封禁后 403；关闭后伪装页；原订阅不变', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({ users: { enabled: true } }), 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw' };
  const id = deriveIdentity(env, 'vp.example.com');
  const cookie = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt', 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body, headers = cookie) => worker.fetch(new Request('https://vp.example.com' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  globalThis.fetch = fakeFetch({});
  const made = await (await call('/admin/api/users/create', 'POST', { count: 3, prefix: '客户-', limit: 1 })).json();
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.created.length, 3);
  assert.equal(made.created[0].name, '客户-1');
  const u0 = made.created[0];
  assert.match(u0.sub, /^https:\/\/vp\.example\.com\/sub\?u=[a-z0-9]{8}\.[0-9a-f]{20}$/);
  const list = await (await call('/admin/api/users')).json();
  assert.equal(list.total, 3);
  // 专属订阅
  const sub = (u) => worker.fetch(new Request(u + '&target=base64', { headers: { 'User-Agent': 'v2rayN', 'CF-Connecting-IP': '7.7.7.7' } }), env, { waitUntil() {} });
  const r = await sub(u0.sub);
  assert.equal(r.status, 200);
  const text = atob((await r.text()).trim());
  const secret = kv.m.get(MU_KEYS.secret);
  assert.ok(text.includes(await userUuid(await nodeKeyOf(secret), u0.id)), '用该用户的 UUID');
  assert.ok(!text.includes(id.uuid), '不出现共享 UUID');
  assert.ok(text.includes(encodeURIComponent('/_u' + u0.id)) || text.includes('/_u' + u0.id), '路径带前缀');
  // 伪造签名
  assert.ok(!(await sub(u0.sub.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).headers.get('content-type')?.includes('octet'));
  // 封禁
  assert.equal((await call('/admin/api/users/update', 'POST', { ids: [u0.id], banned: true })).status, 200);
  assert.equal((await sub(u0.sub)).status, 403);
  assert.deepEqual(JSON.parse(kv.m.get(MU_STATE_KEY)).ids.includes(u0.id), false, '下发的名单里没有被封的用户');
  // 原订阅照常
  assert.equal((await worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken, { headers: { 'User-Agent': 'v2rayN' } }), env, { waitUntil() {} })).status, 200);
  // 关闭多用户：专属订阅变伪装页，下发状态 on=false
  await call('/admin/api/settings', 'PUT', { users: { enabled: false } });
  resetStoreState();
  const off = await sub(made.created[1].sub);
  assert.ok((off.headers.get('content-type') || '').includes('text/html'));
  await runScheduled({ env, fetchFn: fakeFetch({}) });
  assert.equal(JSON.parse(kv.m.get(MU_STATE_KEY)).on, false);
});
