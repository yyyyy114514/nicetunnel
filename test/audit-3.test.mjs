// 第三轮审计修复：优选订阅带链式指令（N1）、反代目标记忆误伤非 CF 网站（N2）、端口守卫绕过（N3）、
// 地区正则回溯（N5）、替换字符串特殊序列 / 规则列表缓存键 / cookie 密钥竞态（N6）
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeSpecs } from '../src/control/nodes.js';
import { __forwardTcpForTest as forward, configure } from '../src/dataplane/edt-core.js';
import { outboundPortGuard } from '../src/dataplane/adapter.js';
import { regexRisk, compileRegionRe, DEFAULT_REGION_RE, extractRegion } from '../src/lib/pool-parse.js';
import { unsafeRegex } from '../src/dataplane/pool-route.js';
import { renderSingbox } from '../src/control/sub/singbox.js';
import { listHash } from '../src/control/rulesfeed.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { normalizeSettings } from '../src/control/settings.js';
import { settingsWith, memKV } from './helpers.mjs';

const UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const TLS_HELLO = new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]);
afterEach(() => configure({ connectGuardHook: null }));

test('N1：优选订阅的备注不解析链式指令（不能让第三方把流量改走别人的代理），指令从名字里去掉', () => {
  const settings = settingsWith({});
  const specs = buildNodeSpecs({
    custom: [{ kind: 'addr', address: '104.16.1.1', port: 443, remark: 'HK$socks5://u:p@attacker.example:1080', best: true }],
    random: [], settings, uuid: UUID, deps: { base64SecretEncode: () => 'ENC' },
  });
  assert.equal(specs.length, 1);
  assert.ok(!specs[0].chain);
  assert.ok(!specs[0].path.includes('video'));
  assert.equal(specs[0].name, 'CF-优选-HK');
});

function fakeReq(behave, order) {
  const sock = (kind) => {
    let push;
    const readable = new ReadableStream({ start(c) { push = (b) => c.enqueue(b); } });
    const writable = new WritableStream({ write() { if (kind === 'good') setTimeout(() => push(new Uint8Array([0x16, 0x03, 0x03])), 10); } });
    const err = kind === 'cfdeny' ? new Error('proxy request failed, cannot connect to the specified address') : new Error('refused');
    const opened = kind === 'good' || kind === 'silent' ? Promise.resolve() : Promise.reject(err);
    opened.catch(() => {});
    return { opened, readable, writable, closed: new Promise(() => {}), close() {} };
  };
  return { fetcher: { connect: ({ hostname, port }) => { order.push(hostname + ':' + port); return sock(behave[hostname] || 'refuse'); } } };
}

test('N2：普通的直连失败（被拒 / 超时）不记"需走反代"，下一条连接照常先直连', async () => {
  const order = [];
  const req = fakeReq({ '9.9.9.9': 'good' }, order);
  const go = () => forward('flaky.example', 443, TLS_HELLO, { readyState: WebSocket.OPEN }, null, {}, UUID, req, { 反代IP: '9.9.9.9:443', 代理类型: null, 反代兜底: false }, false, null, true).catch(() => {});
  await go();
  order.length = 0;
  await go();
  assert.ok(order.includes('flaky.example:443'), '第二次仍然先试直连：' + JSON.stringify(order));
});

test('N2：记住的目标走反代失败时，忘掉记录并退回直连（反代兜底关闭时也一样）', async () => {
  const order = [];
  const behave = { 'cf.example': 'cfdeny', '9.9.9.9': 'good' };
  const req = fakeReq(behave, order);
  const go = () => forward('cf.example', 443, TLS_HELLO, { readyState: WebSocket.OPEN }, null, {}, UUID, req, { 反代IP: '9.9.9.9:443', 代理类型: null, 反代兜底: false }, false, null, true).catch(() => {});
  await go(); // 直连被 CF 拒 → 走反代成功 → 记住
  order.length = 0;
  behave['9.9.9.9'] = 'refuse'; // 反代挂了
  behave['cf.example'] = 'good'; // 目标其实能直连
  await go();
  assert.deepEqual(order.filter((h) => h.startsWith('cf.example')).length > 0, true, '反代失败后退回直连：' + JSON.stringify(order));
});

test('N3：链式代理（socks5）的目标端口也过端口守卫：连 25 端口时连接器一次都不调用', async () => {
  configure({ connectGuardHook: outboundPortGuard });
  const order = [];
  const req = fakeReq({}, order);
  await assert.rejects(forward('mail.example', 25, new Uint8Array(0), { readyState: WebSocket.OPEN }, null, {}, UUID, req,
    { 反代IP: '', 代理类型: 'socks5', 代理全局: true, 代理参数: { hostname: 'proxy.example', port: 1080 }, 反代兜底: false }, false, null, true), /blocked/);
  assert.deepEqual(order, []);
});

test('N5：地区正则只认安全子集：分组后加量词、反向引用、过多不限量词都拒绝；默认和常见写法可用', () => {
  for (const bad of ['((a+))+$', '(a|a)+$', '(a+)+$', '(\\d*)*x', '(?:ab|a)*c', '(a)\\1', '.*.*.*.*x', '(x){2,}', 'a'.repeat(201)]) {
    assert.ok(regexRisk(bad), bad);
    assert.ok(unsafeRegex(bad), bad);
    assert.equal(compileRegionRe(bad), null, bad);
  }
  for (const ok of [DEFAULT_REGION_RE, '^([^-]+)-(家宽|机房)?', '^(\\S+?)-(\\S+)','^(.+?)[-_](住宅|机房)(?:-\\d+)?$', '[(]x[)]+']) assert.equal(regexRisk(ok), '', ok);
  // 名称截断：超长名称也只匹配前 96 个字符
  assert.equal(extractRegion('日本-住宅-01' + 'x'.repeat(500), DEFAULT_REGION_RE)?.region, '日本');
  // 主站保存时有风险的正则被清空（回退默认）
  assert.equal(normalizeSettings(settingsWith({ preferred: { regions: { regex: '(a|a)+$' } } })).preferred.regions.regex, '');
});

test('N6：sing-box 规则块里的 $& $$ 原样保留；规则列表缓存键区分格式；cookie 密钥校验失败可重新读 KV', async () => {
  const out = renderSingbox({ outbounds: [], groups: [], rules: { rules: '{"domain":["a$&b$$c"],"outbound":"direct"}' } });
  assert.ok(out.includes('a$&b$$c'), out.slice(-200));
  assert.notEqual(listHash('https://r/x.list', 'surge'), listHash('https://r/x.list', 'clash-domain'));
  resetStoreState();
  const kv = memKV({ 'nt.authkey': 'a'.repeat(64) });
  let t = 1e12;
  const store = createStore({ kv, now: () => t });
  assert.equal(await store.getAuthSecret(), 'a'.repeat(64));
  kv.m.set('nt.authkey', 'b'.repeat(64)); // 另一个实例写赢了
  assert.equal(await store.getAuthSecret(), 'a'.repeat(64), '缓存期内照旧');
  assert.equal(await store.getAuthSecret({ refresh: true }), 'b'.repeat(64));
  assert.equal(await store.getAuthSecret({ refresh: true }), '', '30 秒内不重复刷新');
  t += 31e3;
  assert.equal(await store.getAuthSecret({ refresh: true }), 'b'.repeat(64));
});
