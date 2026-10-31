// 排障相关：设置迁移、构建号、订阅自报生效设置、自检提示
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { defaultSettings, normalizeSettings, SCHEMA_VERSION } from '../src/control/settings.js';
import { selfCheck } from '../src/control/selfcheck.js';
import { buildLabel, BUILD_ID } from '../src/build-info.js';
import { adminHtml } from '../src/admin/ui.js';
import { deriveIdentity } from '../src/control/identity.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { memKV, fakeFetch, UUID } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); });
afterEach(() => { globalThis.fetch = realFetch; });

test('设置迁移：旧默认的测速下限（600，或更早的 0）改为按 INI（0）、旧默认容差 100 改为 50；用户自己的值保持', () => {
  assert.equal(SCHEMA_VERSION, 5);
  const old = JSON.parse(JSON.stringify(defaultSettings()));
  old.schema = 2;
  old.sub.testIntervalMin = 0; // 更早版本存进 KV 的"当时默认值"
  assert.equal(normalizeSettings(old).sub.testIntervalMin, 0);
  old.schema = 4;
  old.sub.testIntervalMin = 600; // 上一版的默认
  old.sub.tolerance = 100;
  assert.equal(normalizeSettings(old).sub.testIntervalMin, 0);
  assert.equal(normalizeSettings(old).sub.tolerance, 50);
  // 旧 schema 但值不是旧默认：保持用户的值
  old.sub.testIntervalMin = 1200;
  assert.equal(normalizeSettings(old).sub.testIntervalMin, 1200);
  // 已经是新 schema：显式 0 被尊重（用户在新版里主动设成 0）
  const cur = JSON.parse(JSON.stringify(defaultSettings()));
  cur.sub.testIntervalMin = 0;
  assert.equal(normalizeSettings(cur).sub.testIntervalMin, 0);
  // 没有 schema 字段（程序里临时构造的设置）：不迁移
  assert.equal(normalizeSettings({ sub: { testIntervalMin: 0 } }).sub.testIntervalMin, 0);
});

test('构建号：源码里是占位符显示 dev；/version 带 Build；后台显示构建号', async () => {
  assert.ok(BUILD_ID.startsWith('__') || /^[0-9a-f]{8}$/.test(BUILD_ID));
  assert.equal(buildLabel(), BUILD_ID.startsWith('__') ? 'dev' : BUILD_ID);
  globalThis.fetch = fakeFetch({});
  const r = await worker.fetch(new Request('https://vp2.example.com/version?uuid=' + UUID), { UUID }, { waitUntil() {} });
  assert.equal((await r.json()).Build, buildLabel());
  const js = adminHtml({ version: '1', siteName: 'nicetunnel' }).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("(S.build ? ' · ' + S.build : '')"));
});

test('订阅响应头自报构建号与生效的关键设置，出问题时不用猜', async () => {
  const kv = memKV({ 'nt.settings': { schema: 3, preferred: { random: { count: 4, aggregate: false }, regions: { enabled: false } }, sub: { testIntervalMin: 0 } }, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw', UUID };
  const id = deriveIdentity(env, 'vp.example.com');
  globalThis.fetch = fakeFetch({});
  const res = await worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken + '&clash', { headers: { 'User-Agent': 'clash-verge', 'CF-Connecting-IP': '9.9.9.9' } }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-NT-Build'), buildLabel());
  assert.equal(res.headers.get('X-NT-Opts'), 'agg=0;tmin=0;regions=0;random=1');
  // 聚合开着时（换一份 KV：先清掉本进程的设置缓存，模拟另一个运行实例）
  resetStoreState(); resetPipelineState();
  const kv2 = memKV({ 'nt.settings': { schema: 3, preferred: { random: { count: 4 } } }, 'nt.accounts': [] });
  const res2 = await worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken + '&clash', { headers: { 'User-Agent': 'clash-verge', 'CF-Connecting-IP': '9.9.9.8' } }), { ...env, KV: kv2 }, { waitUntil() {} });
  assert.match(res2.headers.get('X-NT-Opts'), /^agg=1;tmin=0;/, '旧 schema 的默认下限已迁移为按 INI');
});

test('自检：随机优选聚合被关闭时说明原因（随机优选关闭时不提示）', () => {
  const run = (o) => selfCheck({ settings: normalizeSettings(o), accounts: [], usage: null, host: 'vp.example.com', now: Date.now(), kvBound: true, rules: { ini: { groups: 1 } } });
  assert.ok(run({ preferred: { random: { aggregate: false } } }).some((c) => c.id === 'agg-off' && c.level === 'info'));
  assert.ok(!run({}).some((c) => c.id === 'agg-off'));
  assert.ok(!run({ preferred: { random: { enabled: false, aggregate: false } } }).some((c) => c.id === 'agg-off'));
});

test('后台保存：状态里没有的字段（旧服务端）不会把未选中的复选框写成 false', () => {
  const js = adminHtml({ version: '1', siteName: 'nicetunnel' }).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.ok(js.includes("if (t === 'bool') { if (old === undefined) return; v = el.checked; }"));
});

test('后台账号页：显示轮询状态（失败原因 / 过期多久 / 无凭据 / 未轮询），概览的"过期"有说明；旧样式类已清理', () => {
  const js = adminHtml({ version: '1', siteName: 'nicetunnel' }).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  for (const s of ['const pollStatus = (a)', '无凭据', '未轮询', "p-exhausted\">失败", 'p-stale', '分钟没有更新', '分配权重减半', '轮询失败怎么办', '填上该账号的 Account ID'.replace('填上该账号的 ', '')]) assert.ok(js.includes(s), '缺少：' + s);
  // 状态列紧跟"节点域名"之后，不用横向滚动才能看到
  assert.ok(js.indexOf('<th>节点域名（逗号分隔）</th><th>轮询状态</th>') > 0);
  // 重新设计界面时旧的 s-ok / s-low / s-exhausted 样式类已不存在，页面里不应再引用
  assert.ok(!/class=\?"s-(ok|low|exhausted|stale)/.test(js), '不应再引用已删除的样式类');
});

test('后台/登录页内联图标：浏览器不再请求 /favicon.ico（每次打开省一次主站请求）', async () => {
  const { loginHtml } = await import('../src/admin/ui.js');
  for (const html of [adminHtml({ version: '1', siteName: 'nicetunnel' }), loginHtml({ siteName: 'nicetunnel' })]) assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
});
