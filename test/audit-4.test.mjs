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
    if (u.includes('/pages/projects?')) return ok([{ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], source: { type: 'github' }, canonical_deployment: { id: 'd1' },
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
    if (u.includes('/pages/projects?page=2')) return ok([{ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], source: { type: 'github' }, canonical_deployment: { id: 'd1' } }], { page: 2, total_pages: 2 });
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
    if (u.includes('/pages/projects?page=1')) return ok([{ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], source: { type: 'github' }, canonical_deployment: { id: 'd1' } }]);
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

test('自动配置：直接上传的项目不去重试（CF 不允许），提示重新上传；上传后再点一次自动检测到新部署变为就绪', async () => {
  const { accountReady } = await import('../src/control/users.js');
  let canonical = { id: 'old', created_on: '2026-11-01T04:00:53Z', latest_stage: { status: 'success' } };
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    const m = init.method || 'GET';
    calls.push(m + ' ' + u);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    // 真实接口：直接上传的项目没有 source 字段；重试返回 400
    const proj = () => ({ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], canonical_deployment: canonical, deployment_configs: { production: {} } });
    if (u.includes('/storage/kv/namespaces?')) return ok([{ id: 'ns1', title: 'nicetunnel-mu' }]);
    if (u.includes('/pages/projects?page=1')) return ok([proj()]);
    if (u.endsWith('/retry')) return new Response(JSON.stringify({ success: false, errors: [{ message: 'You cannot retry a Direct Upload deployment. Retries are only possible for builds' }] }), { status: 400 });
    if (/\/pages\/projects\/p$/.test(u)) return ok(m === 'GET' ? proj() : {});
    return ok({});
  };
  const account = { id: 'a', hosts: ['n1.com'], auth: { apiToken: 't'.repeat(40) } };
  const t1 = Date.parse('2026-11-01T05:00:00Z');
  const m1 = await setupAccount({ account, cfId: HEX(1), fetchFn, now: t1 });
  assert.equal(m1.bound, true);
  assert.equal(m1.directUpload, true);
  assert.match(m1.err, /重新上传/);
  assert.ok(!calls.some((c) => c.endsWith('/retry')), '直接上传的项目不去调重试接口');
  assert.equal(accountReady(m1), false);
  // 管理员重新上传了节点包：出现比加绑定更晚的生产部署
  canonical = { id: 'new', created_on: '2026-11-01T05:10:00Z', latest_stage: { status: 'success' } };
  const m2 = await setupAccount({ account, cfId: HEX(1), fetchFn, now: t1 + 15 * 60e3, prev: m1 });
  assert.equal(m2.redeployed, true);
  assert.equal(m2.err, '');
  assert.equal(accountReady(m2), true);
});

test('deploy-node 脚本：按页找项目；部署请求是 multipart，manifest 为空并带 _worker.js', async () => {
  const { findProjectByHost, deployWorker } = await import('../scripts/deploy-node.mjs');
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push({ u, init });
    const ok = (result, info) => new Response(JSON.stringify({ success: true, result, ...(info ? { result_info: info } : {}) }));
    if (u.includes('/pages/projects?page=1')) return ok([{ name: 'a', subdomain: 'a.pages.dev', domains: [] }], { total_pages: 2 });
    if (u.includes('/pages/projects?page=2')) return ok([{ name: 'syf', subdomain: 'syf.pages.dev', domains: ['v1n3.example.xyz'] }], { total_pages: 2 });
    if (u.endsWith('/pages/projects/syf/deployments')) return ok({ id: 'dep-new', environment: 'production', latest_stage: { name: 'deploy', status: 'success' } });
    return new Response('{"success":false}', { status: 404 });
  };
  try {
    assert.equal(await findProjectByHost('tok', 'acc', 'V1N3.example.xyz'), 'syf');
    const d = await deployWorker('tok', 'acc', 'syf', Buffer.from('export default {}'));
    assert.equal(d.id, 'dep-new');
    const req = seen.at(-1);
    assert.equal(req.init.method, 'POST');
    assert.equal(req.init.headers.Authorization, 'Bearer tok');
    const form = req.init.body;
    assert.equal(form.get('manifest'), '{}');
    assert.equal(form.get('_worker.js').name, '_worker.js');
    assert.equal(await form.get('_worker.js').text(), 'export default {}');
  } finally { globalThis.fetch = realFetch; }
});

test('自动配置 + Analytics Engine：查不了 AE 就不加 NT_AE；部署因没开通 AE 失败时自动去掉；开通后再点会补回', async () => {
  const { accountReady } = await import('../src/control/users.js');
  let aeOk = false;
  let canonical = { id: 'd-old', latest_stage: { status: 'success' } };
  let latest = canonical;
  const patches = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    const m = init.method || 'GET';
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    const proj = () => ({ name: 'p', subdomain: 'p.pages.dev', domains: ['n1.com'], canonical_deployment: canonical, latest_deployment: latest, deployment_configs: { production: {} } });
    if (u.includes('/storage/kv/namespaces?')) return ok([{ id: 'ns1', title: 'nicetunnel-mu' }]);
    if (u.endsWith('/analytics_engine/sql')) return aeOk ? new Response('{"data":[]}') : new Response('Authorization error', { status: 403 });
    if (u.includes('/pages/projects?page=1')) return ok([proj()]);
    if (u.endsWith('/history/logs')) return ok({ data: [{ ts: 'x', line: 'Error: Failed to publish your Function. Got error: You need to enable Analytics Engine. Head to the Cloudflare Dashboard to enable: https://dash.cloudflare.com/x/workers' }] });
    if (/\/pages\/projects\/p$/.test(u)) { if (m === 'PATCH') { patches.push(JSON.parse(init.body)); return ok({}); } return ok(proj()); }
    return ok({});
  };
  const account = { id: 'a', hosts: ['n1.com'], auth: { apiToken: 't'.repeat(40) } };
  // 1) AE 查不了：只加 KV 绑定
  const m1 = await setupAccount({ account, cfId: HEX(1), fetchFn, now: 1 });
  assert.equal(m1.aeMissing, true);
  const prod1 = patches[0].deployment_configs.production;
  assert.ok(prod1.kv_namespaces.NT_MU);
  assert.equal(prod1.analytics_engine_datasets, undefined, '不加 NT_AE');
  assert.equal(accountReady(m1), false);
  // 2) 旧版已经加了 NT_AE、部署因没开通 AE 失败：读日志、去掉 NT_AE、提示再上传
  latest = { id: 'd-fail', latest_stage: { status: 'failure' } };
  const m2 = await setupAccount({ account, cfId: HEX(1), fetchFn, now: 2, prev: { nsId: 'ns1', bound: true, project: 'p', deployId: 'd-old', directUpload: true } });
  assert.match(m2.err, /没开通 Analytics Engine/);
  assert.deepEqual(patches.at(-1).deployment_configs.production.analytics_engine_datasets, { NT_AE: null });
  // 3) 再上传一次：正式部署换成新的 → 就绪（判断不依赖点击时间）
  canonical = { id: 'd-new', latest_stage: { status: 'success' } };
  latest = canonical;
  const m3 = await setupAccount({ account, cfId: HEX(1), fetchFn, now: 3, prev: m2 });
  assert.equal(m3.redeployed, true);
  assert.equal(accountReady(m3), true);
  // 4) 开通 AE 后再点：补上 NT_AE，需要再部署一次
  aeOk = true;
  const n = patches.length;
  const m4 = await setupAccount({ account, cfId: HEX(1), fetchFn, now: 4, prev: m3 });
  assert.deepEqual(patches[n].deployment_configs.production.analytics_engine_datasets, { NT_AE: { dataset: 'nicetunnel_mu' } });
  assert.equal(m4.aeMissing, false);
  assert.equal(m4.redeployed, false);
  assert.equal(m4.bindDeployId, 'd-new');
});
