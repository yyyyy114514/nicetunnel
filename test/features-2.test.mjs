// 借鉴 cfnew / yonggekkk 的改进：sing-box 1.12+ 写法、链式代理"只走代理"、用户一键导入、家宽客户端链式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSingbox, legacyDnsFor, singboxVersion } from '../src/control/sub/singbox.js';

test('sing-box：默认用 1.12+ 的 DNS 写法；UA 是 1.12 以下才用旧写法', () => {
  const groups = [{ name: '🚀 节点选择', type: 'select', proxies: ['a'] }];
  const outbounds = [{ type: 'vless', tag: 'a', server: '1.1.1.1', server_port: 443 }];
  const fresh = JSON.parse(renderSingbox({ outbounds, groups, rules: null }));
  for (const s of fresh.dns.servers) {
    assert.ok(!('address' in s), '新写法不用 address：' + JSON.stringify(s));
    assert.equal(s.type, 'https');
  }
  assert.equal(fresh.dns.servers.find((s) => s.tag === 'dns-local').detour, undefined, '直连 DNS 不写 detour');
  assert.equal(fresh.dns.servers.find((s) => s.tag === 'dns-remote').detour, '🚀 节点选择');
  assert.equal(fresh.dns.rules, undefined, '不再用 outbound: any 规则');
  assert.deepEqual(fresh.route.default_domain_resolver, { server: 'dns-local' });
  const old = JSON.parse(renderSingbox({ outbounds, groups, rules: null, legacyDns: true }));
  assert.equal(old.dns.servers[0].address, 'https://8.8.8.8/dns-query');
  assert.equal(old.route.default_domain_resolver, undefined);
  assert.equal(legacyDnsFor('SFA/1.11.4 (Android; sing-box 1.11.4)'), true);
  assert.equal(legacyDnsFor('sing-box 1.12.0'), false);
  assert.equal(legacyDnsFor('SFI/1.13.2'), false);
  assert.equal(legacyDnsFor('Mozilla/5.0'), false, '看不出版本按新版');
  assert.deepEqual(singboxVersion('sing-box/1.10.7'), { major: 1, minor: 10 });
});

test('链式代理全局模式：代理连不上就断开，绝不回落直连（出口 IP 不泄漏）', { timeout: 15000 }, async () => {
  const { __forwardTcpForTest: forward } = await import('../src/dataplane/edt-core.js');
  const order = [];
  const sock = () => { const opened = Promise.reject(new Error('refused')); opened.catch(() => {}); const closed = Promise.resolve(); return { opened, readable: new ReadableStream({ start(c) { c.close(); } }), writable: new WritableStream({ write() { throw new Error('refused'); } }), closed, close() {} }; };
  const req = { fetcher: { connect: ({ hostname, port }) => { order.push(hostname + ':' + port); return sock(); } } };
  const ws = { readyState: WebSocket.OPEN, close() {} };
  await assert.rejects(forward('login.example.com', 443, new Uint8Array([1]), ws, null, {}, '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', req,
    { 反代IP: '', 代理类型: 'socks5', 代理全局: true, 代理参数: { hostname: 'proxy.example', port: 1080 }, 反代兜底: false }, false, null, true));
  assert.ok(order.length > 0 && order.every((h) => h.startsWith('proxy.example')), '只连过代理：' + JSON.stringify(order));
});

test('专属订阅落地页：浏览器打开给导入页（按钮 + 二维码），客户端或带 target 参数照常给订阅', async () => {
  const worker = (await import('../src/index.js')).default;
  const { resetStoreState } = await import('../src/control/store.js');
  const { resetPipelineState } = await import('../src/control/pipeline.js');
  const { deriveIdentity, authCookieValue } = await import('../src/control/identity.js');
  const { importLinks } = await import('../src/control/sub/landing.js');
  const { memKV, fakeFetch, settingsWith, TEST_AUTH_KEY } = await import('./helpers.mjs');
  resetStoreState(); resetPipelineState();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try {
    const kv = memKV({ 'nt.settings': settingsWith({ users: { enabled: true } }), 'nt.accounts': [] });
    const env = { KV: kv, ADMIN: 'pw' };
    const id = deriveIdentity(env, 'vp.example.com');
    const cookie = { Cookie: 'auth=' + authCookieValue('Mozilla/5.0', id, { secret: TEST_AUTH_KEY }), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'nt', 'Content-Type': 'application/json' };
    const made = await (await worker.fetch(new Request('https://vp.example.com/admin/api/users/create', { method: 'POST', headers: cookie, body: JSON.stringify({ count: 1, prefix: '客户<b>' }) }), env, { waitUntil() {} })).json();
    const sub = made.created[0].sub;
    const get = (u, ua) => worker.fetch(new Request(u, { headers: { 'User-Agent': ua } }), env, { waitUntil() {} });
    const page = await get(sub, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('clash://install-config?url=' + encodeURIComponent(sub)));
    assert.ok(html.includes('<svg'), '有二维码');
    assert.ok(!html.includes('<b>1') && html.includes('客户'), '名字里的标签不会原样出现');
    // 概览页二维码接口：登录后返回主站订阅的二维码；未登录 401
    const qr = await worker.fetch(new Request('https://vp.example.com/admin/api/sub/qr', { headers: cookie }), env, { waitUntil() {} });
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    assert.ok((await qr.text()).startsWith('<svg'));
    assert.equal((await worker.fetch(new Request('https://vp.example.com/admin/api/sub/qr'), env, { waitUntil() {} })).status, 401);
    assert.ok(!html.includes('<script src'), '不加载外部脚本');
    // 客户端 UA：订阅
    const clash = await get(sub, 'clash.meta/1.19.25');
    assert.ok(!/text\/html/.test(clash.headers.get('content-type') || ''));
    // 浏览器但带了格式参数：订阅
    const raw = await get(sub + '&target=base64', 'Mozilla/5.0');
    assert.ok(!/text\/html/.test(raw.headers.get('content-type') || ''));
    // 导入链接格式
    const links = Object.fromEntries(importLinks('https://x.com/sub?u=a', 'N').map((l) => [l.id, l.href]));
    assert.equal(links.singbox, 'sing-box://import-remote-profile?url=https%3A%2F%2Fx.com%2Fsub%3Fu%3Da#N');
    assert.equal(links.shadowrocket, 'shadowrocket://add/sub://' + btoa('https://x.com/sub?u=a') + '?remark=N');
  } finally { globalThis.fetch = realFetch; }
});
