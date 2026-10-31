// 后台"检测节点"结果用于分配：坏节点不再分配，不支持地区路由的节点不承载地区条目
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { resetRulesState } from '../src/control/rulesfeed.js';
import { deriveIdentity } from '../src/control/identity.js';
import { applyHostChecks, HOST_CHECK_TTL_MS } from '../src/control/allocator.js';
import { memKV, fakeFetch } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetRulesState(); });
afterEach(() => { globalThis.fetch = realFetch; });

const H = (host) => ({ host, weight: 1 });
const now = 1e12;

test('applyHostChecks：down/bad 排除；edt / 没有 pool-route 能力的不承载地区；过期结果忽略；全排除时回退', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'].map(H);
  const checks = { hosts: {
    a: { s: 'down', at: now }, b: { s: 'bad', at: now }, c: { s: 'edt', at: now },
    d: { s: 'ok', at: now, caps: ['chain-path@1'] }, e: { s: 'down', at: now - HOST_CHECK_TTL_MS - 1 },
  } };
  const r = applyHostChecks(pool, checks, now);
  assert.deepEqual(r.pool.map((h) => h.host), ['c', 'd', 'e']);
  assert.deepEqual(r.regionPool.map((h) => h.host), ['e']);
  assert.deepEqual(r.excluded, ['a', 'b']);
  assert.deepEqual(r.noRegion, ['c', 'd']);
  const all = applyHostChecks([H('a')], { hosts: { a: { s: 'down', at: now } } }, now);
  assert.deepEqual(all.pool.map((h) => h.host), ['a'], '全被排除时回退原池');
  assert.deepEqual(applyHostChecks(pool, null, now).pool.length, 5, '没有检测结果时不变');
});

function setup() {
  const settings = {
    schema: 4,
    preferred: { custom: { enabled: false }, random: { enabled: true, count: 12, aggregate: false } },
    hosts: { unmanaged: ['good.example.com', 'dead.example.com', 'wrong-uuid.example.com'] },
    allocation: { maxShare: 1 },
    rules: { configText: '', configUrl: '' },
  };
  const kv = memKV({ 'nt.settings': settings, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pass123', KEY: 'mykey' };
  return { kv, env, id: deriveIdentity(env, 'vp.example.com'), ctx: { waitUntil() {} } };
}
const req = (path, init = {}) => new Request('https://vp.example.com' + path, { method: init.method || 'GET', headers: { 'User-Agent': 'v2rayN/6', 'CF-Connecting-IP': '1.2.3.4', ...(init.headers || {}) }, body: init.body });

test('POST /admin/api/hosts/checks 保存结果后，订阅不再分配到坏节点', async () => {
  const { env, id, ctx } = setup();
  globalThis.fetch = fakeFetch({});
  const decode = async (r) => Buffer.from(await r.text(), 'base64').toString('utf8');
  const before = await decode(await worker.fetch(req('/sub?token=' + id.subToken + '&b64'), env, ctx));
  assert.ok(before.includes('dead.example.com') || before.includes('wrong-uuid.example.com'), '检测前坏节点也会被分配');
  const auth = { Authorization: 'Bearer ' + env.ADMIN, 'Content-Type': 'application/json' };
  const r = await worker.fetch(req('/admin/api/hosts/checks', { method: 'POST', headers: auth, body: JSON.stringify({ results: [
    { host: 'good.example.com', state: 'ok', caps: ['pool-route@1'] },
    { host: 'dead.example.com', state: 'down' },
    { host: 'WRONG-UUID.example.com', state: 'bad' },
    { host: 'x.example.com', state: 'nonsense' },
  ] }) }), env, ctx);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.excluded.sort(), ['dead.example.com', 'wrong-uuid.example.com']);
  assert.equal(j.saved, 3, '非法状态被丢弃');
  resetPipelineState(); resetStoreState(); // 模拟另一个 isolate（不受内存缓存影响）
  const after = await decode(await worker.fetch(req('/sub?token=' + id.subToken + '&b64'), env, ctx));
  assert.ok(after.includes('good.example.com'));
  assert.ok(!after.includes('dead.example.com') && !after.includes('wrong-uuid.example.com'), '坏节点不再出现在订阅里');
});

test('hosts/checks 需要登录', async () => {
  const { env, ctx } = setup();
  const r = await worker.fetch(req('/admin/api/hosts/checks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"results":[]}' }), env, ctx);
  assert.equal(r.status, 401);
});
