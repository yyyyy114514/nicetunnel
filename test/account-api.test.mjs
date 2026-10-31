// 给脚本用的账号接口：Bearer 鉴权 + upsert / delete
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { defaultLoginThrottle } from '../src/control/auth.js';
import { memKV, TEST_AUTH_KEY } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); });
afterEach(() => { globalThis.fetch = realFetch; });

const PW = 'my-admin-pass';
const HEX = (i) => i.toString(16).padStart(32, '0');
let ipSeq = 0;
function setup() {
  const kv = memKV({ 'nt.settings': { schema: 2 }, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: PW, KEY: 'k' };
  const ip = `10.99.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`; // 每个测试独立 IP，避免节流互相影响
  const call = (method, path, body, headers = {}) => worker.fetch(new Request('https://vp.example.com/admin/api/' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...headers },
  }), env, { waitUntil() {} });
  const bearer = { Authorization: 'Bearer ' + PW };
  const saved = () => JSON.parse(kv.m.get('nt.accounts') || '[]');
  return { kv, env, ip, call, bearer, saved };
}

test('Bearer 鉴权：正确密码可用且不需要 CSRF 头；没带/错误都是 401；cookie 路径仍要求 CSRF 头', async () => {
  const { env, call, bearer } = setup();
  const ok = await call('GET', 'accounts', undefined, bearer);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  const post = await call('POST', 'accounts/upsert', { text: `a.example.com,${HEX(1)},tok` }, bearer);
  assert.equal(post.status, 200, 'Bearer 的 POST 不需要 X-Requested-With');
  assert.equal((await call('GET', 'accounts')).status, 401);
  assert.equal((await call('GET', 'accounts', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call('GET', 'accounts', undefined, { Authorization: 'Basic ' + PW })).status, 401, '只认 Bearer');
  // cookie 登录的变更请求仍然必须带 CSRF 头
  const id = deriveIdentity(env, 'vp.example.com');
  const cookie = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0' };
  assert.equal((await call('POST', 'accounts/upsert', { accounts: [{ host: 'b.example.com' }] }, cookie)).status, 403);
  assert.equal((await call('POST', 'accounts/upsert', { accounts: [{ host: 'b.example.com' }] }, { ...cookie, 'X-Requested-With': 'nt' })).status, 200);
});

test('Bearer 错误令牌：同一 IP 连续 5 次后 429（防暴力猜密码），其它 IP 不受影响', async () => {
  const a = setup(), b = setup();
  defaultLoginThrottle.reset('api|' + a.ip);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await a.call('GET', 'accounts', undefined, { Authorization: 'Bearer nope' + i })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  const blocked = await a.call('GET', 'accounts', undefined, a.bearer);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal((await b.call('GET', 'accounts', undefined, b.bearer)).status, 200);
});

test('upsert：新增 → 更新幂等；host 别名、text 行格式；旧凭据不被空值覆盖；响应里没有令牌', async () => {
  const { call, bearer, saved } = setup();
  const r1 = await (await call('POST', 'accounts/upsert', {
    accounts: [{ host: 'vp2.example.com', accountId: HEX(2), apiToken: 'SECRET-TOKEN-2', name: '二号' }],
    text: `vp3.example.com,${HEX(3)},SECRET-TOKEN-3,三号\n# 注释\nbad line without anything`,
  }, bearer)).json();
  assert.deepEqual([r1.ok, r1.added, r1.updated, r1.total], [true, 2, 0, 2]);
  assert.ok(r1.parseErrors.length >= 1, '坏行被报告');
  assert.equal(JSON.stringify(r1).includes('SECRET-TOKEN'), false, '响应里不能出现令牌');
  assert.deepEqual(r1.accounts.map((a) => a.hosts[0]).sort(), ['vp2.example.com', 'vp3.example.com']);
  assert.ok(r1.accounts.every((a) => a.auth.hasToken === true));
  assert.deepEqual(saved().map((a) => a.auth.apiToken).sort(), ['SECRET-TOKEN-2', 'SECRET-TOKEN-3']);

  // 同一个 host 再提交：不新增；名字为空不覆盖；令牌为空保留旧值；role 不被覆盖
  const r2 = await (await call('POST', 'accounts/upsert', { accounts: [{ host: 'vp2.example.com', apiToken: '', role: 'off', weight: 5 }] }, bearer)).json();
  assert.deepEqual([r2.added, r2.updated, r2.total], [0, 1, 2]);
  const two = saved().find((a) => a.hosts.includes('vp2.example.com'));
  assert.deepEqual([two.name, two.auth.apiToken, two.role, two.weight], ['二号', 'SECRET-TOKEN-2', 'node', 1]);
  // overwrite:true 才覆盖 role / weight
  await call('POST', 'accounts/upsert', { accounts: [{ host: 'vp2.example.com', role: 'off', weight: 5 }], overwrite: true }, bearer);
  const two2 = saved().find((a) => a.hosts.includes('vp2.example.com'));
  assert.deepEqual([two2.role, two2.weight], ['off', 5]);
  // 换令牌：更新而不是新增
  await call('POST', 'accounts/upsert', { accounts: [{ host: 'vp3.example.com', apiToken: 'NEW-TOKEN' }] }, bearer);
  assert.equal(saved().find((a) => a.hosts.includes('vp3.example.com')).auth.apiToken, 'NEW-TOKEN');
});

test('upsert：参数校验', async () => {
  const { call, bearer } = setup();
  const e1 = await call('POST', 'accounts/upsert', {}, bearer);
  assert.equal(e1.status, 400);
  assert.equal((await e1.json()).code, 'invalid');
  const many = Array.from({ length: 501 }, (_, i) => ({ host: `h${i}.example.com` }));
  assert.equal((await call('POST', 'accounts/upsert', { accounts: many }, bearer)).status, 400);
  assert.equal((await call('POST', 'accounts/upsert', { accounts: [{ host: 'ok.example.com' }] }, { ...bearer, 'Content-Type': 'application/json' })).status, 200);
});

test('upsert + poll:true：保存后立刻验证令牌，失败原因不含令牌；5 秒内重复 poll 只保存不轮询（不报 429）', async () => {
  const { call, bearer } = setup();
  globalThis.fetch = async (url, init) => {
    const auth = String(init?.headers?.Authorization || '');
    if (String(url).endsWith('/graphql')) {
      if (auth.includes('BAD')) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 5 } }], workersInvocationsAdaptive: [{ sum: { requests: 7 } }] }] } } }));
    }
    return new Response('not found', { status: 404 });
  };
  const r = await (await call('POST', 'accounts/upsert', {
    text: `good.example.com,${HEX(1)},GOOD-TOKEN,好\nbad.example.com,${HEX(2)},BAD-TOKEN,坏`,
    poll: true,
  }, bearer)).json();
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.polled.map((p) => [p.host, p]));
  assert.deepEqual([by['good.example.com'].ok, by['good.example.com'].used], [true, 12]);
  assert.equal(by['bad.example.com'].ok, false);
  assert.equal(by['bad.example.com'].kind, 'auth');
  assert.equal(JSON.stringify(r).includes('TOKEN'), false);
  const again = await call('POST', 'accounts/upsert', { accounts: [{ host: 'x.example.com' }], poll: true }, bearer);
  // 账号已经保存：返回 200 + pollSkipped，而不是 429（否则脚本以为保存失败）
  assert.equal(again.status, 200);
  const aj = await again.json();
  assert.equal(aj.ok, true);
  assert.ok(aj.pollSkipped && !aj.polled);
});

test('delete：按 host 或 id 删除；参数为空 400；幂等', async () => {
  const { call, bearer, saved } = setup();
  await call('POST', 'accounts/upsert', { text: `a.example.com,${HEX(1)},t1\nb.example.com,${HEX(2)},t2\nc.example.com,${HEX(3)},t3` }, bearer);
  const ids = saved().map((a) => a.id);
  assert.equal(ids.length, 3);
  const r1 = await (await call('POST', 'accounts/delete', { hosts: ['https://A.example.com/x', 'zzz.example.com'] }, bearer)).json();
  assert.deepEqual([r1.removed, r1.total], [1, 2]);
  const r2 = await (await call('POST', 'accounts/delete', { ids: [ids[1]] }, bearer)).json();
  assert.deepEqual([r2.removed, r2.total], [1, 1]);
  const r3 = await (await call('POST', 'accounts/delete', { hosts: ['a.example.com'] }, bearer)).json();
  assert.deepEqual([r3.removed, r3.total], [0, 1], '重复删除不报错');
  assert.equal((await call('POST', 'accounts/delete', {}, bearer)).status, 400);
});
