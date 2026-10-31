// 转换配置（INI）获取并保存 + 订阅热路径的 KV 读写量
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { fetchAndSaveIni, loadRules, refreshRulesStep, getRulesStatus, resetRulesState, RULES_KEYS } from '../src/control/rulesfeed.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { memKV, fakeFetch, settingsWith } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetRulesState(); });
afterEach(() => { globalThis.fetch = realFetch; });

const INI = 'custom_proxy_group=A`select`.*\nruleset=A,[]FINAL\nruleset=A,https://r.test/x.list';
const URL1 = 'https://r.test/sub.ini';

test('获取并保存：写入 KV；内容不变不再写；不像 INI 的内容被拒绝', async () => {
  const kv = memKV();
  const store = createStore({ kv });
  const s = settingsWith({ rules: { configUrl: URL1 } });
  const f = fakeFetch({ [URL1]: INI });
  const r1 = await fetchAndSaveIni({ store, settings: s, fetchFn: f, now: 1000 });
  assert.deepEqual([r1.ok, r1.changed, r1.groups, r1.rulesets], [true, true, 1, 2]);
  assert.equal(JSON.parse(kv.m.get(RULES_KEYS.ini)).text, INI);
  const w = kv.writes;
  const r2 = await fetchAndSaveIni({ store, settings: s, fetchFn: f, now: 2000 });
  assert.deepEqual([r2.ok, r2.changed], [true, false]);
  assert.equal(kv.writes, w, '内容不变不写 KV');
  const bad = await fetchAndSaveIni({ store, settings: s, fetchFn: fakeFetch({ [URL1]: '<html>404</html>' }), now: 3000 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不像是转换配置/);
  assert.equal(JSON.parse(kv.m.get(RULES_KEYS.ini)).text, INI, '拒绝时保留原有缓存');
  assert.match((await fetchAndSaveIni({ store, settings: settingsWith({ rules: { configUrl: '' } }), fetchFn: f })).error, /请先填写/);
  assert.match((await fetchAndSaveIni({ store, settings: s, fetchFn: fakeFetch({}) })).error, /获取失败/);
  const st = await getRulesStatus({ store });
  assert.deepEqual([st.ini.url, st.ini.groups, st.ini.rulesets], [URL1, 1, 2]);
});

test('保存后：订阅热路径只读缓存，冷启动的新实例也不连远程', async () => {
  const kv = memKV();
  const s = settingsWith({ rules: { configUrl: URL1 } });
  await fetchAndSaveIni({ store: createStore({ kv }), settings: s, fetchFn: fakeFetch({ [URL1]: INI }), now: 0 });
  resetStoreState(); resetRulesState(); // 模拟全新的 isolate
  const f = fakeFetch({});
  const store = createStore({ kv });
  const r = await loadRules({ store, settings: s, fetchFn: f, now: 1e9, format: 'clash' });
  assert.equal(f.calls.length, 0, '没有任何远程请求');
  assert.equal(r.ini.groups.length, 1);
  assert.equal(kv.writes, 1, '读缓存不产生任何写入（只有保存时那 1 次）');
});

test('iniAutoRefresh=false：过期后 Cron 也不再自动拉取 INI；开启时才拉取', async () => {
  const kv = memKV();
  const store = createStore({ kv });
  const base = { rules: { configUrl: URL1, refreshHours: 1 } };
  const f = fakeFetch({ [URL1]: INI, 'https://r.test/x.list': 'DOMAIN,a.com' });
  await fetchAndSaveIni({ store, settings: settingsWith(base), fetchFn: f, now: 0 });
  f.calls.length = 0;
  await refreshRulesStep({ store, settings: settingsWith({ rules: { ...base.rules, iniAutoRefresh: false } }), fetchFn: f, now: 5 * 3600e3, maxLists: 3 });
  assert.ok(!f.calls.includes(URL1), '关闭自动更新：不再拉 INI');
  await refreshRulesStep({ store, settings: settingsWith({ rules: { ...base.rules, iniAutoRefresh: true } }), fetchFn: f, now: 5 * 3600e3, maxLists: 3 });
  assert.ok(f.calls.includes(URL1), '开启自动更新：过期后重新拉取');
});

const ADMIN = { ADMIN: 'pw', KEY: 'k' };
test('后台接口 POST /admin/api/rules/ini/fetch：获取、保存并重建规则块', async () => {
  const kv = memKV({ 'nt.settings': { schema: 2, rules: { configUrl: URL1 } } });
  const env = { KV: kv, ...ADMIN };
  const id = deriveIdentity(env, 'vp.example.com');
  globalThis.fetch = fakeFetch({ [URL1]: INI, 'https://r.test/x.list': 'DOMAIN-SUFFIX,cn' });
  const h = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id), 'X-Requested-With': 'nt', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const call = (path, body) => worker.fetch(new Request('https://vp.example.com/admin/api/' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }), env, { waitUntil() {} });
  const res = await (await call('rules/ini/fetch')).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual([res.changed, res.groups, res.rulesets], [true, 1, 2]);
  assert.equal(res.rules.updated.length > 0, true);
  assert.ok([...kv.m.keys()].some((k) => k.startsWith('nt.rules.clash.')), '规则块已重建');
  const again = await call('rules/ini/fetch');
  assert.equal(again.status, 429, '10 秒内重复点击被限频');
  const state = await (await worker.fetch(new Request('https://vp.example.com/admin/api/state', { headers: h }), env, { waitUntil() {} })).json();
  assert.equal(state.rules.ini.groups, 1);
});

test('KV 用量实测：300 次订阅请求（单实例）与 30 个冷启动实例', async () => {
  const accts = Array.from({ length: 20 }, (_, i) => ({ id: 'a' + i, name: 'n' + i, hosts: [`vp${i}.ex.com`], role: 'node', enabled: true, auth: { accountId: (i + 1).toString(16).padStart(32, '0'), apiToken: 't' } }));
  const kv = memKV({
    'nt.settings': { schema: 2, preferred: { custom: { text: '1.1.1.1#日本-住宅-01' }, random: { count: 10 } }, rules: { configUrl: URL1 } },
    'nt.accounts': accts,
    'nt.usage': { v: 1, ts: Date.now(), day: new Date().toISOString().slice(0, 10), cursor: 0, accounts: {} },
    'nt.cidr.ct': '104.16.0.0/13',
    [RULES_KEYS.ini]: { url: URL1, text: INI, fetchedAt: Date.now() },
  });
  const env = { KV: kv, ...ADMIN };
  const id = deriveIdentity(env, 'vp.example.com');
  const f = fakeFetch({});
  globalThis.fetch = f;
  const sub = (i, ua) => worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken, { headers: { 'User-Agent': ua, 'CF-Connecting-IP': `10.0.${i % 250}.1` } }), env, { waitUntil() {} });
  await (await sub(0, 'clash-verge')).text();
  const warm = kv.reads;
  for (let i = 1; i <= 300; i++) await (await sub(i, 'clash-verge')).text();
  const perThousand = ((kv.reads - warm) / 300) * 1000;
  // 同一实例内：缓存命中，几乎不再读 KV；也从不写
  assert.ok(kv.reads - warm <= 12, `300 次请求只多读了 ${kv.reads - warm} 次 KV`);
  assert.equal(kv.writes, 0);
  assert.equal(f.calls.filter((u) => u.includes('r.test/sub.ini')).length, 0, '订阅不连远程 INI');
  console.log(`  [实测] 冷启动一次读 KV ${warm} 次；之后 300 次请求额外读 ${kv.reads - warm} 次（约 ${perThousand.toFixed(1)} 次/千请求）`);
  // 每个新实例冷启动的读取量（上限）
  let max = 0;
  for (let n = 0; n < 30; n++) {
    resetStoreState(); resetPipelineState(); resetRulesState();
    const before = kv.reads;
    await (await sub(1000 + n, 'clash-verge')).text();
    max = Math.max(max, kv.reads - before);
  }
  assert.ok(max <= 10, `冷启动单实例读 KV ${max} 次`);
  console.log(`  [实测] 新实例冷启动最多读 KV ${max} 次`);
});
