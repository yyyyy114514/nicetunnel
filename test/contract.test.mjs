// 主站 ↔ 节点站点的数据面契约（src/dataplane/contract.js）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { versionResponse } from '../src/dataplane/adapter.js';
import { DATAPLANE_VERSION, POOL_ROUTE_V, CAPS } from '../src/dataplane/contract.js';
import { buildPoolPath, resolvePoolRoute, resetPoolRouteState } from '../src/dataplane/pool-route.js';
import { base64SecretEncode, base64SecretDecode } from '../src/dataplane/edt-core.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { resetStoreState } from '../src/control/store.js';
import { adminHtml } from '../src/admin/ui.js';
import { memKV, fakeFetch, UUID } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetPoolRouteState(); resetStoreState(); });
afterEach(() => { globalThis.fetch = realFetch; });

test('/version：保留 edt 的 Version 字段，新增 Dataplane/Caps/Edition，带 CORS；UUID 不对时不泄露', async () => {
  const ok = versionResponse(new URL('https://n.example.com/version?uuid=' + UUID), UUID);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  const j = await ok.json();
  assert.equal(typeof j.Version, 'number');
  assert.equal(j.Dataplane, DATAPLANE_VERSION);
  assert.deepEqual(j.Caps, [...CAPS]);
  assert.equal(j.Edition, 'full');
  assert.equal(versionResponse(new URL('https://n.example.com/version?uuid=00000000-0000-4000-8000-000000000000'), UUID), null);
  assert.equal(versionResponse(new URL('https://n.example.com/version'), UUID), null);
});

test('节点站点只设置 UUID 一个变量（无 KV、无 ADMIN）即可工作：/version 返回数据面版本，其它请求是伪装页', async () => {
  const env = { UUID };
  const id = deriveIdentity(env, 'vp2.example.com');
  assert.equal(id.uuid, UUID);
  assert.ok(id.adminPassword, '管理员密码回退取 UUID，数据面不会因缺少 ADMIN 而拒绝代理');
  globalThis.fetch = fakeFetch({});
  const r = await worker.fetch(new Request('https://vp2.example.com/version?uuid=' + UUID), env, { waitUntil() {} });
  assert.equal((await r.json()).Dataplane, DATAPLANE_VERSION);
  const page = await worker.fetch(new Request('https://vp2.example.com/sub?token=x'), env, { waitUntil() {} });
  assert.ok(!(await page.text()).includes('vless://'));
});

test('地区路由路径带版本 v；更高版本的路径 → 明确提示更新节点；未知字段被忽略', async () => {
  const data = { u: ['https://list.test/n'], r: '', region: '日本', kind: '', i: 0, k: 5, ttl: 90, sticky: 10 };
  const path = buildPoolPath(data, UUID);
  const plain = JSON.parse(base64SecretDecode(path.replace('/video/', ''), UUID));
  assert.equal(plain.v, POOL_ROUTE_V);
  assert.equal(plain.type, 'pool');
  const list = '1.1.1.1#日本$sstp://vpn:vpn@a.opengw.net:443';
  const f = fakeFetch({ 'https://list.test/': list });
  const run = (p) => resolvePoolRoute(new URL('https://vp2.example.com' + p), UUID, { ip: '10.0.0.1', fetchFn: f });
  assert.equal((await run(path)).error, undefined);
  // 未知字段（以后主站可能新增的可选字段）不影响旧节点
  const withExtra = '/video/' + base64SecretEncode(JSON.stringify({ ...plain, future: { a: 1 }, pick: 'latency' }), UUID);
  assert.equal((await run(withExtra)).error, undefined);
  // 更高的 v：旧节点必须明确报错，不能静默连错
  const tooNew = '/video/' + base64SecretEncode(JSON.stringify({ ...plain, v: POOL_ROUTE_V + 1 }), UUID);
  const r = await run(tooNew);
  assert.match(r.error, /节点站点版本过旧/);
  assert.equal(r.routed, true);
});

test('后台：状态接口带出数据面版本；概览有 UUID 速查；账号页有"检测节点"，内联脚本语法正确', async () => {
  const kv = memKV({ 'nt.settings': { schema: 2 }, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw', KEY: 'k', UUID };
  const id = deriveIdentity(env, 'vp.example.com');
  globalThis.fetch = fakeFetch({});
  const h = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt' };
  const st = await (await worker.fetch(new Request('https://vp.example.com/admin/api/state', { headers: h }), env, { waitUntil() {} })).json();
  assert.equal(st.dataplane.version, DATAPLANE_VERSION);
  assert.deepEqual(st.dataplane.caps, [...CAPS]);
  const html = adminHtml({ version: '1', siteName: 'nicetunnel' });
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('节点站点（互联）') && js.includes('检测全部节点') && js.includes("'/version?uuid='"));
});

test('/version：UUID 校验失败与普通伪装页完全一致，不附加 CORS/no-store 指纹', async () => {
  globalThis.fetch = fakeFetch({});
  const call = (env, uuid) => worker.fetch(new Request('https://vp2.example.com/version' + (uuid ? '?uuid=' + uuid : '')), env, { waitUntil() {} });
  const good = await call({ UUID }, UUID);
  assert.equal(good.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok((await good.json()).Dataplane >= 2);
  for (const [name, env, q] of [['UUID 不一致', { UUID: '11111111-2222-4333-8444-555555555555' }, UUID], ['没设 UUID', {}, UUID], ['没带 uuid 参数', { UUID }, '']]) {
    const r = await call(env, q);
    const normal = await worker.fetch(new Request('https://vp2.example.com/ordinary-page'), env, { waitUntil() {} });
    assert.equal(r.status, normal.status, name);
    assert.deepEqual([...r.headers].sort(), [...normal.headers].sort(), name + '：响应头无独有特征');
    const text = await r.text();
    assert.equal(text, await normal.text(), name + '：响应体与伪装页一致');
    assert.ok(text.includes('nginx') && !text.includes('Dataplane'), name + '：是伪装页，不泄露版本信息');
  }
});

test('UUID 来源：合法 v4 用环境变量；格式不对被忽略并告警（节点会因此与主站不一致）', async () => {
  const { selfCheck } = await import('../src/control/selfcheck.js');
  const { normalizeSettings } = await import('../src/control/settings.js');
  const ok = deriveIdentity({ ADMIN: 'pw', UUID }, 'vp.example.com');
  assert.deepEqual([ok.uuidSource, ok.envUuidInvalid, ok.uuid], ['env', false, UUID]);
  const bad = deriveIdentity({ ADMIN: 'pw', UUID: 'not-a-valid-uuid' }, 'vp.example.com');
  assert.deepEqual([bad.uuidSource, bad.envUuidInvalid], ['derived', true]);
  assert.notEqual(bad.uuid, 'not-a-valid-uuid');
  // 没设置时是"推导"，但不算"设置了却无效"
  const none = deriveIdentity({ ADMIN: 'pw' }, 'vp.example.com');
  assert.deepEqual([none.uuidSource, none.envUuidInvalid], ['derived', false]);
  const run = (identity) => selfCheck({ settings: normalizeSettings({}), accounts: [], usage: null, host: 'vp.example.com', now: Date.now(), kvBound: true, rules: { ini: { groups: 1 } }, identity });
  assert.ok(run(bad).some((c) => c.id === 'uuid-invalid' && c.level === 'warn'));
  assert.ok(!run(ok).some((c) => c.id === 'uuid-invalid'));
  assert.ok(!run(none).some((c) => c.id === 'uuid-invalid'));
});

test('后台检测节点：读不到响应时用 no-cors 再探一次区分"连不上"和"读不到"，并给出"打开"链接', () => {
  const js = adminHtml({ version: '1', siteName: 'nicetunnel' }).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("mode: 'no-cors'"));
  assert.ok(js.includes("state: 'cors'") && js.includes("state: 'down'"));
  assert.ok(js.includes('target="_blank"'));
  // 慢网络：超时放宽到 15 秒；连不上时自动重试一次
  assert.ok(js.includes('const attempt = async (host)') && js.includes('已重试 1 次') && js.includes('ac.abort(), 15000'));
});
