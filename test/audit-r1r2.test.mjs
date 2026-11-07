// 审计 R1 / R2 的回归测试
// R1：用户提交标识、自动封禁写回时不能用旧数据整表覆盖 nt.users（解封别人、删掉刚建的用户）
// R2：Cron 子请求按预算分配：自动封禁不再挤掉下发和用量轮询；每分钟触发器在用时 5 分钟那次不再做多用户的事
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { runAutoBan, MU_KEYS, getLabelMap } from '../src/control/users.js';
import { runScheduled, MU_CRON, countingFetch } from '../src/control/cron.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { memKV, fakeFetch, settingsWith, TEST_AUTH_KEY } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); globalThis.fetch = fakeFetch({}); });
afterEach(() => { globalThis.fetch = realFetch; });
const SECRET = 'c'.repeat(64);
const HEX = (i) => (i + 1).toString(16).padStart(32, '0');
const T0 = Date.UTC(2026, 10, 1, 4, 0, 0); // 整 10 分钟：自动封禁这一分钟该检查
const users = () => JSON.parse(globalThis.__kv.m.get(MU_KEYS.users));

test('R1：用户提交标识只写自己的键，不会用缓存的旧名单冲掉别处刚做的封禁 / 新建', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({ users: { enabled: true } }), 'nt.accounts': [] });
  globalThis.__kv = kv;
  const env = { KV: kv, ADMIN: 'pw' };
  const id = deriveIdentity(env, 'vp.example.com');
  const h = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt', 'Content-Type': 'application/json' };
  const call = (path, init = {}) => worker.fetch(new Request('https://vp.example.com' + path, { headers: h, ...init }), env, { waitUntil() {} });
  const made = (await (await call('/admin/api/users/create', { method: 'POST', body: JSON.stringify({ count: 2 }) })).json()).created;
  const [a, b] = made;
  // 本实例把名单缓存下来（打开订阅页）
  await worker.fetch(new Request(a.sub.replace(/^https:\/\/[^/]+/, 'https://vp.example.com'), { headers: { 'User-Agent': 'Mozilla/5.0 Chrome' } }), env, { waitUntil() {} });
  // 另一个实例：封禁了 B、新建了 C（直接改 KV，本实例的缓存不知道）
  const list = users();
  list.find((u) => u.id === b.id).banned = true;
  list.push({ id: 'cccc3333', name: '新', banned: false, createdAt: 2 });
  kv.m.set(MU_KEYS.users, JSON.stringify(list));
  // A 提交标识
  const r = await worker.fetch(new Request(a.sub.replace(/^https:\/\/[^/]+/, 'https://vp.example.com').replace('/sub?', '/sub/label?'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: '甲' }) }), env, { waitUntil() {} });
  assert.equal(r.status, 200);
  const after = users();
  assert.equal(after.find((u) => u.id === b.id).banned, true, 'B 仍然封禁');
  assert.ok(after.some((u) => u.id === 'cccc3333'), 'C 还在');
  assert.equal(JSON.parse(kv.m.get('nt.ul.' + a.id)).label, '甲', '标识写在单独的键里');
  assert.deepEqual(kv.meta.get('nt.ul.' + a.id), { l: '甲', a: JSON.parse(kv.m.get('nt.ul.' + a.id)).at }, '元数据里也有，后台一次 list 就能读到');
  // 后台列表能看到（合并单独的键）
  resetStoreState();
  const view = await (await call('/admin/api/users?q=' + encodeURIComponent('甲'))).json();
  assert.deepEqual(view.users.map((u) => [u.id, u.label]), [[a.id, '甲']]);
});

test('R1：标识的 list 读取会翻页（超过 1000 个键）', async () => {
  const kv = memKV({});
  for (let i = 0; i < 1203; i++) await kv.put('nt.ul.' + String(i).padStart(8, '0'), '{}', { metadata: { l: 'x' + i, a: 1 } });
  const store = createStore({ kv });
  const m = await getLabelMap(store);
  assert.equal(m.size, 1203);
  assert.equal(kv.lists, 2);
});

function abSetup({ accounts = 1, autoBan, extra = {} } = {}) {
  const accs = Array.from({ length: accounts }, (_, i) => ({ id: 'n' + i, hosts: [`n${i}.com`], role: 'node', enabled: true, auth: { apiToken: 't'.repeat(40), accountId: HEX(i) } }));
  const kv = memKV({
    'nt.settings': settingsWith({ users: { enabled: true, autoBan } }),
    'nt.accounts': accs,
    [MU_KEYS.users]: [{ id: 'aaaa1111', name: '', banned: false, createdAt: 1 }, { id: 'bbbb2222', name: '', banned: false, createdAt: 1 }],
    [MU_KEYS.secret]: SECRET,
    [MU_KEYS.accounts]: Object.fromEntries(accs.map((a) => [a.id, { nsId: 'ns' + a.id, bound: true, redeployed: true }])),
    ...extra,
  });
  globalThis.__kv = kv;
  return kv;
}
const aeRows = [{ u: 'aaaa1111', t: 'ip1', k: 'HKG', c: 5000 }];

test('R1：自动封禁写回前读最新名单——查询期间后台新建的用户不会丢；查询期间被后台解封的不再封', async () => {
  const kv = abSetup({ autoBan: { enabled: true, conns: { enabled: true, count: 1000, hours: 24 } } });
  let first = true;
  const fetchFn = async (url) => {
    if (String(url).endsWith('/analytics_engine/sql')) {
      if (first) { // 查询进行中：后台新建了一个用户
        first = false;
        const l = users(); l.push({ id: 'cccc3333', name: '', banned: false, createdAt: 2 }); kv.m.set(MU_KEYS.users, JSON.stringify(l));
      }
      return new Response(JSON.stringify({ data: aeRows }));
    }
    return new Response('{"success":true,"result":null}');
  };
  const store = createStore({ kv, now: () => T0 });
  const settings = await store.getSettings();
  const r = await runAutoBan({ store, settings, accounts: await store.getAccounts(), usage: null, fetchFn, now: T0 });
  assert.deepEqual(r.banned.map((x) => x.id), ['aaaa1111']);
  assert.ok(users().some((u) => u.id === 'cccc3333'), '新建的用户还在');
  assert.equal(users().find((u) => u.id === 'aaaa1111').banned, true);

  // 再来一次：查询期间后台把 aaaa 解封了 → 这次结果作废
  resetStoreState();
  kv.m.set(MU_KEYS.users, JSON.stringify(users().map((u) => ({ ...u, banned: false, bannedUntil: 0, banAt: 0 }))));
  const T1 = T0 + 600e3;
  const fetch2 = async (url) => {
    if (String(url).endsWith('/analytics_engine/sql')) {
      kv.m.set(MU_KEYS.users, JSON.stringify(users().map((u) => (u.id === 'aaaa1111' ? { ...u, unbanAt: T1 + 1 } : u))));
      return new Response(JSON.stringify({ data: aeRows }));
    }
    return new Response('{"success":true,"result":null}');
  };
  const store2 = createStore({ kv, now: () => T1 });
  const r2 = await runAutoBan({ store: store2, settings, accounts: await store2.getAccounts(), usage: null, fetchFn: fetch2, now: T1 });
  assert.deepEqual(r2.banned, []);
  assert.equal(users().find((u) => u.id === 'aaaa1111').banned, false);
});

test('R2：自动封禁按预算查——放不下的窗口这次不查（不会部分数据误判），下次轮到它', async () => {
  const autoBan = { enabled: true, conns: { enabled: true, count: 1000, hours: 24 }, ips: { enabled: true, count: 100, hours: 1 }, colos: { enabled: true, count: 100, hours: 72 } };
  const kv = abSetup({ accounts: 5, autoBan });
  let n = 0;
  const fetchFn = async (url) => { if (String(url).endsWith('/analytics_engine/sql')) n++; return new Response(JSON.stringify({ data: [] })); };
  const store = createStore({ kv, now: () => T0 });
  const settings = await store.getSettings();
  const r = await runAutoBan({ store, settings, accounts: await store.getAccounts(), usage: null, fetchFn, now: T0, budget: 12 });
  assert.equal(n, 10, '3 个窗口 × 5 个账号放不下：只查 2 个窗口');
  assert.match(r.notes.join(), /子请求不够/);
  // 下一次检查从另一个窗口开始
  resetStoreState();
  const seen = [];
  const f2 = async (url, init) => { if (String(url).endsWith('/analytics_engine/sql')) seen.push(/> (\d+)/.exec(init.body)[1]); return new Response(JSON.stringify({ data: [] })); };
  const s2 = createStore({ kv, now: () => T0 + 600e3 });
  await runAutoBan({ store: s2, settings, accounts: await s2.getAccounts(), usage: null, fetchFn: f2, now: T0 + 600e3, budget: 5 });
  assert.equal(new Set(seen).size, 1);
});

test('R2：每分钟触发器 + 20 个账号 + 3 个窗口：子请求不超预算，下发一个不落；5 分钟那次不再做多用户的事', async () => {
  const autoBan = { enabled: true, conns: { enabled: true, count: 1000, hours: 24 }, ips: { enabled: true, count: 100, hours: 1 }, colos: { enabled: true, count: 100, hours: 72 } };
  const kv = abSetup({ accounts: 20, autoBan });
  const calls = { ae: 0, put: 0 };
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/analytics_engine/sql')) { calls.ae++; return new Response(JSON.stringify({ data: /blob1 AS u, blob2 AS t, blob3/.test(init.body) ? aeRows : [] })); }
    if (/\/storage\/kv\/namespaces\/.+\/values\//.test(u)) { calls.put++; return new Response('{"success":true,"result":null}'); }
    return new Response('{"success":true,"result":null}');
  };
  const r = await runScheduled({ event: { cron: MU_CRON }, env: { KV: kv }, fetchFn, now: T0 });
  assert.ok(r.subrequests <= 45, '不超过免费版预算：' + r.subrequests);
  assert.equal(calls.put, 20, '20 个账号都下发到了');
  assert.ok(r.autoBan.ran && calls.ae <= 45 - 20, 'AE 查询只用剩下的：' + calls.ae);
  assert.match(r.autoBan.notes.join(), /子请求不够/, '3 个窗口 × 20 个账号放不下：轮流查');
  assert.deepEqual(r.errors, []);
  assert.ok(kv.m.get(MU_KEYS.minuteTick), '记下每分钟触发器在用');
  // 5 分钟那次：交给每分钟触发器，不再同步 / 封禁
  resetStoreState();
  const r5 = await runScheduled({ event: { cron: '*/5 * * * *' }, env: { KV: kv }, fetchFn, now: T0 + 60e3 * 5 });
  assert.equal(r5.users, null);
  assert.equal(r5.autoBan, undefined);
});

test('R2：没有每分钟触发器、12 个账号、开了自动封禁：不轮到封禁检查的那几次，用量轮询不再只剩 2 个名额', async () => {
  const kv = abSetup({ accounts: 12, autoBan: { enabled: true, conns: { enabled: true, count: 1000, hours: 24 } } });
  const fetchFn = async () => new Response('{"success":true,"result":null,"data":null}');
  const r = await runScheduled({ event: { cron: '*/5 * * * *' }, env: { KV: kv }, fetchFn, now: T0 + 5 * 60e3 }); // 第 5 分钟：不检查封禁
  assert.ok(r.usage.polled >= 5, '轮询了 ' + r.usage.polled + ' 个');
  assert.ok(r.subrequests <= 45, '总数不超预算：' + r.subrequests);
  assert.ok(r.users, '多用户同步照常做');
});

test('countingFetch：超出预算的请求直接失败，不调用真正的 fetch', async () => {
  let real = 0;
  const f = countingFetch(async () => { real++; return new Response('ok'); }, 2);
  await f('a'); await f('b');
  await assert.rejects(() => f('c'), /预算/);
  assert.equal(real, 2);
  assert.equal(f.left(), 0);
});

test('N5：节点列表最多解析 2000 条（审计给的最坏正则 + 2MB 列表也只卡几百毫秒以内）', async () => {
  const { parseNodeList, MAX_LIST_LINES, regexRisk } = await import('../src/lib/pool-parse.js');
  const re = '^.*.*.*!';
  assert.equal(regexRisk(re), '', '这条能通过安全检查（多项式级）');
  const line = '1.2.3.4:443#' + 'a'.repeat(60) + '$socks5://u:p@5.6.7.8:1080';
  const big = Array.from({ length: Math.ceil(2e6 / line.length) }, () => line).join('\n');
  const t = performance.now();
  const r = parseNodeList(big, re);
  const ms = performance.now() - t;
  assert.equal(r.total, MAX_LIST_LINES);
  assert.ok(ms < 1000, '耗时 ' + Math.round(ms) + 'ms');
});
