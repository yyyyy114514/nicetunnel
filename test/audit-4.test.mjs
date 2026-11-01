// 第四轮：地区正则有上限量词绕过（N5）、节点只拿派生密钥（U1）、多用户同步写入节流（U2）、Pages 绑定不覆盖原有绑定
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { regexRisk, compileRegionRe, DEFAULT_REGION_RE } from '../src/lib/pool-parse.js';
import { unsafeRegex } from '../src/dataplane/pool-route.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { syncUsers, setupAccount, MU_KEYS, OVER_PUSH_MS, OVER_PUSH_DAILY_MAX } from '../src/control/users.js';
import { MU_STATE_KEY, nodeKeyOf, userSubSig } from '../src/lib/mu.js';
import { memKV, settingsWith } from './helpers.mjs';

beforeEach(() => resetStoreState());
const SECRET = 'c'.repeat(64);
const HEX = (i) => i.toString(16).padStart(32, '0');

test('N5：有上限的量词、可选量词、分支也计入上限；名称截到 64 字符', () => {
  const bypass = '^a{0,96}a{0,96}a{0,96}a{0,96}a{0,96}a{0,96}!';
  for (const bad of [bypass, 'a?a?a?a?aaaa', '(a|b)(a|b)(a|b)(a|b)x', 'x{2}y{2}z{2}w{2}', '.+?.+?.+?.+?']) {
    assert.ok(regexRisk(bad), bad);
    assert.ok(unsafeRegex(bad), bad);
    assert.equal(compileRegionRe(bad), null, bad);
  }
  // 懒惰标记、(?: 不算量词；默认和常见写法照常可用
  for (const ok of [DEFAULT_REGION_RE, '^(.+?)[-_](住宅|机房)(?:-\\d+)?$', '^(\\S+?)-(\\S+)']) assert.equal(regexRisk(ok), '', ok);
  // 实测：最坏的合法正则在 64 个字符的名称上也很快
  const re = compileRegionRe('^(.+?)(.+?)(.+?)!');
  const t = Date.now();
  re.test('a'.repeat(64));
  assert.ok(Date.now() - t < 200, '耗时 ' + (Date.now() - t) + 'ms');
});

function cf({ online }) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    if (u.endsWith('/analytics_engine/sql')) return new Response(JSON.stringify({ data: online() }));
    if (u.includes('/values/')) return new Response(JSON.stringify({ success: true, result: null }));
    return new Response('{"success":false}', { status: 404 });
  };
  fn.calls = calls;
  fn.puts = () => calls.filter((c) => c.method === 'PUT').length;
  return fn;
}
const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

function setup() {
  const kv = memKV({
    'nt.settings': settingsWith({ users: { enabled: true, defaultLimit: 1 } }),
    'nt.accounts': [{ id: 'n1', hosts: ['n1.com'], role: 'node', enabled: true, auth: { apiToken: 't'.repeat(40), accountId: HEX(1) } }],
    [MU_KEYS.users]: [{ id: 'aaaa1111', name: '', limit: null, banned: false, createdAt: 1 }, { id: 'bbbb2222', name: '', limit: null, banned: false, createdAt: 1 }],
    [MU_KEYS.secret]: SECRET,
    [MU_KEYS.accounts]: { n1: { nsId: 'ns1', bound: true } },
  });
  return kv;
}

test('U1：节点账号 KV 里只有派生的节点密钥，拿它伪造不了订阅签名', async () => {
  const kv = setup();
  const store = createStore({ kv });
  const f = cf({ online: () => [] });
  await syncUsers({ store, settings: await store.getSettings(), accounts: await store.getAccounts(), usage: null, fetchFn: f, now: Date.now() });
  const body = f.calls.find((c) => c.method === 'PUT').body;
  assert.ok(!body.includes(SECRET));
  const nodeKey = JSON.parse(body).key;
  assert.equal(nodeKey, await nodeKeyOf(SECRET));
  assert.notEqual(await userSubSig(nodeKey, 'aaaa1111'), await userSubSig(SECRET, 'aaaa1111'));
});

test('U2：只有超限名单变化时最快 5 分钟下发一次、每天有上限；封禁立即下发；主站每次只写一个键', async () => {
  const kv = setup();
  let rows = [];
  const f = cf({ online: () => rows });
  const t0 = Date.UTC(2026, 10, 1, 1, 0, 0);
  const run = async (t) => { resetStoreState(); const store = createStore({ kv, now: () => t }); return syncUsers({ store, settings: await store.getSettings(), accounts: await store.getAccounts(), usage: null, fetchFn: f, now: t }); };
  const on = (t, ...tags) => tags.map((tag, i) => ({ u: 'aaaa1111', t: tag, f: iso(t - 200e3 + i * 1000), l: iso(t) }));
  rows = on(t0, 'tag1', 'tag2');
  await run(t0);
  assert.equal(f.puts(), 1, '首次立即下发');
  assert.deepEqual(JSON.parse(kv.m.get(MU_STATE_KEY)).over, { aaaa1111: ['tag1'] });
  // 1 分钟后名单变了（tag1 下线、tag3 上来）：只是超限名单变化，5 分钟内不下发
  rows = on(t0 + 60e3, 'tag2', 'tag3');
  const writes0 = kv.writes;
  await run(t0 + 60e3);
  assert.equal(f.puts(), 1);
  assert.equal(kv.writes, writes0, '主站也不写');
  // 5 分钟后下发
  await run(t0 + OVER_PUSH_MS + 1000);
  assert.equal(f.puts(), 2);
  assert.deepEqual(JSON.parse(kv.m.get(MU_STATE_KEY)).over, { aaaa1111: ['tag2'] });
  // 封禁：立即下发
  kv.m.set(MU_KEYS.users, JSON.stringify([{ id: 'aaaa1111', banned: true }, { id: 'bbbb2222' }]));
  const w1 = kv.writes;
  await run(t0 + OVER_PUSH_MS + 2000);
  assert.equal(f.puts(), 3);
  assert.equal(kv.writes, w1 + 1, '主站只写一个键');
  assert.deepEqual(JSON.parse(kv.m.get(MU_STATE_KEY)).ids, ['bbbb2222']);
  // 每日上限：今天已经写到上限，超限名单变化不再下发（封禁仍然会）
  kv.m.set(MU_KEYS.users, JSON.stringify([{ id: 'aaaa1111' }, { id: 'bbbb2222' }]));
  await run(t0 + OVER_PUSH_MS + 3000);
  const rec = JSON.parse(kv.m.get(MU_STATE_KEY));
  kv.m.set(MU_STATE_KEY, JSON.stringify({ ...rec, writes: OVER_PUSH_DAILY_MAX }));
  const p = f.puts();
  rows = on(t0 + 3 * OVER_PUSH_MS, 'tag7', 'tag8');
  await run(t0 + 3 * OVER_PUSH_MS);
  assert.equal(f.puts(), p, '到上限后超限名单不下发');
  // 换日后计数清零
  await run(t0 + 86400e3);
  assert.equal(f.puts(), p + 1);
});

test('Pages 绑定：带上项目原有的 KV / AE 绑定，不会被整段替换掉', async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, m: init.method || 'GET', b: init.body });
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (u.includes('/storage/kv/namespaces?')) return ok([{ id: 'ns1', title: 'nicetunnel-mu' }]);
    if (u.includes('/pages/projects?')) return ok([{ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], canonical_deployment: { id: 'd1' },
      deployment_configs: { production: { kv_namespaces: { OTHER: { namespace_id: 'x' } }, analytics_engine_datasets: { MINE: { dataset: 'y' } } } } }]);
    return ok({});
  };
  const meta = await setupAccount({ account: { id: 'a', hosts: ['n1.com'], auth: { apiToken: 't'.repeat(40) } }, cfId: HEX(1), fetchFn, now: 1 });
  assert.equal(meta.err, '');
  const prod = JSON.parse(calls.find((c) => c.m === 'PATCH').b).deployment_configs.production;
  assert.deepEqual(Object.keys(prod.kv_namespaces).sort(), ['NT_MU', 'OTHER']);
  assert.deepEqual(Object.keys(prod.analytics_engine_datasets).sort(), ['MINE', 'NT_AE']);
});

test('Pages 项目列表：不带 per_page（CF 会报 400），按页翻到第 2 页也能找到', async () => {
  const urls = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    urls.push(u);
    const ok = (result, info) => new Response(JSON.stringify({ success: true, result, ...(info ? { result_info: info } : {}) }));
    if (u.includes('/storage/kv/namespaces?')) return ok([{ id: 'ns1', title: 'nicetunnel-mu' }]);
    if (/per_page/.test(u) && u.includes('/pages/projects')) return new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid list options provided.' }] }), { status: 400 });
    if (u.includes('/pages/projects?page=1')) return ok([{ name: 'other', subdomain: 'other.pages.dev', domains: ['x.com'] }], { page: 1, total_pages: 2 });
    if (u.includes('/pages/projects?page=2')) return ok([{ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], canonical_deployment: { id: 'd1' } }], { page: 2, total_pages: 2 });
    return ok({});
  };
  const meta = await setupAccount({ account: { id: 'a', hosts: ['n1.com'], auth: { apiToken: 't'.repeat(40) } }, cfId: HEX(1), fetchFn, now: 1 });
  assert.equal(meta.err, '');
  assert.equal(meta.project, 'p');
  assert.ok(!urls.some((u) => u.includes('/pages/projects?per_page')));
});

test('自动配置：项目被 Cloudflare 封禁时标记不可用；重新部署失败不算就绪，手动确认后才算', async () => {
  const { accountReady } = await import('../src/control/users.js');
  const mk = (retry) => async (url, init = {}) => {
    const u = String(url);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (u.includes('/storage/kv/namespaces?')) return ok([{ id: 'ns1', title: 'nicetunnel-mu' }]);
    if (u.includes('/pages/projects?page=1')) return ok([{ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], canonical_deployment: { id: 'd1' } }]);
    if (u.endsWith('/retry')) return retry();
    return ok({});
  };
  const account = { id: 'a', hosts: ['n1.com'], auth: { apiToken: 't'.repeat(40) } };
  // 实测 Cloudflare 的原话
  const blocked = await setupAccount({ account, cfId: HEX(1), now: 1, fetchFn: mk(() => new Response(JSON.stringify({ success: false, errors: [{ message: 'Your Pages project has been blocked. Contact abusereply@cloudflare.com.' }] }), { status: 400 })) });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.err, /封禁/);
  assert.equal(accountReady(blocked), false);
  assert.equal(accountReady({ ...blocked, manualBound: true }), false, '封禁的手动确认也不算');
  // 普通的部署失败：绑定加上了，但不算就绪；手动部署后勾选才算
  const failed = await setupAccount({ account, cfId: HEX(1), now: 1, fetchFn: mk(() => new Response('{"success":false,"errors":[{"message":"boom"}]}', { status: 500 })) });
  assert.equal(failed.bound, true);
  assert.ok(!failed.blocked);
  assert.equal(accountReady(failed), false);
  assert.equal(accountReady({ ...failed, manualBound: true }), true);
  // 一切正常
  const good = await setupAccount({ account, cfId: HEX(1), now: 1, fetchFn: mk(() => new Response('{"success":true,"result":{}}')) });
  assert.equal(accountReady(good), true);
});
