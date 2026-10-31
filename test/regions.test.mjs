import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseNodeList, extractRegion, DEFAULT_REGION_RE } from '../src/lib/pool-parse.js';
import { loadRegionStructure, buildRegionSpecs, newRegionCache } from '../src/control/regions.js';
import { resolvePoolRoute, resetPoolRouteState, pick, ipKey, reportChainResult, rankCandidates, buildPoolPath } from '../src/dataplane/pool-route.js';
import { base64SecretDecode } from '../src/dataplane/edt-core.js';
import { settingsWith, fakeFetch, UUID } from './helpers.mjs';

beforeEach(() => resetPoolRouteState());

const LIST = [
  '1.1.1.1:443#日本-住宅-01$sstp://vpn:vpn@a1.opengw.net:1001',
  '1.1.1.1:443#日本-住宅-02$sstp://vpn:vpn@a2.opengw.net:1002',
  '2.2.2.2:2053#日本-机房-01$sstp://vpn:vpn@a3.opengw.net:1003',
  '2.2.2.2:2053#韩国-住宅-01$sstp://vpn:vpn@k1.opengw.net:443',
  '# 注释',
  '垃圾行',
].join('\n');

test('地区提取：自定义正则、默认规则与通用回退', () => {
  assert.deepEqual(extractRegion('日本-住宅-03', DEFAULT_REGION_RE), { region: '日本', kind: '住宅' });
  assert.deepEqual(extractRegion('US-Fast-1', '^([A-Z]+)-(\\w+)-\\d+$'), { region: 'US', kind: 'Fast' });
  assert.deepEqual(extractRegion('香港 IEPL 02', ''), { region: '香港', kind: '' });
  assert.deepEqual(extractRegion('Tokyo_03', '^zzz$'), { region: 'Tokyo', kind: '' });
  assert.equal(extractRegion('123', ''), null);
});

test('列表解析：edt 格式、无入口的纯链式行、%编码名称、入口去重', () => {
  const p = parseNodeList(LIST + '\nsocks5://u:p@5.5.5.5:1080#新加坡-住宅-01\n3.3.3.3#%E7%BE%8E%E5%9B%BD-%E4%BD%8F%E5%AE%85-01 $http://h.com:8080', DEFAULT_REGION_RE);
  assert.deepEqual([...p.groups.keys()].sort(), ['新加坡|住宅', '日本|住宅', '日本|机房', '美国|住宅', '韩国|住宅'].sort());
  assert.equal(p.groups.get('日本|住宅').nodes.length, 2);
  assert.deepEqual(p.groups.get('新加坡|住宅').nodes[0], { type: 'socks5', account: 'u:p@5.5.5.5:1080' });
  assert.deepEqual(p.groups.get('美国|住宅').nodes[0], { type: 'http', account: 'h.com:8080' });
  assert.deepEqual(p.entries, [{ address: '1.1.1.1', port: 443 }, { address: '2.2.2.2', port: 2053 }, { address: '3.3.3.3', port: 443 }]);
  assert.equal(p.total, 6);
});

const cfg = (extra = {}) => settingsWith({ preferred: { regions: { enabled: true, urls: ['https://list.test/nodes.txt'], regex: DEFAULT_REGION_RE, ...extra } } });

test('主站：只生成地区条目，数量与节点数无关，名字稳定', async () => {
  const s = cfg();
  const f = fakeFetch({ 'https://list.test/': LIST });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  const a = buildRegionSpecs({ settings: s, uuid: UUID, structure: st });
  assert.deepEqual(a.specs.map((x) => x.name), ['【家宽】日本', '【家宽】韩国', '【机房】日本']);
  assert.ok(a.specs.every((x) => ['1.1.1.1', '2.2.2.2'].includes(x.address) && x.path.startsWith('/video/')));
  // 列表整体换了节点，地区集合不变 → 条目名字、入口、id 不变（路径里只有被换掉的种子会跟着变，见 regions-seed.test.mjs）
  const f2 = fakeFetch({ 'https://list.test/': LIST.replaceAll('a1.opengw.net', 'zz.opengw.net').replaceAll('k1.', 'k9.') });
  const st2 = await loadRegionStructure({ settings: s, fetchFn: f2, now: 1e7, cache: newRegionCache() });
  const b = buildRegionSpecs({ settings: s, uuid: UUID, structure: st2 });
  assert.deepEqual(a.specs.map((x) => [x.name, x.id, x.address]), b.specs.map((x) => [x.name, x.id, x.address]));
});

test('主站：缓存内不重复拉取、过期后台刷新、失败保留旧结构；无入口时用备用入口', async () => {
  const s = cfg({ refreshSeconds: 600 });
  const cache = newRegionCache();
  const f = fakeFetch({ 'https://list.test/': LIST });
  await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache });
  await loadRegionStructure({ settings: s, fetchFn: f, now: 300e3, cache });
  assert.equal(f.calls.length, 1);
  const stale = await loadRegionStructure({ settings: s, fetchFn: f, now: 700e3, cache });
  assert.ok(stale.refreshPromise);
  await stale.refreshPromise;
  assert.equal(f.calls.length, 2);
  const bad = fakeFetch({});
  const kept = await loadRegionStructure({ settings: s, fetchFn: bad, now: 2000e3, cache });
  await kept.refreshPromise;
  assert.equal(kept.groups.size, 3);
  // 没有入口地址的纯链式行：用备用入口（随机优选池）
  const f3 = fakeFetch({ 'https://list.test/': 'socks5://a:b@1.2.3.4:1080#日本-住宅-01' });
  const st = await loadRegionStructure({ settings: s, fetchFn: f3, now: 0, cache: newRegionCache() });
  assert.equal(buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs.length, 0);
  const r = buildRegionSpecs({ settings: s, uuid: UUID, structure: st, fallbackEntries: [{ address: '9.9.9.9', port: 443 }] });
  assert.equal(r.specs.length, 1);
  assert.equal(r.specs[0].name, '【家宽】日本');
  assert.equal(r.specs[0].address, '9.9.9.9');
});

const route = async (spec, { ip = '10.0.0.1', fetchFn, now = 1e6 } = {}) => {
  const u = new URL('https://vp2.example.com' + spec.path);
  return resolvePoolRoute(u, UUID, { ip, fetchFn, now });
};
const chainOf = (url) => JSON.parse(base64SecretDecode(url.pathname.match(/\/video\/(.+)$/)[1], UUID));

test('节点站点：把地区路径改写成 edt 链式代理路径，连接时才读取列表', async () => {
  const s = cfg();
  const f = fakeFetch({ 'https://list.test/': LIST });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  const specs = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs;
  const r = await route(specs[0], { fetchFn: f });
  assert.equal(r.routed, true);
  const c = chainOf(r.url);
  assert.equal(c.type, 'sstp');
  assert.ok(['a1.opengw.net', 'a2.opengw.net'].includes(c.hostname));
  assert.equal(c.username, 'vpn');
  // 90 秒内再来一条连接：不再拉列表
  const calls = f.calls.length;
  await route(specs[1], { fetchFn: f, now: 1e6 + 30e3 }); // 另一个地区，同一份列表缓存
  assert.equal(f.calls.length, calls);
  // 非地区路径原样放行
  const plain = await resolvePoolRoute(new URL('https://x.com/?ed=2560'), UUID, {});
  assert.equal(plain.routed, false);
});

test('节点站点：新列表生效、不同用户分散、同一用户稳定、两个条目错开', async () => {
  const s = cfg({ pickK: 3, stickyMinutes: 10 });
  const many = Array.from({ length: 6 }, (_, i) => `1.1.1.1#日本-住宅-0${i + 1}$sstp://vpn:vpn@n${i}.opengw.net:443`).join('\n');
  const f = fakeFetch({ 'https://list.test/': many });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  const [e1] = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs;
  const hosts = new Set();
  for (let i = 0; i < 60; i++) hosts.add(chainOf((await route(e1, { ip: `10.1.${i}.9`, fetchFn: f })).url).hostname);
  assert.deepEqual([...hosts].sort(), ['n0.opengw.net', 'n1.opengw.net', 'n2.opengw.net'], '只在前 k=3 台里分摊');
  const a = chainOf((await route(e1, { ip: '10.2.3.4', fetchFn: f })).url).hostname;
  assert.equal(chainOf((await route(e1, { ip: '10.2.3.200', fetchFn: f, now: 1e6 + 120e3 })).url).hostname, a, '同 /24 同时间桶稳定');
  // 节点列表更新：90 秒后新节点立刻被用上，订阅无需更新
  const f2 = fakeFetch({ 'https://list.test/': many.replaceAll('n0.', 'new.').replaceAll('n1.', 'new1.').replaceAll('n2.', 'new2.') });
  // 过期后第一条连接直接用旧列表（不等外拉），同时后台刷新；刷新完成后的连接都用新列表
  const first = chainOf((await route(e1, { ip: '10.9.9.9', fetchFn: f2, now: 1e6 + 300e3 })).url).hostname;
  assert.ok(!first.startsWith('new'), '过期不久：先用旧列表，不阻塞连接');
  await new Promise((r) => setTimeout(r, 0));
  const after = new Set();
  for (let i = 0; i < 60; i++) after.add(chainOf((await route(e1, { ip: `10.3.${i}.9`, fetchFn: f2, now: 1e6 + 300e3 })).url).hostname);
  assert.ok([...after].every((h) => h.startsWith('new')));
});

test('节点站点：列表获取失败回退旧值；无旧值/无地区时返回错误', async () => {
  const s = cfg();
  const f = fakeFetch({ 'https://list.test/': LIST });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  // 用不带种子的路径（旧版主站生成的路径）测列表本身的回退逻辑；带种子的情况见 regions-seed.test.mjs
  const specs = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs.map((x) => {
    const d = JSON.parse(base64SecretDecode(x.path.replace(/^\/video\//, '').replace(/\?.*$/, ''), UUID));
    delete d.s;
    return { ...x, path: buildPoolPath(d, UUID) };
  });
  await route(specs[0], { fetchFn: f });
  const down = fakeFetch({});
  const r = await route(specs[0], { fetchFn: down, now: 1e6 + 10 * 60e3 });
  assert.equal(r.error, undefined, '旧值兜底');
  resetPoolRouteState();
  const t0 = 5e6;
  assert.match((await route(specs[0], { fetchFn: down, now: t0 })).error, /节点列表不可用/);
  // 失败后进入退避窗口：短期内不再外拉（省额度，也少一次可被观察的周期性外联）
  assert.match((await route(specs[0], { fetchFn: down, now: t0 + 3e3 })).error, /退避/);
  // 退避结束后恢复拉取；新列表里没有该地区 → 暂无可用节点
  const other2 = fakeFetch({ 'https://list.test/': '1.1.1.1#德国-住宅-01$sstp://vpn:vpn@d.opengw.net:443' });
  assert.match((await route(specs[0], { fetchFn: other2, now: t0 + 60e3 })).error, /暂无可用节点/);
});

test('多个列表合并；pick 的 sticky=0 为随机', async () => {
  const s = cfg({ urls: ['https://a.test/l', 'https://b.test/l'] });
  const f = fakeFetch({ 'https://a.test/': '1.1.1.1#日本-住宅-01$sstp://vpn:vpn@a.opengw.net:443', 'https://b.test/': '1.1.1.1#日本-住宅-01$sstp://vpn:vpn@b.opengw.net:443' });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  assert.equal(st.groups.get('日本|住宅').nodes.length, 2);
  const e = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs[0];
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(chainOf((await route(e, { ip: `10.${i}.0.1`, fetchFn: f })).url).hostname);
  assert.equal(seen.size, 2);
  const cands = [1, 2, 3, 4].map((n) => ({ n }));
  const rnd = new Set(Array.from({ length: 80 }, () => pick(cands, { k: 4, sticky: 0 }).n));
  assert.equal(rnd.size, 4);
  assert.equal(ipKey('1.2.3.4'), '1.2.3');
  assert.equal(ipKey('2606:4700:1::5'), '2606:4700:1');
});

test('类型过滤 kinds：只保留住宅；默认每个地区 1 个条目', async () => {
  const f = fakeFetch({ 'https://list.test/': LIST });
  const all = cfg({ entriesPerRegion: undefined });
  const st = await loadRegionStructure({ settings: all, fetchFn: f, now: 0, cache: newRegionCache() });
  assert.deepEqual(buildRegionSpecs({ settings: all, uuid: UUID, structure: st }).specs.map((x) => x.name), ['【家宽】日本', '【家宽】韩国', '【机房】日本']);
  const only = cfg({ kinds: ['住宅'] });
  assert.deepEqual(buildRegionSpecs({ settings: only, uuid: UUID, structure: st }).specs.map((x) => x.name), ['【家宽】日本', '【家宽】韩国']);
});

test('名称：类型显示名映射与模板；顺序与节点数无关', async () => {
  const st = await loadRegionStructure({ settings: cfg(), fetchFn: fakeFetch({ 'https://list.test/': LIST }), now: 0, cache: newRegionCache() });
  const names = (extra) => buildRegionSpecs({ settings: cfg(extra), uuid: UUID, structure: st }).specs.map((x) => x.name);
  assert.deepEqual(names({ kindNames: [] }), ['【住宅】日本', '【住宅】韩国', '【机房】日本']);
  assert.deepEqual(names({ kindNames: ['住宅=家宽', '机房=机房'], nameTemplate: '{region}·{kind}' }), ['日本·家宽', '韩国·家宽', '日本·机房']);
  // 日本节点数变化不影响顺序
  const more = [LIST, '1.1.1.1#韩国-住宅-02$sstp://vpn:vpn@k2.opengw.net:443', '1.1.1.1#韩国-住宅-03$sstp://vpn:vpn@k3.opengw.net:443'].join('\n');
  const st2 = await loadRegionStructure({ settings: cfg(), fetchFn: fakeFetch({ 'https://list.test/': more }), now: 0, cache: newRegionCache() });
  assert.deepEqual(buildRegionSpecs({ settings: cfg(), uuid: UUID, structure: st2 }).specs.map((x) => x.name), buildRegionSpecs({ settings: cfg(), uuid: UUID, structure: st }).specs.map((x) => x.name));
});

test('地区规则：自定义规则识别不了 → 取名称前面的文字（无类型）；留空 = 自动，用默认规则并写进订阅路径', async () => {
  const get = (settings) => loadRegionStructure({ settings, fetchFn: fakeFetch({ 'https://list.test/': LIST }), now: 0, cache: newRegionCache() });
  const custom = cfg({ regex: '^zzz$' });
  assert.deepEqual(buildRegionSpecs({ settings: custom, uuid: UUID, structure: await get(custom) }).specs.map((x) => x.name), ['日本', '韩国']);
  const auto = cfg({ regex: '' });
  const specs = buildRegionSpecs({ settings: auto, uuid: UUID, structure: await get(auto) }).specs;
  assert.deepEqual(specs.map((x) => x.name), ['【家宽】日本', '【家宽】韩国', '【机房】日本']);
  // 规则写进路径：节点（不管新旧版本）按路径里的规则解析，所以主站调整规则不需要升级节点
  const payload = JSON.parse(base64SecretDecode(specs[0].path.replace('/video/', ''), UUID));
  assert.equal(payload.r, DEFAULT_REGION_RE);
  assert.equal(payload.kind, '住宅');
});

test('地区入口：按客户端网段分散，同网段同窗口稳定', async () => {
  const s = cfg();
  const st = await loadRegionStructure({ settings: s, fetchFn: fakeFetch({ 'https://list.test/': LIST }), now: 0, cache: newRegionCache() });
  const at = (ip, now = 1e9) => buildRegionSpecs({ settings: s, uuid: UUID, structure: st, ip, now }).specs[0].address;
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(at(`10.${i}.1.9`));
  assert.deepEqual([...seen].sort(), ['1.1.1.1', '2.2.2.2']);
  assert.equal(at('10.8.1.9'), at('10.8.1.200', 1e9 + 3600e3));
});

test('健康选路：失败节点立即避开，成功节点优先，全失败时扩大候选窗口', () => {
  const cands = Array.from({ length: 4 }, (_, i) => ({ type: 'sstp', account: `vpn:vpn@n${i}.opengw.net:443` }));
  const opts = { k: 2, sticky: 30, ip: '10.0.0.1', now: 1e9, key: '日本|住宅' };
  const first = pick(cands, opts);
  assert.equal(pick(cands, opts), first, '无健康记录时保持粘性');
  reportChainResult(false, 'n0.opengw.net', 443, 1e9);
  reportChainResult(false, 'n1.opengw.net', 443, 1e9);
  assert.match(pick(cands, opts).account, /@n[23]\.opengw\.net:/, '前 k 台全失败会扩窗到未知节点');
  reportChainResult(true, 'n3.opengw.net', 443, 1e9 + 1000);
  for (let i = 0; i < 20; i++) {
    const selected = pick(cands, { ...opts, ip: `10.${i}.0.1`, now: 1e9 + 2000 });
    assert.match(selected.account, /@n3\.opengw\.net:/, '有近期成功节点时只从成功层选取');
  }
  reportChainResult(false, 'n3.opengw.net', 443, 1e9 + 3000);
  assert.match(pick(cands, { ...opts, now: 1e9 + 4000 }).account, /@n2\.opengw\.net:/, '成功节点随后失败会立即降级到未知层');
  resetPoolRouteState();
  assert.equal(pick(cands, opts), first, '重置后恢复原始确定性选路');
});


test('会合哈希：候选列表移除一台，只有选中它的用户换节点', () => {
  resetPoolRouteState();
  const cands = Array.from({ length: 8 }, (_, i) => ({ type: 'sstp', account: `vpn:vpn@m${i}.opengw.net:443` }));
  const opts = (n) => ({ k: 8, sticky: 30, ip: `10.${n}.0.1`, now: 2e9, key: '日本|住宅' });
  const before = Array.from({ length: 60 }, (_, n) => pick(cands, opts(n)).account);
  const removed = cands[3].account;
  const rest = cands.filter((c) => c.account !== removed);
  let moved = 0;
  for (let n = 0; n < 60; n++) {
    const a = pick(rest, opts(n)).account;
    if (a !== before[n]) { moved++; assert.equal(before[n], removed); }
  }
  assert.ok(new Set(before).size > 4, '用户被分散到多台');
  assert.ok(moved < 30);
});

test('故障转移候选：第一台与路径一致、不重复、数量受限、都属于该地区', async () => {
  const s = cfg();
  const f = fakeFetch({ 'https://list.test/': LIST });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  const specs = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs;
  const r = await route(specs[0], { fetchFn: f });
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 2, '应带上备用链路');
  assert.deepEqual(r.candidates[0], chainOf(r.url), '第一台就是路径里那台');
  const ids = r.candidates.map((c) => `${c.type}|${c.hostname}|${c.port}`);
  assert.equal(new Set(ids).size, ids.length, '候选不重复');
  assert.ok(r.candidates.length <= 4, '候选数量受限');
  assert.ok(r.candidates.every((c) => ['a1.opengw.net', 'a2.opengw.net'].includes(c.hostname)), '候选都来自该地区');
});

test('故障转移候选尊重健康度：拨号失败过的节点会被排到后面', async () => {
  const s = cfg();
  const f = fakeFetch({ 'https://list.test/': LIST });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  const specs = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs;
  reportChainResult(false, 'a1.opengw.net', 1001, 1e6 + 1000);
  const r = await route(specs[0], { fetchFn: f, now: 1e6 + 2000 });
  assert.equal(r.candidates[0].hostname, 'a2.opengw.net', '失败的节点不再排第一');
  assert.equal(r.candidates[r.candidates.length - 1].hostname, 'a1.opengw.net', '它退到候选末尾');
});

test('候选排序：同类健康状态下优先更稳的协议（socks5 先于 sstp/turn）', () => {
  resetPoolRouteState();
  const cands = [
    { type: 'turn', account: 'u:p@t.opengw.net:3478' },
    { type: 'sstp', account: 'vpn:vpn@s.opengw.net:443' },
    { type: 'socks5', account: 'u:p@k.opengw.net:1080' },
    { type: 'http', account: 'h.opengw.net:8080' },
  ];
  const { eligible, ordered } = rankCandidates(cands, { k: 10, now: 1e9 });
  assert.deepEqual(eligible.map((c) => c.type), ['socks5', 'http', 'sstp', 'turn']);
  assert.deepEqual(ordered.map((c) => c.type), ['socks5', 'http', 'sstp', 'turn']);
});

test('列表自适应 TTL：内容不变时拉取间隔指数放大，减少了外拉次数', async () => {
  resetPoolRouteState();
  const s = cfg();
  const many = Array.from({ length: 4 }, (_, i) => `1.1.1.1#日本-住宅-0${i + 1}$sstp://vpn:vpn@t${i}.opengw.net:443`).join('\n');
  const f = fakeFetch({ 'https://list.test/': many });
  const st = await loadRegionStructure({ settings: s, fetchFn: f, now: 0, cache: newRegionCache() });
  const spec = buildRegionSpecs({ settings: s, uuid: UUID, structure: st }).specs[0];
  const c0 = f.calls.length;
  await route(spec, { fetchFn: f, now: 1e6 });              // 第 1 次拉取（基线 TTL 180s±20%）
  assert.equal(f.calls.length, c0 + 1);
  await route(spec, { fetchFn: f, now: 1e6 + 250e3 });      // 超过基线最坏值 216s → 第 2 次拉取，内容没变
  assert.equal(f.calls.length, c0 + 2);
  await route(spec, { fetchFn: f, now: 1e6 + 500e3 });      // 距上次 250s < 放大后的最短 288s → 不拉
  assert.equal(f.calls.length, c0 + 2, '内容不变后 TTL 翻倍，不再按基线频率外拉');
  await route(spec, { fetchFn: f, now: 1e6 + 800e3 });      // 距上次 550s > 432s → 第 3 次拉取
  assert.equal(f.calls.length, c0 + 3);
});
