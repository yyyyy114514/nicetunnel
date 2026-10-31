// 地区路由提速：路径带种子候选（新实例不必先等列表）；SSTP 死节点 3 秒内失败
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGION_RE } from '../src/lib/pool-parse.js';
import { loadRegionStructure, buildRegionSpecs, newRegionCache } from '../src/control/regions.js';
import { resolvePoolRoute, resetPoolRouteState, getGroups } from '../src/dataplane/pool-route.js';
import { base64SecretDecode, sstpConnect } from '../src/dataplane/edt-core.js';
import { settingsWith, fakeFetch, UUID } from './helpers.mjs';

beforeEach(() => resetPoolRouteState());

const many = (n, host = 'jp') => Array.from({ length: n }, (_, i) => `1.1.1.1:443#日本-住宅-${String(i + 1).padStart(2, '0')}$sstp://vpn:vpn@${host}${i}.opengw.net:443`).join('\n');
const cfg = () => settingsWith({ preferred: { regions: { enabled: true, urls: ['https://list.test/nodes.txt'], regex: DEFAULT_REGION_RE } } });
const decode = (path) => JSON.parse(base64SecretDecode(path.replace(/^\/video\//, '').replace(/\?.*$/, ''), UUID));

async function specsFor(text, now = 0) {
  const s = cfg();
  const st = await loadRegionStructure({ settings: s, fetchFn: fakeFetch({ 'https://list.test/': text }), now, cache: newRegionCache() });
  return buildRegionSpecs({ settings: s, uuid: UUID, structure: st, now }).specs;
}

test('主站：地区条目路径带 4 个种子候选（取自列表前 12 台）', async () => {
  const [spec] = await specsFor(many(30));
  const d = decode(spec.path);
  assert.equal(d.s.length, 4);
  for (const [type, account] of d.s) {
    assert.equal(type, 'sstp');
    const idx = Number(account.match(/jp(\d+)\./)[1]);
    assert.ok(idx < 12, '种子应来自列表前 12 台：' + account);
  }
});

test('主站：前 12 台顺序变化、12 台以外的节点变化，路径不变', async () => {
  const lines = many(30).split('\n');
  const [a] = await specsFor(lines.join('\n'));
  const reordered = lines.slice(0, 12).reverse().concat(lines.slice(12).map((l) => l.replace('opengw', 'other')));
  const [b] = await specsFor(reordered.join('\n'));
  assert.equal(b.path, a.path);
  assert.equal(b.id, a.id);
});

test('节点：新实例（没缓存列表）列表迟迟不回时，最多等 0.8 秒就用种子拨号', async () => {
  const [spec] = await specsFor(many(10));
  let calls = 0;
  const hang = () => { calls++; return new Promise(() => {}); }; // 列表源一直不回
  const url = new URL('https://n.example.com' + spec.path);
  const t0 = Date.now();
  const r = await resolvePoolRoute(url, UUID, { ip: '7.7.7.7', fetchFn: hang });
  const waited = Date.now() - t0;
  assert.ok(waited >= 700 && waited < 1300, '应只等约 0.8 秒：' + waited);
  assert.equal(r.error, undefined);
  assert.ok(r.candidates.length >= 1 && r.candidates.every((c) => c.type === 'sstp' && /opengw/.test(c.hostname)));
  assert.equal(calls, 1, '后台照样去拉列表');
});

test('节点：已缓存列表时用完整列表；路径没有种子时行为与以前一样（等列表）', async () => {
  const text = many(10, 'full');
  const f = fakeFetch({ 'https://list.test/': text });
  await getGroups(['https://list.test/nodes.txt'], DEFAULT_REGION_RE, { fetchFn: f, now: Date.now() });
  const [spec] = await specsFor(many(10)); // 种子是 jp*，缓存里的列表是 full*
  const r = await resolvePoolRoute(new URL('https://n.example.com' + spec.path), UUID, { ip: '7.7.7.7', fetchFn: f });
  assert.ok(r.candidates.every((c) => /^full/.test(c.hostname)), '有缓存就用列表：' + JSON.stringify(r.candidates));
  resetPoolRouteState();
  const d = decode(spec.path); delete d.s;
  const { buildPoolPath } = await import('../src/dataplane/pool-route.js');
  const r2 = await resolvePoolRoute(new URL('https://n.example.com' + buildPoolPath(d, UUID)), UUID, { ip: '7.7.7.7', fetchFn: f });
  assert.ok(r2.candidates.every((c) => /^full/.test(c.hostname)));
});

test('SSTP：服务器连不上时 3 秒左右失败（不再拖满 6 秒，测速来得及换下一台）', async () => {
  const dead = () => ({ opened: new Promise(() => {}), readable: new ReadableStream(), writable: new WritableStream(), closed: new Promise(() => {}), close() {} });
  const t0 = Date.now();
  await assert.rejects(sstpConnect({ hostname: 'dead.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, dead), /timed out/);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms < 4000, '耗时 ' + ms + 'ms');
});

test('节点：列表拉不到时用种子顶上；列表回来了但地区已下线，照实报错', async () => {
  const [spec] = await specsFor(many(6));
  const url = new URL('https://n.example.com' + spec.path);
  const down = fakeFetch({});
  const r = await resolvePoolRoute(url, UUID, { ip: '7.7.7.7', fetchFn: down });
  assert.equal(r.error, undefined, '列表 404 → 用种子');
  assert.ok(r.candidates.length >= 1);
  resetPoolRouteState();
  const gone = fakeFetch({ 'https://list.test/': '1.1.1.1#德国-住宅-01$sstp://vpn:vpn@d.opengw.net:443' });
  assert.match((await resolvePoolRoute(url, UUID, { ip: '7.7.7.7', fetchFn: gone })).error, /暂无可用节点/);
});
