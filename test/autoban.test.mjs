// 封禁时长与自动封禁：时长解析、阶梯处罚与统计周期、规则判断（只算封禁 / 解封之后的数据）、Cron 检查、提示带时长、被封用户限速
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, banNotice, banActive, banUser, unbanUser, evaluateRules, aggregateRows, nodeAggSql } from '../src/control/autoban.js';
import { normalizeSettings } from '../src/control/settings.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { runAutoBan, buildState, MU_KEYS } from '../src/control/users.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { memKV, fakeFetch, settingsWith, TEST_AUTH_KEY } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); });
afterEach(() => { globalThis.fetch = realFetch; });
const SECRET = 'c'.repeat(64);
const HEX = (i) => i.toString(16).padStart(32, '0');
const T0 = Date.UTC(2026, 10, 1, 4, 0, 0);

test('时长：解析 30s / 5m / 24h / 3d / 永久；显示；提示带解封时间或"永久"', () => {
  assert.deepEqual(['30s', '5m', '24h', '3d', '永久', '0', 'x', '-1h', ''].map(parseDuration), [30, 300, 86400, 259200, 0, 0, null, null, null]);
  assert.equal(formatDuration(30), '30 秒');
  assert.equal(formatDuration(300), '5 分钟');
  assert.equal(formatDuration(0), '永久');
  assert.equal(banNotice('已停用', { bannedUntil: 0 }, T0), '已停用（永久）');
  assert.equal(banNotice('已停用', { bannedUntil: T0 + 3 * 3600e3 }, T0), '已停用（11-01 15:00 解封，剩余约 3 小时）', '北京时间');
});

test('阶梯处罚：周期内第 1/2/3/4/5 次分别封 30 秒 / 5 分钟 / 24 小时 / 72 小时 / 永久；超过统计周期从头算；手动封禁可设时长', () => {
  const cfg = normalizeSettings(settingsWith({})).users.autoBan;
  let u = { id: 'aaaa1111' };
  const untils = [];
  for (let i = 0; i < 6; i++) { u = banUser(u, { now: T0 + i * 1000, auto: true, cfg, reason: 'x' }); untils.push(u.bannedUntil ? (u.bannedUntil - (T0 + i * 1000)) / 1000 : 0); }
  assert.deepEqual(untils, [30, 300, 86400, 259200, 0, 0]);
  assert.equal(u.vio, 6);
  // 超过 168 小时：违规次数从 1 开始
  const later = banUser(u, { now: T0 + 169 * 3600e3, auto: true, cfg });
  assert.equal(later.vio, 1);
  assert.equal(later.bannedUntil, T0 + 169 * 3600e3 + 30e3);
  // 手动：2 小时 / 永久
  assert.equal(banUser({ id: 'b' }, { now: T0, seconds: 7200 }).bannedUntil, T0 + 7200e3);
  assert.equal(banUser({ id: 'b' }, { now: T0 }).bannedUntil, 0);
  // 到期自动失效
  const t = banUser({ id: 'b' }, { now: T0, seconds: 60 });
  assert.equal(banActive(t, T0 + 59e3), true);
  assert.equal(banActive(t, T0 + 61e3), false);
  const un = unbanUser(t, { now: T0 + 1000, resetVio: true });
  assert.deepEqual([un.banned, un.unbanAt, un.vio], [false, T0 + 1000, 0]);
});

test('规则判断：达到阈值就触发；封禁 / 解封之前的数据不算；已封禁的跳过', () => {
  const cfg = normalizeSettings(settingsWith({ users: { autoBan: { conns: { enabled: true, count: 100, hours: 24 }, ips: { enabled: true, count: 3, hours: 24 }, overLimit: { enabled: true, count: 2, hours: 24 } } } })).users.autoBan;
  const node = new Map([[24, aggregateRows(new Map(), [
    { u: 'aaaa1111', t: 'ip1', k: 'HKG', c: 150 },
    { u: 'bbbb2222', t: 'ip1', k: 'HKG', c: 5 }, { u: 'bbbb2222', t: 'ip2', k: 'NRT', c: 5 }, { u: 'bbbb2222', t: 'ip3', k: 'SIN', c: 5 },
    { u: 'cccc3333', t: 'ip1', k: 'HKG', c: 10 },
  ])]]);
  const users = [{ id: 'aaaa1111' }, { id: 'bbbb2222' }, { id: 'cccc3333' }, { id: 'dddd4444', banned: true, bannedUntil: 0 }];
  const hits = evaluateRules({ users, cfg, node, overHits: { cccc3333: [T0 - 3600e3, T0 - 60e3], dddd4444: [T0, T0] }, now: T0 });
  assert.deepEqual(hits.map((h) => [h.id, h.rule]), [['aaaa1111', 'conns'], ['bbbb2222', 'ips'], ['cccc3333', 'overLimit']]);
  // cccc3333 在两次超限之间被解封过：只算解封之后的那一次
  const h2 = evaluateRules({ users: [{ id: 'cccc3333', unbanAt: T0 - 600e3 }], cfg, node, overHits: { cccc3333: [T0 - 3600e3, T0 - 60e3] }, now: T0 });
  assert.equal(h2.length, 0);
  assert.match(nodeAggSql('ds', 1700000000, 'aaaa1111'), /toUnixTimestamp\(timestamp\) > 1700000000 AND blob5 != 'sub' AND blob1 = 'aaaa1111'/);
});

test('设置：阶梯里写错的档去掉、检查间隔取 5 的倍数、阈值有范围', () => {
  const ab = normalizeSettings(settingsWith({ users: { autoBan: { ladder: ['30s', 'abc', '2h', '永久'], checkMinutes: 7, conns: { count: -5, hours: 99999 } } } })).users.autoBan;
  assert.deepEqual(ab.ladder, ['30s', '2h', '永久']);
  assert.equal(ab.checkMinutes, 5);
  assert.deepEqual([ab.conns.count, ab.conns.hours], [1, 720]);
  assert.equal(ab.enabled, false, '默认关闭');
});

function setup(autoBan) {
  return memKV({
    'nt.settings': settingsWith({ users: { enabled: true, autoBan } }),
    'nt.accounts': [{ id: 'n1', hosts: ['n1.com'], role: 'node', enabled: true, auth: { apiToken: 't'.repeat(40), accountId: HEX(1) } }],
    [MU_KEYS.users]: [{ id: 'aaaa1111', name: '', banned: false, createdAt: 1 }, { id: 'bbbb2222', name: '', banned: false, createdAt: 1 }],
    [MU_KEYS.secret]: SECRET,
    [MU_KEYS.accounts]: { n1: { nsId: 'ns1', bound: true, redeployed: true } },
  });
}

test('Cron 检查：查节点 AE → 触发的按阶梯封禁；两分钟内不重复；封禁结束前名单里没有他、到期自动回来', async () => {
  const kv = setup({ enabled: true, conns: { enabled: true, count: 1000, hours: 24 } });
  const sqls = [];
  const fetchFn = async (url, init = {}) => {
    if (String(url).endsWith('/analytics_engine/sql')) {
      sqls.push(init.body);
      // 单独查某个用户（封禁之后的数据）：没有新数据
      if (/blob1 = '/.test(init.body)) return new Response(JSON.stringify({ data: [] }));
      return new Response(JSON.stringify({ data: [{ u: 'aaaa1111', t: 'ip1', k: 'HKG', c: 5000 }, { u: 'bbbb2222', t: 'ip2', k: 'HKG', c: 10 }] }));
    }
    return new Response('{"success":true,"result":null}');
  };
  const run = async (now) => { resetStoreState(); const store = createStore({ kv, now: () => now }); const settings = await store.getSettings(); return { r: await runAutoBan({ store, settings, accounts: await store.getAccounts(), usage: null, fetchFn, now }), store, settings }; };
  const { r } = await run(T0);
  assert.deepEqual(r.banned.map((b) => b.id), ['aaaa1111']);
  assert.match(r.banned[0].reason, /24 小时内连接数 5000 ≥ 1000/);
  assert.equal(r.banned[0].until, T0 + 30e3, '第 1 次违规：30 秒');
  assert.ok(sqls[0].includes('toUnixTimestamp(timestamp) >'));
  let users = JSON.parse(kv.m.get(MU_KEYS.users));
  assert.equal(users[0].vio, 1);
  assert.deepEqual(buildState({ nodeKey: 'k'.repeat(64), users, settings: { users: { enabled: true } }, over: {}, now: T0 + 10e3 }).ids, ['bbbb2222']);
  assert.deepEqual(buildState({ nodeKey: 'k'.repeat(64), users, settings: { users: { enabled: true } }, over: {}, now: T0 + 31e3 }).ids, ['aaaa1111', 'bbbb2222'], '到期自动回到名单');
  // 一分钟后再检查：两分钟内刚封过，不重复累计
  const again = await run(T0 + 60e3);
  assert.equal(again.r.banned.length, 0);
  // 解封后：只算之后的数据（单独查，没有新数据）→ 不会立刻再被封
  const third = await run(T0 + 10 * 60e3);
  assert.equal(third.r.banned.length, 0);
  assert.ok(sqls.some((s) => /blob1 = 'aaaa1111'/.test(s)));
  users = JSON.parse(kv.m.get(MU_KEYS.users));
  assert.equal(users[0].vio, 1);
});

test('订阅：被封用户看到带时长的提示、客户端隔一段时间再来拉；被封用户也限速；主站绑了 NT_AE 时记订阅更新', async () => {
  const worker = (await import('../src/index.js')).default;
  const kv = memKV({ 'nt.settings': settingsWith({ users: { enabled: true }, sub: { rateLimitPerMinute: 3 } }), 'nt.accounts': [] });
  const points = [];
  const env = { KV: kv, ADMIN: 'pw', NT_AE: { writeDataPoint: (p) => points.push(p) } };
  const id = deriveIdentity(env, 'vp.example.com');
  const cookie = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt', 'Content-Type': 'application/json' };
  const call = (path, body) => worker.fetch(new Request('https://vp.example.com' + path, { method: 'POST', headers: cookie, body: JSON.stringify(body) }), env, { waitUntil() {} });
  globalThis.fetch = fakeFetch({});
  const made = await (await call('/admin/api/users/create', { count: 1 })).json();
  const u0 = made.created[0];
  const sub = (ip) => worker.fetch(new Request(u0.sub + '&target=clash', { headers: { 'User-Agent': 'clash-verge/v2', 'CF-Connecting-IP': ip } }), env, { waitUntil() {} });
  assert.equal((await sub('1.1.1.1')).status, 200);
  assert.equal(points.length, 1, '记了一条订阅更新');
  assert.deepEqual(points[0].blobs.slice(3), ['1', 'sub']);
  // 手动封禁 2 小时
  await call('/admin/api/users/update', { ids: [u0.id], banned: true, banHours: 2 });
  const b = await sub('2.2.2.2');
  const text = await b.text();
  assert.match(text, /此链接已停用，请联系管理员（\d\d-\d\d \d\d:\d\d 解封，剩余约 2 小时）/);
  assert.equal(b.headers.get('Profile-Update-Interval'), '2');
  // 限速：每分钟 3 次
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await sub('3.3.3.3')).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  // 解封后恢复
  await call('/admin/api/users/update', { ids: [u0.id], banned: false });
  resetStoreState();
  const ok = await sub('4.4.4.4');
  assert.ok(!(await ok.text()).includes('已停用'));
});

test('同步：下发的超限名单里新出现的用户记一次超限（"超过并行上限"规则用）', async () => {
  const { syncUsers } = await import('../src/control/users.js');
  const kv = setup({ enabled: true });
  kv.m.set('nt.settings', JSON.stringify(settingsWith({ users: { enabled: true, defaultLimit: 1, autoBan: { enabled: true } } })));
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const fetchFn = async (url) => (String(url).endsWith('/analytics_engine/sql')
    ? new Response(JSON.stringify({ data: [{ u: 'aaaa1111', t: 'tag1', f: iso(now - 200e3), l: iso(now) }, { u: 'aaaa1111', t: 'tag2', f: iso(now - 100e3), l: iso(now) }] }))
    : new Response('{"success":true,"result":null}'));
  const store = createStore({ kv });
  await syncUsers({ store, settings: await store.getSettings(), accounts: await store.getAccounts(), usage: null, fetchFn, now });
  const rec = JSON.parse(kv.m.get(MU_KEYS.sync));
  assert.deepEqual(rec.overHits, { aaaa1111: [now] });
});
