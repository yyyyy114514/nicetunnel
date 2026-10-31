import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBest, refreshBest, loadBest, bestIspKeys, resetBestState, bestKey } from '../src/control/bestfeed.js';
import { evolveRandomPool, buildRandomNodes } from '../src/control/pool.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { maintenanceTask } from '../src/control/cron.js';
import { memKV, fakeFetch, settingsWith } from './helpers.mjs';

beforeEach(() => { resetStoreState(); resetBestState(); });

const bestSettings = (urls, extra = {}) => settingsWith({ preferred: { best: { enabled: true, urls, maxPerUrl: 3, maxNodes: 10, refreshSeconds: 600, ...extra } } });

test('多个优选 URL 合并、去重、按 maxPerUrl 截断，{isp} 按运营商替换', async () => {
  const f = fakeFetch({
    'https://a.test/ct.txt': '1.1.1.1:443#A\n1.1.1.2:443#B\n1.1.1.3:443#C\n1.1.1.4:443#D',
    'https://b.test/cf.txt': '1.1.1.1:443#dup\n2.2.2.2:2053#E',
  });
  const s = bestSettings(['https://a.test/{isp}.txt', 'https://b.test/cf.txt']);
  assert.deepEqual(bestIspKeys(s), ['cf', 'ct', 'cu', 'cmcc']);
  const r = await fetchBest({ settings: s, isp: 'ct', fetchFn: f });
  const addrs = r.entries.map((e) => e.address + ':' + e.port);
  assert.deepEqual(addrs, ['1.1.1.1:443', '1.1.1.2:443', '1.1.1.3:443', '2.2.2.2:2053']);
  assert.ok(f.calls.includes('https://a.test/ct.txt'));
  // 一个 URL 失败不影响其他
  const r2 = await fetchBest({ settings: bestSettings(['https://bad.test/x', 'https://b.test/cf.txt']), isp: 'cf', fetchFn: f });
  assert.equal(r2.entries.length, 2);
  assert.equal(r2.errors.length, 1);
});

test('refreshBest 内容不变不重复写 KV；loadBest 热路径只读，KV 缺失时后台拉取', async () => {
  const kv = memKV();
  const store = createStore({ kv });
  const f = fakeFetch({ 'https://b.test/': '9.9.9.9:443#X\n8.8.8.8:8443#Y' });
  const s = bestSettings(['https://b.test/a.txt']);
  assert.deepEqual(bestIspKeys(s), ['all']);
  const pending = [];
  const first = await loadBest({ store, settings: s, isp: 'ct', fetchFn: f, now: 0, waitUntil: (p) => pending.push(p) });
  assert.equal(first.source, 'none');
  await Promise.all(pending);
  assert.equal((await loadBest({ store, settings: s, isp: 'ct', fetchFn: f, now: 1000 })).entries.length, 2);
  assert.equal(kv.writes, 0);
  resetBestState();
  const r1 = await refreshBest({ store, settings: s, isp: 'all', fetchFn: f, now: 5000 });
  assert.equal(r1.changed, true);
  const w = kv.writes;
  const r2 = await refreshBest({ store, settings: s, isp: 'all', fetchFn: f, now: 9000 });
  assert.equal(r2.changed, false);
  assert.equal(kv.writes, w);
  assert.ok(kv.m.has(bestKey('all')));
  resetBestState();
  assert.equal((await loadBest({ store, settings: s, isp: 'cu', fetchFn: f, now: 10000 })).source, 'kv');
  assert.deepEqual((await refreshBest({ store, settings: settingsWith(), isp: 'all', fetchFn: f })).skipped, '未启用优选订阅');
});

test('Cron 轮转：启用优选订阅后出现 best 任务', () => {
  const s = bestSettings(['https://a.test/{isp}.txt']);
  const kinds = Array.from({ length: 16 }, (_, i) => maintenanceTask(i * 5 * 60e3, s));
  assert.ok(kinds.some((k) => k.kind === 'best'));
  assert.deepEqual([...new Set(kinds.filter((k) => k.kind === 'best').map((k) => k.isp))].sort(), ['cf', 'cmcc', 'ct', 'cu']);
  assert.ok(!Array.from({ length: 8 }, (_, i) => maintenanceTask(i * 5 * 60e3, settingsWith())).some((k) => k.kind === 'best'));
});

const CIDRS = ['104.16.0.0/13', '172.64.0.0/13', '162.158.0.0/15'];

test('随机池：不同 /24、443 倾向、已知可用地址占比、确定性', () => {
  const s = settingsWith({ preferred: { random: { count: 20, portBias: 0.7, goodRatio: 0.5 } } });
  const good = Array.from({ length: 30 }, (_, i) => ({ ip: `141.101.${i}.7`, port: 443 }));
  const now = Date.UTC(2026, 9, 24, 8);
  const pool = evolveRandomPool({ cidrs: CIDRS, settings: s, isp: 'ct', now, good });
  assert.equal(pool.length, 20);
  assert.equal(new Set(pool.map((p) => p.ip.slice(0, p.ip.lastIndexOf('.')))).size, 20, '每个节点不同 /24');
  assert.equal(pool.filter((p) => p.ip.startsWith('141.101.')).length, 10, '一半来自已知可用地址');
  assert.ok(pool.filter((p) => p.port === 443).length >= 11);
  assert.deepEqual(pool, evolveRandomPool({ cidrs: CIDRS, settings: s, isp: 'ct', now, good }), '确定性');
  // 没有优选数据时全部来自 CIDR
  const none = evolveRandomPool({ cidrs: CIDRS, settings: s, isp: 'ct', now });
  assert.equal(none.filter((p) => p.ip.startsWith('141.101.')).length, 0);
});

test('随机池：渐进轮换时 slot 名字稳定、已知可用地址不抖动', () => {
  const s = settingsWith({ preferred: { random: { count: 12, stable: { rotatePercent: 25, windowMinutes: 60 } } } });
  const good = Array.from({ length: 40 }, (_, i) => ({ ip: `141.101.${i}.7`, port: 443 }));
  const t = Date.UTC(2026, 9, 24, 8);
  const a = buildRandomNodes({ settings: s, cidrs: CIDRS, isp: 'ct', now: t, good });
  const b = buildRandomNodes({ settings: s, cidrs: CIDRS, isp: 'ct', now: t + 3600e3, good });
  assert.deepEqual(a.map((n) => n.name), b.map((n) => n.name));
  const same = a.filter((n, i) => n.address === b[i].address).length;
  assert.ok(same >= 6 && same < 12, `保持 ${same}/12`);
});
