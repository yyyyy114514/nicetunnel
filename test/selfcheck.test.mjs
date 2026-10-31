import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { selfCheck } from '../src/control/selfcheck.js';
import { normalizeSettings } from '../src/control/settings.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { adminHtml } from '../src/admin/ui.js';
import { memKV, fakeFetch, settingsWith } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); });
afterEach(() => { globalThis.fetch = realFetch; });

const now = Date.UTC(2026, 9, 25, 3);
const acc = (id, extra = {}) => ({ id, name: id, hosts: [`${id}.ex.com`], role: 'node', enabled: true, auth: { apiToken: 't' }, ...extra });
const ids = (r) => r.map((x) => x.id);
const run = (o = {}) => selfCheck({ settings: normalizeSettings(o.settings || {}), accounts: o.accounts ?? [acc('a1')], usage: o.usage ?? { ts: now - 60e3, accounts: {} }, host: o.host ?? 'vp.ex.com', now, kvBound: o.kvBound ?? true, rules: o.rules ?? { ini: { groups: 1 } } });

test('健康配置：只剩提示项，没有需要处理的', () => {
  const r = run({ settings: {} });
  assert.deepEqual(r.filter((x) => x.level === 'warn'), []);
});

test('主站域名混进分配池（来自节点账号或"未纳入管理"列表）→ 告警', () => {
  assert.ok(ids(run({ settings: { hosts: { unmanaged: ['VP.ex.com'] } } })).includes('main-in-pool'));
  assert.ok(ids(run({ accounts: [acc('a1', { hosts: ['vp.ex.com'] })] })).includes('main-in-pool'));
  assert.ok(!ids(run()).includes('main-in-pool'));
});

test('没有 KV / 没有节点域名 / 没有凭据 / 轮询失败 / 用量过期', () => {
  assert.ok(ids(run({ kvBound: false })).includes('kv'));
  assert.ok(ids(run({ accounts: [] })).includes('no-hosts'));
  assert.ok(ids(run({ accounts: [acc('a1', { auth: {} })] })).includes('no-cred'));
  const fail = run({ accounts: [acc('a1')], usage: { ts: now - 60e3, accounts: { a1: { ok: false, err: 'HTTP 403' } } } });
  assert.match(fail.find((x) => x.id === 'poll-fail').text, /a1：HTTP 403/);
  const stale = run({ usage: { ts: now - 3 * 3600e3, accounts: {} } });
  assert.match(stale.find((x) => x.id === 'usage-stale').text, /180 分钟/);
  assert.ok(!ids(run({ accounts: [acc('a1', { auth: {} })], usage: { ts: now - 3 * 3600e3, accounts: {} } })).includes('usage-stale'), '没有凭据的账号不要求用量新鲜');
  // 兼容脱敏后的账号字段
  assert.ok(!ids(run({ accounts: [acc('a1', { auth: { hasToken: true } })] })).includes('no-cred'));
});

test('功能配置：地区路由 / 优选订阅 / 转换配置 / Telegram / 测速下限', () => {
  const r1 = run({ settings: { preferred: { regions: { enabled: true, urls: [] }, best: { enabled: true, urls: [] } } } });
  assert.ok(ids(r1).includes('regions-empty') && ids(r1).includes('best-empty'));
  assert.ok(ids(run({ settings: { preferred: { regions: { enabled: true, urls: ['https://x.test/l'] } } } })).includes('regions-nodes'));
  assert.ok(ids(run({ rules: { ini: null } })).includes('ini-not-cached'));
  assert.ok(!ids(run({ rules: { ini: null }, settings: { rules: { configText: 'x' } } })).includes('ini-not-cached'));
  assert.ok(ids(run({ settings: { notify: { telegram: { enabled: true, botToken: '', chatId: '' } } } })).includes('tg-incomplete'));
  assert.ok(ids(run({ settings: { sub: { testIntervalMin: 900 } } })).includes('test-interval-slow'), '下限太大：节点换得慢');
  assert.ok(!ids(run()).includes('test-interval-slow'), '默认按 INI 不提示');
  assert.ok(ids(run({ settings: { sub: { testIntervalAuto: false } } })).includes('test-interval-noguard'));
  assert.ok(ids(run({ settings: { sub: { updateHours: 0.2 } } })).includes('update-hours'));
});

test('排序：需要处理的在前，提示在后', () => {
  const r = run({ settings: { sub: { testIntervalMin: 900 } }, kvBound: false });
  const firstInfo = r.findIndex((x) => x.level === 'info');
  assert.ok(firstInfo > 0 && r.slice(firstInfo).every((x) => x.level === 'info'));
});

test('端到端：状态接口带出 checks；后台页面含自检卡片代码且内联脚本语法正确', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({ hosts: { unmanaged: ['vp.example.com', 'vp2.example.com'] } }), 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw', KEY: 'k' };
  const id = deriveIdentity(env, 'vp.example.com');
  globalThis.fetch = fakeFetch({});
  const h = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt' };
  const st = await (await worker.fetch(new Request('https://vp.example.com/admin/api/state', { headers: h }), env, { waitUntil() {} })).json();
  assert.ok(Array.isArray(st.checks));
  assert.ok(st.checks.some((c) => c.id === 'main-in-pool' && c.level === 'warn'));
  const html = adminHtml({ version: '1', siteName: 'nicetunnel' });
  assert.ok(html.includes('配置自检'));
  assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]));
});

test('后台设置块：全部是常开的卡片（不再有折叠）、保存栏只在有改动时出现，内联脚本语法正确', () => {
  const html = adminHtml({ version: '1', siteName: 'nicetunnel' });
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes('details') && !html.includes('details.fold'), '不再有折叠块');
  assert.ok(js.includes('function cardHtml(c)'));
  assert.ok(js.includes('id="saveBar" hidden'), '保存栏默认隐藏');
  assert.ok(js.includes("if (dirty && !confirm("), '有未保存改动时切页要确认');
  assert.ok(html.includes('.savebar{position:sticky'));
});

test('自检：节点域名是 pages.dev / workers.dev 时提示（大陆网络普遍干扰），自定义域名不提示', async () => {
  const { selfCheck, isCfDefaultHost } = await import('../src/control/selfcheck.js');
  const { settingsWith } = await import('./helpers.mjs');
  assert.ok(isCfDefaultHost('abc.pages.dev') && isCfDefaultHost('x.y.workers.dev') && !isCfDefaultHost('vp2.example.com') && !isCfDefaultHost('pages.dev.example.com'));
  const run = (hosts) => selfCheck({ settings: settingsWith({}), accounts: [{ id: 'n', role: 'node', enabled: true, hosts }], usage: null, host: 'main.com', now: 0, kvBound: true }).map((c) => c.id);
  assert.ok(run(['n1.pages.dev']).includes('cf-default-host'));
  assert.ok(!run(['vp2.example.com']).includes('cf-default-host'));
});
