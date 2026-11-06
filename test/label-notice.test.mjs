// 用户在订阅页填写标识（只能一次，后台可重置）；公告分组（Clash / sing-box / Surge）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { renderSubscription } from '../src/control/sub/index.js';
import { normalizeSettings } from '../src/control/settings.js';
import { memKV, fakeFetch, settingsWith, TEST_AUTH_KEY, resolvedNodes } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); globalThis.fetch = fakeFetch({}); });
afterEach(() => { globalThis.fetch = realFetch; });

function setup() {
  const kv = memKV({ 'nt.settings': settingsWith({ users: { enabled: true } }), 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pw' };
  const id = deriveIdentity(env, 'vp.example.com');
  const cookie = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt', 'Content-Type': 'application/json' };
  const admin = (path, body, method = 'POST') => worker.fetch(new Request('https://vp.example.com' + path, { method, headers: cookie, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  const put = (sub, label, ip = '5.5.5.5') => worker.fetch(new Request(sub.replace('/sub?', '/sub/label?'), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ label }) }), env, { waitUntil() {} });
  const page = (sub) => worker.fetch(new Request(sub, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone) Safari' } }), env, { waitUntil() {} });
  return { kv, env, admin, put, page };
}

test('标识：订阅页有输入框；只能设置一次（第二次 409）；后台能看到并可重置，重置后能再设一次', async () => {
  const { admin, put, page } = setup();
  const made = await (await admin('/admin/api/users/create', { count: 1 })).json();
  const u = made.created[0];
  let html = await (await page(u.sub)).text();
  assert.ok(html.includes('id="lv"') && html.includes('只能设置一次'), '有输入框');
  assert.ok(html.includes("method:'PUT'"), '用 PUT 提交（POST 会被数据面当成代理流量）');
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js), '页面脚本能解析（之前 confirm 里的换行让整段脚本报错）');
  assert.ok(html.indexOf('id="lb"') < html.indexOf('class="card a-imp"'), '标识在最上面');
  assert.equal((await put(u.sub, '   ')).status, 400, '空的不行');
  const r1 = await put(u.sub, '张三<script>');
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).label, '张三script', '去掉尖括号');
  const r2 = await put(u.sub, '李四');
  assert.equal(r2.status, 409, '只能设置一次');
  html = await (await page(u.sub)).text();
  assert.ok(!html.includes('id="lb"') && !html.includes('id="lv"'), '设置过就不再显示');
  // 后台：列表里有，搜索也能搜到
  const list = await (await admin('/admin/api/users?q=' + encodeURIComponent('张三'), undefined, 'GET')).json();
  assert.equal(list.users[0].label, '张三script');
  assert.ok(list.users[0].labelAt > 0);
  // 重置
  await admin('/admin/api/users/update', { ids: [u.id], resetLabel: true });
  resetStoreState();
  assert.equal((await put(u.sub, '王五')).status, 200, '重置后能再设一次');
  // 链接无效 / 封禁中
  assert.equal((await put(u.sub.replace(/.$/, (c) => (c === '0' ? '1' : '0')), 'x')).status, 403);
  await admin('/admin/api/users/update', { ids: [u.id], banned: true });
  assert.equal((await put(u.sub, 'x')).status, 403);
});

test('标识：提交也受限速', async () => {
  const { kv, admin, put } = setup();
  kv.m.set('nt.settings', JSON.stringify(settingsWith({ users: { enabled: true }, sub: { rateLimitPerMinute: 2 } })));
  resetStoreState();
  const u = (await (await admin('/admin/api/users/create', { count: 1 })).json()).created[0];
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await put(u.sub, 'a' + i, '9.9.9.9')).status);
  assert.deepEqual(codes, [200, 409, 429]);
});

const INI = (await import('../src/control/sub/ini.js')).parseIni((await import('../src/control/sub/ini.js')).DEFAULT_INI_TEXT);
const ctxOf = (s) => ({ uuid: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', settings: s, now: 0, requestUrl: 'https://x/sub', subName: 'x', userAgent: 'clash', generatorMode: false });

test('公告：Clash / sing-box / Surge 最前面多一个以公告命名、只含直连的分组；默认路由不受影响；留空不显示', () => {
  const s = normalizeSettings(settingsWith({ sub: { announcement: '11月10日起换新域名, 请更新=订阅' } }));
  const clash = renderSubscription({ format: 'clash', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules: { block: null } }).body;
  const groupLines = clash.split('proxy-groups:')[1].split('\n').filter((l) => l.startsWith('  - {'));
  const first = JSON.parse(groupLines[0].replace(/^\s*- /, ''));
  assert.equal(first.name, '11月10日起换新域名, 请更新=订阅');
  assert.deepEqual(first.proxies, ['DIRECT']);
  assert.ok(!clash.includes('MATCH,11月10日'), '没有规则时默认分组不是公告');
  const sb = JSON.parse(renderSubscription({ format: 'singbox', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules: { block: null } }).body);
  assert.deepEqual(sb.outbounds[0], { type: 'selector', tag: '11月10日起换新域名, 请更新=订阅', outbounds: ['direct'] });
  assert.notEqual(sb.route.final, sb.outbounds[0].tag);
  const surge = renderSubscription({ format: 'surge', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules: { block: null } }).body;
  const firstGroup = surge.split('[Proxy Group]\n')[1].split('\n')[0];
  assert.equal(firstGroup, '11月10日起换新域名 请更新 订阅 = select, DIRECT', 'Surge 名字里的逗号等号去掉');
  // 留空
  const none = renderSubscription({ format: 'clash', nodes: resolvedNodes(), ctx: ctxOf(normalizeSettings(settingsWith({}))), ini: INI, rules: { block: null } }).body;
  assert.ok(!none.includes('"proxies":["DIRECT"]}') || !none.split('proxy-groups:')[1].split('\n')[1].includes('"proxies":["DIRECT"]'));
  // 设置：去掉换行，最多 40 字
  assert.equal(normalizeSettings(settingsWith({ sub: { announcement: 'a\nb' + 'c'.repeat(60) } })).sub.announcement.length, 40);
});
