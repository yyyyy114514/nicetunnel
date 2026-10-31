import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, resetStoreState, KEYS } from '../src/control/store.js';
import { SCHEMA_VERSION } from '../src/control/settings.js';

export function memKV(init = {}) {
  const m = new Map(Object.entries(init));
  const kv = {
    reads: 0, writes: 0, m,
    async get(k, opt) { kv.reads++; const v = m.get(k); if (v == null) return null; return opt?.type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { kv.writes++; m.set(k, String(v)); },
  };
  return kv;
}

beforeEach(() => resetStoreState());

test('首次运行：无旧配置 → 写入默认设置一次，之后命中内存缓存', async () => {
  const kv = memKV();
  let t = 1_700_000_000_000;
  const store = createStore({ kv, now: () => t });
  const s = await store.getSettings();
  assert.equal(s.schema, SCHEMA_VERSION);
  assert.ok(kv.m.has(KEYS.settings));
  const reads = kv.reads;
  await store.getSettings();
  assert.equal(kv.reads, reads, '30 秒内不再读 KV');
  t += 31e3;
  await store.getSettings();
  assert.equal(kv.reads, reads + 1);
});

test('从 edgetunnel 迁移 config.json / tg.json / ADD.txt / cf.json', async () => {
  const kv = memKV({
    'config.json': JSON.stringify({ HOSTS: ['vp2.example.com'], 协议类型: 'vless', PATH: '/x', ECH: true, ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' } }),
    'tg.json': JSON.stringify({ BotToken: '123:abc', ChatID: '42' }),
    'ADD.txt': '1.1.1.1:443#a',
    'cf.json': JSON.stringify({ AccountID: 'a'.repeat(32), APIToken: 'tok' }),
  });
  const store = createStore({ kv });
  const s = await store.getSettings();
  assert.deepEqual(s.hosts.unmanaged, ['vp2.example.com']);
  assert.equal(s.node.ech.enabled, true);
  assert.equal(s.notify.telegram.botToken, '123:abc');
  assert.equal(s.preferred.custom.text, '1.1.1.1:443#a');
  const acc = await store.getAccounts();
  assert.equal(acc.length, 1);
  assert.equal(acc[0].role, 'main');
  assert.ok(kv.m.has('config.json'), '旧键保留');
});

test('saveUsage 限频与计数', async () => {
  const kv = memKV();
  let t = 1_700_000_000_000;
  const store = createStore({ kv, now: () => t });
  assert.equal(await store.saveUsage({ v: 1 }, { minIntervalMs: 60e3 }), true);
  t += 10e3;
  assert.equal(await store.saveUsage({ v: 2 }, { minIntervalMs: 60e3 }), false);
  assert.deepEqual(await store.getUsage(), { v: 2 }, '未写入时内存仍是最新值');
  assert.equal(await store.saveUsage({ v: 3 }, { force: true }), true);
  assert.equal(store.writesToday(), 2);
});

test('日志缓冲批量写入并截断', async () => {
  const kv = memKV();
  let t = 1_700_000_000_000;
  const store = createStore({ kv, now: () => t });
  for (let i = 0; i < 10; i++) store.appendLog({ t, i });
  assert.equal(await store.flushLogs({ flushMinutes: 5 }), true, '首次可写');
  store.appendLog({ i: 10 });
  assert.equal(await store.flushLogs({ flushMinutes: 5 }), false, '5 分钟内不写');
  assert.equal((await store.getLogs()).length, 11, '读取包含未落盘缓冲');
  t += 6 * 60e3;
  assert.equal(await store.flushLogs({ flushMinutes: 5, maxEntries: 5 }), true);
  assert.equal(JSON.parse(kv.m.get(KEYS.log)).length, 5);
});

test('无 KV 时返回默认设置且不抛错', async () => {
  const store = createStore({ kv: undefined });
  assert.equal(store.kvBound, false);
  const s = await store.getSettings();
  assert.equal(s.schema, SCHEMA_VERSION);
  assert.deepEqual(await store.getAccounts(), []);
});
