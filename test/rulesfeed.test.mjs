import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeList, assembleBlock, refreshRulesStep, loadRules, getRulesStatus, resetRulesState, RULES_KEYS, listHash } from '../src/control/rulesfeed.js';
import { parseIni } from '../src/control/sub/ini.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { memKV, fakeFetch, settingsWith } from './helpers.mjs';

beforeEach(() => { resetStoreState(); resetRulesState(); });

const INI_TEXT = [
  '[custom]',
  'ruleset=🎯 全球直连,https://r.test/direct.list',
  'ruleset=🛑 广告拦截,clash-domain:https://r.test/ads.yaml',
  'ruleset=🎯 全球直连,[]GEOIP,CN',
  'ruleset=🐟 漏网之鱼,[]FINAL',
  'custom_proxy_group=🚀 节点选择`select`.*',
  'custom_proxy_group=🎯 全球直连`select`[]DIRECT`[]🚀 节点选择',
  'custom_proxy_group=🛑 广告拦截`select`[]REJECT`[]DIRECT',
  'custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]DIRECT',
].join('\n');

test('normalizeList：classical / domain / ipcidr，过滤非法与不支持类型', () => {
  const n = normalizeList('# c\nDOMAIN-SUFFIX,qq.com\nIP-CIDR,1.0.0.0/8,no-resolve\nUSER-AGENT,MicroMessenger*\nDST-PORT,22\nAND,((DOMAIN,a))\nDOMAIN,bad: x\n');
  assert.equal(n.n, 4);
  assert.equal(n.clash, 'DOMAIN-SUFFIX,qq.com,__NT_G__\nIP-CIDR,1.0.0.0/8,__NT_G__,no-resolve\nDST-PORT,22,__NT_G__');
  assert.equal(n.surge, 'DOMAIN-SUFFIX,qq.com,__NT_G__\nIP-CIDR,1.0.0.0/8,__NT_G__,no-resolve\nUSER-AGENT,MicroMessenger*,__NT_G__\nDEST-PORT,22,__NT_G__');
  const sb = JSON.parse('[' + n.singbox + ']');
  assert.deepEqual(sb[0].domain_suffix, ['qq.com']);
  assert.deepEqual(sb[1].ip_cidr, ['1.0.0.0/8']);
  const d = normalizeList("payload:\n  - '+.ads.com'\n  - 'x.com'\n", 'domain');
  assert.equal(d.clash, 'DOMAIN-SUFFIX,ads.com,__NT_G__\nDOMAIN,x.com,__NT_G__');
  const ip = normalizeList('2001:db8::/32\n1.1.1.0/24', 'ipcidr');
  assert.equal(ip.clash, 'IP-CIDR6,2001:db8::/32,__NT_G__,no-resolve\nIP-CIDR,1.1.1.0/24,__NT_G__,no-resolve');
});

test('assembleBlock：provider 回退（lists=null）', () => {
  const ini = parseIni(INI_TEXT);
  const s = settingsWith();
  const c = assembleBlock(ini, 'clash', null, s);
  assert.equal(c.providers.length, 2);
  assert.equal(c.providers[1].behavior, 'domain');
  assert.equal(c.providers[1].format, 'yaml');
  assert.match(c.rules, /^RULE-SET,r0-\w{6},🎯 全球直连\nRULE-SET,r1-\w{6},🛑 广告拦截\nGEOIP,CN,🎯 全球直连\nMATCH,🐟 漏网之鱼$/);
  const su = assembleBlock(ini, 'surge', null, s);
  assert.equal(su.rules, 'RULE-SET,https://r.test/direct.list,🎯 全球直连\nDOMAIN-SET,https://r.test/ads.yaml,🛑 广告拦截\nGEOIP,CN,🎯 全球直连\nFINAL,🐟 漏网之鱼');
  const sb = assembleBlock(ini, 'singbox', null, s);
  assert.equal(sb.final, '🐟 漏网之鱼');
  assert.deepEqual(JSON.parse('[' + sb.rules + ']'), [{ rule_set: 'geoip-cn', outbound: '🎯 全球直连' }]);
});

test('refreshRulesStep：每步限量拉取，内容不变不重复写；块拼装后 loadRules 命中', async () => {
  const kv = memKV();
  const store = createStore({ kv });
  const s = settingsWith({ rules: { configUrl: 'https://r.test/ini', refreshHours: 24 } });
  const f = fakeFetch({
    'https://r.test/ini': INI_TEXT,
    'https://r.test/direct.list': 'DOMAIN-SUFFIX,cn\nIP-CIDR,10.0.0.0/8,no-resolve',
    'https://r.test/ads.yaml': "payload:\n  - '+.ad.com'",
  });
  const now = Date.UTC(2026, 9, 24);
  const r1 = await refreshRulesStep({ store, settings: s, fetchFn: f, now, maxLists: 2 });
  assert.deepEqual(r1.updated, ['https://r.test/ini', 'https://r.test/direct.list']);
  assert.equal(r1.pending, 1);
  assert.equal(r1.built, true);
  // 部分就绪：loadRules 返回 partial（未就绪列表走 RULE-SET provider）
  const ini = parseIni(INI_TEXT);
  let lr = await loadRules({ store, settings: s, fetchFn: f, now, format: 'clash' });
  assert.equal(lr.status, 'partial');
  assert.ok(lr.block.rules.includes('DOMAIN-SUFFIX,cn,🎯 全球直连'));
  assert.ok(lr.block.rules.includes('RULE-SET,r1-'));

  const r2 = await refreshRulesStep({ store, settings: s, fetchFn: f, now: now + 60e3, maxLists: 2 });
  assert.deepEqual(r2.updated, ['https://r.test/ads.yaml']);
  assert.equal(r2.pending, 0);
  store.invalidate();
  lr = await loadRules({ store, settings: s, fetchFn: f, now, format: 'clash' });
  assert.equal(lr.status, 'expand');
  assert.equal(lr.ini.hash, ini.hash);
  assert.equal(lr.block.providers.length, 0);
  assert.ok(lr.block.rules.includes('DOMAIN-SUFFIX,ad.com,🛑 广告拦截'));
  const sb = await loadRules({ store, settings: s, now, format: 'singbox' });
  const rules = JSON.parse('[' + sb.block.rules + ']');
  assert.ok(rules.some((x) => x.outbound === '🛑 广告拦截' && x.domain_suffix?.includes('ad.com')));
  assert.ok(rules.some((x) => x.outbound === '🎯 全球直连'));

  // 没有过期列表：不拉取、不写
  const w = kv.writes;
  const r3 = await refreshRulesStep({ store, settings: s, fetchFn: f, now: now + 120e3, maxLists: 3 });
  assert.deepEqual(r3.updated, []);
  assert.equal(r3.built, false);
  assert.equal(kv.writes, w);

  // 过期后重新拉取，内容未变：只更新索引（1 次写），不重写列表与块
  const r4 = await refreshRulesStep({ store, settings: s, fetchFn: f, now: now + 25 * 3600e3, maxLists: 1 });
  assert.deepEqual(r4.updated, []);
  assert.equal(r4.built, false);
  const st = await getRulesStatus({ store });
  assert.equal(st.lists.length, 2);
  assert.ok(st.lists.every((l) => l.ok));
  const direct = parseIni(INI_TEXT).rulesets.find((r) => r.source.value === 'https://r.test/direct.list');
  assert.ok(kv.m.has(RULES_KEYS.list(listHash('https://r.test/direct.list', direct.source.format))));
});

test('loadRules：无缓存时用内置 INI 并回退 provider，不写 KV；后台拉取 INI 到内存', async () => {
  const kv = memKV();
  const store = createStore({ kv });
  const s = settingsWith({ rules: { configUrl: 'https://r.test/ini' } });
  const f = fakeFetch({ 'https://r.test/ini': INI_TEXT });
  const pending = [];
  const r = await loadRules({ store, settings: s, fetchFn: f, now: 0, format: 'clash', waitUntil: (p) => pending.push(p) });
  assert.equal(r.status, 'provider-fallback');
  assert.ok(r.ini.groups.length > 0);
  await Promise.all(pending);
  const r2 = await loadRules({ store, settings: s, fetchFn: f, now: 0, format: 'clash' });
  assert.equal(r2.ini.hash, parseIni(INI_TEXT).hash);
  assert.equal(kv.writes, 0);
  const m = await loadRules({ store, settings: settingsWith({ rules: { mode: 'provider', configText: INI_TEXT } }), now: 0, format: 'surge' });
  assert.equal(m.status, 'provider');
});

test('块格式升级：旧版本拼装的块（没有 yaml 字段、旧签名）在下一次刷新时自动重建', async () => {
  const kv = memKV();
  const store = createStore({ kv });
  const s = settingsWith({ rules: { configUrl: 'https://r.test/ini', refreshHours: 24 } });
  const f = fakeFetch({ 'https://r.test/ini': 'ruleset=A,https://r.test/x.list\nruleset=A,[]FINAL\ncustom_proxy_group=A`select`.*', 'https://r.test/x.list': 'DOMAIN-SUFFIX,cn' });
  const now = Date.UTC(2026, 9, 25);
  const first = await refreshRulesStep({ store, settings: s, fetchFn: f, now, maxLists: 3 });
  assert.equal(first.built, true);
  const again = await refreshRulesStep({ store, settings: s, fetchFn: f, now: now + 60e3, maxLists: 3 });
  assert.equal(again.built, false, '没有变化不重建');
  // 模拟旧版本留下的状态：索引里记录的签名是旧格式（没有 f<版本> 后缀），块里没有 yaml
  const index = JSON.parse(kv.m.get(RULES_KEYS.index));
  for (const k of Object.keys(index.built)) index.built[k] = index.built[k].replace(/f\d+$/, '');
  kv.m.set(RULES_KEYS.index, JSON.stringify(index));
  const blockKey = [...kv.m.keys()].find((k) => k.startsWith('nt.rules.clash.'));
  const old = JSON.parse(kv.m.get(blockKey)); delete old.yaml; kv.m.set(blockKey, JSON.stringify(old));
  store.invalidate();
  const up = await refreshRulesStep({ store, settings: s, fetchFn: f, now: now + 120e3, maxLists: 3 });
  assert.equal(up.built, true, '签名不同 → 自动重建');
  assert.ok(JSON.parse(kv.m.get(blockKey)).yaml.startsWith('  - '), '新块带预缩进 yaml');
});
