// Workers Paid 适配：只在主后台设置；地区条目只分给付费域名（主站 / 付费账号），普通节点照常走免费号
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { resetRulesState } from '../src/control/rulesfeed.js';
import { deriveIdentity } from '../src/control/identity.js';
import { normalizeSettings } from '../src/control/settings.js';
import { normalizeAccounts, publicAccounts, mergeAccounts } from '../src/control/accounts.js';
import { effectiveRemaining, buildPaidRegionPool } from '../src/control/allocator.js';
import { selectBatch, subrequestBudget, MAX_SUBREQUESTS, MAX_SUBREQUESTS_PAID } from '../src/control/usage.js';
import { selfCheck } from '../src/control/selfcheck.js';
import { adminHtml } from '../src/admin/ui.js';
import { memKV, fakeFetch, settingsWith } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetRulesState(); });
afterEach(() => { globalThis.fetch = realFetch; });

const LIST = '1.1.1.1:443#日本-住宅-01$sstp://vpn:vpn@a1.opengw.net:443\n1.1.1.1:443#韩国-住宅-01$sstp://vpn:vpn@k1.opengw.net:443';

test('设置：paid 默认值与清洗', () => {
  const d = normalizeSettings({});
  assert.deepEqual(d.paid, { main: false, regionOnly: true, mainHosts: [], dailyBudget: 330000 });
  const s = normalizeSettings({ paid: { main: true, mainHosts: 'https://Main.Example.com/ , b.com', dailyBudget: 5 } });
  assert.equal(s.paid.main, true);
  assert.deepEqual(s.paid.mainHosts, ['main.example.com', 'b.com']);
  assert.equal(s.paid.dailyBudget, 1000, '下限 1000');
});

test('账号：paid 字段保存、公开、批量导入合并时保留', () => {
  const [a] = normalizeAccounts([{ id: 'n1', hosts: ['a.com'], paid: true }]);
  assert.equal(a.paid, true);
  assert.equal(publicAccounts([a])[0].paid, true);
  assert.equal(normalizeAccounts([{ hosts: ['b.com'] }])[0].paid, false);
  const merged = mergeAccounts([a], [{ hosts: ['a.com'], auth: { apiToken: 't'.repeat(40) } }], { mode: 'merge' });
  assert.equal(merged[0].paid, true, '导入不覆盖手工勾选的付费');
});

test('额度：付费账号按付费预算估算，账号自填额度优先', () => {
  const s = settingsWith({});
  assert.equal(effectiveRemaining({ paid: true }, null, s, 0).limit, 330000);
  assert.equal(effectiveRemaining({ paid: true, limit: 2e6 }, null, s, 0).limit, 2e6);
  assert.equal(effectiveRemaining({}, null, s, 0).limit, 100000);
});

test('付费池：主站域名 + 付费账号；检测为不可达的排除；没开就为空', () => {
  const accounts = normalizeAccounts([
    { id: 'p', hosts: ['paid.example.com'], paid: true },
    { id: 'f', hosts: ['free.example.com'] },
  ]);
  const base = settingsWith({});
  assert.deepEqual(buildPaidRegionPool({ settings: settingsWith({}), accounts: [accounts[1]], now: 0, mainHost: 'main.example.com' }), []);
  const pool = buildPaidRegionPool({ settings: settingsWith({ paid: { main: true } }), accounts, now: 0, mainHost: 'main.example.com' });
  assert.deepEqual(pool.map((h) => h.host).sort(), ['main.example.com', 'paid.example.com']);
  assert.ok(pool.every((h) => h.paid && h.weight > 0));
  const checks = { hosts: { 'paid.example.com': { s: 'down', at: 0 } } };
  const p2 = buildPaidRegionPool({ settings: settingsWith({ paid: { main: true, mainHosts: ['m2.example.com'] } }), accounts, now: 1000, mainHost: 'main.example.com', checks });
  assert.deepEqual(p2.map((h) => h.host), ['m2.example.com'], '指定了主站域名就用指定的；不可达的付费账号被排除');
  void base;
});

async function subLines(settings) {
  const kv = memKV({ 'nt.settings': { schema: 4, rules: { configText: '', configUrl: '' }, ...settings }, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pass123', KEY: 'mykey' };
  const id = deriveIdentity(env, 'vp.example.com');
  globalThis.fetch = fakeFetch({ 'https://list.test/': LIST });
  const tasks = [];
  const res = await worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken, { headers: { 'User-Agent': 'v2rayN/6', 'CF-Connecting-IP': '1.2.3.4' } }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.allSettled(tasks);
  return new TextDecoder().decode(Uint8Array.from(atob(await res.text()), (c) => c.charCodeAt(0))).split('\n').filter(Boolean);
}
const hostOf = (l) => decodeURIComponent((l.match(/[?&]host=([^&#]+)/) || [])[1] || '');
const isRegion = (l) => /path=%2Fvideo%2F/i.test(l) || /path=\/video\//.test(l);

test('订阅：主号付费 → 地区条目全部走主站域名，普通节点仍走免费节点', async () => {
  const lines = await subLines({
    preferred: { custom: { enabled: false }, random: { enabled: true, count: 4 }, regions: { enabled: true, urls: ['https://list.test/l.txt'] } },
    hosts: { unmanaged: ['vp2.example.com', 'vp3.example.com'] },
    paid: { main: true },
  });
  const region = lines.filter(isRegion), normal = lines.filter((l) => !isRegion(l));
  assert.ok(region.length >= 2 && normal.length >= 4, lines.join('\n'));
  assert.ok(region.every((l) => hostOf(l) === 'vp.example.com'), '地区条目走主站：' + region.map(hostOf));
  assert.ok(normal.every((l) => /^vp[23]\.example\.com$/.test(hostOf(l))), '普通节点不占主站：' + normal.map(hostOf));
});

test('订阅：没开付费 / 关闭"只给付费"时，地区条目照旧分给全部节点', async () => {
  for (const paid of [{ main: false }, { main: true, regionOnly: false }]) {
    resetPipelineState(); resetStoreState();
    const lines = await subLines({
      preferred: { custom: { enabled: false }, random: { enabled: true, count: 2 }, regions: { enabled: true, urls: ['https://list.test/l.txt'] } },
      hosts: { unmanaged: ['vp2.example.com', 'vp3.example.com'] },
      paid,
    });
    assert.ok(lines.filter(isRegion).every((l) => /^vp[23]\.example\.com$/.test(hostOf(l))), JSON.stringify(paid));
  }
});

test('轮询：主号付费时一批的子请求预算放大', () => {
  assert.equal(subrequestBudget(settingsWith({})), MAX_SUBREQUESTS);
  assert.equal(subrequestBudget(settingsWith({ paid: { main: true } })), MAX_SUBREQUESTS_PAID);
  const accs = normalizeAccounts(Array.from({ length: 120 }, (_, i) => ({ id: 'a' + i, hosts: [`h${i}.com`], auth: { apiToken: 't'.repeat(40), accountId: 'a'.repeat(32) } })));
  assert.equal(selectBatch(accs, null, { batchSize: 200, now: 0 }).length, MAX_SUBREQUESTS);
  assert.equal(selectBatch(accs, null, { batchSize: 200, now: 0, maxSubrequests: MAX_SUBREQUESTS_PAID }).length, 120);
});

test('自检：开了地区路由但没有付费域名 → 提示 CPU 限制；主号付费 → 说明地区条目去向', () => {
  const regions = { preferred: { regions: { enabled: true, urls: ['https://l'] } } };
  const accounts = normalizeAccounts([{ id: 'n', hosts: ['n.com'] }]);
  const ids = (s) => selfCheck({ settings: settingsWith(s), accounts, usage: null, host: 'main.com', now: 0, kvBound: true }).map((c) => c.id);
  assert.ok(ids(regions).includes('region-free-cpu'));
  const paid = ids({ ...regions, paid: { main: true } });
  assert.ok(paid.includes('paid-region') && paid.includes('paid-main-host') && !paid.includes('region-free-cpu'));
  assert.ok(ids({ paid: { main: true } }).includes('paid-no-region'));
});

test('后台：账号表有付费列；账号页有 Workers Paid 设置；检测节点包含主站域名', () => {
  const js = adminHtml({}).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('data-k="paid"'));
  for (const p of ['paid.main', 'paid.regionOnly', 'paid.mainHosts', 'paid.dailyBudget']) assert.ok(js.includes(`'${p}'`), p);
  assert.ok(js.includes('const paidMain = S.settings.paid?.main'));
});
