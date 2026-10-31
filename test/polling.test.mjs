// 轮询覆盖与额度节奏分配
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, resetStoreState } from '../src/control/store.js';
import { resetPipelineState, pollAndPersist } from '../src/control/pipeline.js';
import { autoBatchSize } from '../src/control/usage.js';
import { mergeSnapshots } from '../src/control/usage-core.js';
import { buildHostPool, allocateHosts, paceFactor, makeSeed } from '../src/control/allocator.js';
import { normalizeAccounts } from '../src/control/accounts.js';
import { memKV, settingsWith } from './helpers.mjs';

beforeEach(() => { resetStoreState(); resetPipelineState(); });

const HEX = (i) => i.toString(16).padStart(32, '0');
function accounts(n) {
  return normalizeAccounts(Array.from({ length: n }, (_, i) => ({ id: 'a' + i, name: 'n' + i, hosts: [`vp${i}.ex.com`], role: 'node', enabled: true, auth: { accountId: HEX(i + 1), apiToken: 'tok' + i } })));
}
/** 假 CF GraphQL：每个账号用量 = 序号×100 */
function cfFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const id = parseInt(body.variables.AccountID, 16) - 1;
    calls.push(id);
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [], workersInvocationsAdaptive: [{ sum: { requests: id * 100 } }] }] } } }));
  };
}

test('autoBatchSize：按周期放大批大小，受子请求预算封顶', () => {
  const cfg = { batchSize: 5, cycleMinutes: 15 };
  assert.equal(autoBatchSize(accounts(30), cfg, 5), 10);
  assert.equal(autoBatchSize(accounts(6), cfg, 5), 5);
  assert.equal(autoBatchSize(accounts(300), cfg, 5), 45);
  assert.equal(autoBatchSize(accounts(30), cfg, 0), 5);
});

test('Cron 跨 isolate：30 个号在 cycleMinutes(15) 内全部轮询到，且结果落盘', async () => {
  const kv = memKV();
  const s = settingsWith({ usage: { batchSize: 5, cycleMinutes: 15, minWriteIntervalMinutes: 10 } });
  const accs = accounts(30);
  const calls = [];
  const t0 = Date.UTC(2026, 9, 24, 3);
  for (let tick = 0; tick < 3; tick++) {
    // 每次 Cron 都可能落在新 isolate：清空进程内缓存
    if (tick % 2 === 1) resetStoreState();
    const store = createStore({ kv, now: () => t0 + tick * 5 * 60e3 });
    await pollAndPersist({ store, settings: s, accounts: accs, now: t0 + tick * 5 * 60e3, fetchFn: cfFetch(calls), tickMinutes: 5 });
  }
  assert.equal(new Set(calls).size, 30, `只轮询到 ${new Set(calls).size} 个号`);
  // 再来一个冷 isolate：读到的快照里所有号都有数据
  resetStoreState();
  const snap = await createStore({ kv, now: () => t0 + 16 * 60e3 }).getUsage();
  assert.equal(Object.values(snap.accounts).filter((u) => u.polledAt > 0).length, 30);
});

test('热 isolate 不会因为"内存快照刚更新"而永远不落盘', async () => {
  const kv = memKV();
  const s = settingsWith({ usage: { batchSize: 3, cycleMinutes: 60, minWriteIntervalMinutes: 10 } });
  const accs = accounts(12);
  const calls = [];
  const t0 = Date.UTC(2026, 9, 24, 3);
  let writes = 0;
  for (let tick = 0; tick < 6; tick++) {
    const now = t0 + tick * 5 * 60e3;
    const r = await pollAndPersist({ store: createStore({ kv, now: () => now }), settings: s, accounts: accs, now, fetchFn: cfFetch(calls), tickMinutes: 5 });
    if (r.persisted) writes++;
  }
  assert.ok(writes >= 3, `30 分钟内只写了 ${writes} 次`);
  resetStoreState();
  const snap = await createStore({ kv, now: () => t0 + 30 * 60e3 }).getUsage();
  assert.equal(Object.values(snap.accounts).filter((u) => u.polledAt > 0).length, 12);
});

test('mergeSnapshots：逐账号取较新结果，跨日取新日', () => {
  const a = { v: 1, ts: 10, day: '2026-10-24', accounts: { x: { triedAt: 5, used: 1 }, y: { triedAt: 9, used: 9 } } };
  const b = { v: 1, ts: 20, day: '2026-10-24', accounts: { x: { triedAt: 7, used: 2 }, y: { triedAt: 3, used: 3 }, z: { triedAt: 1 } } };
  const m = mergeSnapshots(a, b);
  assert.deepEqual([m.accounts.x.used, m.accounts.y.used, !!m.accounts.z, m.ts], [2, 9, true, 20]);
  assert.equal(mergeSnapshots(a, { ...b, day: '2026-10-25' }).day, '2026-10-25');
});

test('paceFactor：会剩额度的号加权、会提前耗尽的号降权', () => {
  const now = Date.UTC(2026, 9, 24, 12); // 距重置 720 分钟
  assert.equal(paceFactor({ rate: 0, remaining: 50000 }, now, 4), 4);
  assert.equal(paceFactor({ rate: 100, remaining: 72000 }, now, 4), 1000 / 1000 * (72000 / 72000));
  assert.ok(paceFactor({ rate: 200, remaining: 36000 }, now, 4) < 0.3);
  assert.equal(paceFactor({ rate: 10, remaining: 80000 }, now, 4), 4);
});

test('节奏分配：消耗快的号份额下降，闲置号份额上升（同样剩余额度）', () => {
  const now = Date.UTC(2026, 9, 24, 12);
  const accs = accounts(4);
  const mk = (rate) => ({ used: 40000, workers: 40000, pages: 0, rate, polledAt: now - 60e3, triedAt: now - 60e3, ok: true });
  const snapshot = { v: 1, ts: now, day: '2026-10-24', accounts: { a0: mk(300), a1: mk(60), a2: mk(60), a3: mk(5) } };
  const s = settingsWith({ allocation: { maxShare: 1 } });
  const pool = buildHostPool({ settings: s, accounts: accs, snapshot, now });
  const count = Object.fromEntries(pool.map((h) => [h.host, 0]));
  const slots = Array.from({ length: 20 }, (_, i) => 's' + i);
  for (let c = 0; c < 400; c++) {
    const hosts = allocateHosts({ pool, slotIds: slots, settings: s, seed: makeSeed({ mode: 'ip', ip: `10.${c >> 8}.${c & 255}.1`, now, windowMinutes: 30 }) });
    for (const h of hosts) count[h]++;
  }
  assert.ok(count['vp0.ex.com'] < count['vp1.ex.com'] / 3, JSON.stringify(count));
  assert.ok(count['vp3.ex.com'] > count['vp1.ex.com'], JSON.stringify(count));
  // 关闭节奏后退化为按剩余额度等权
  const flat = buildHostPool({ settings: settingsWith({ allocation: { pace: false } }), accounts: accs, snapshot, now });
  const w = flat.map((h) => h.weight);
  assert.ok(Math.max(...w) / Math.min(...w) < 1.5);
});
