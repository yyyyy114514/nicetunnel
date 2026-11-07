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

// ---- 家宽（客户端链式）----
const PEM = (t) => `-----BEGIN ${t}-----\nMIIB${t}AAAA\n-----END ${t}-----`;
function vgConfig(proto, ip, port) {
  const pad = Array.from({ length: 60 }, (_, i) => `# comment line ${i} ......................`).join('\n');
  return `${pad}\ndev tun\nproto ${proto}\nremote ${ip} ${port}\ncipher AES-128-CBC\nauth SHA1\nclient\n<ca>\n${PEM('CERTIFICATE')}\n</ca>\n<cert>\n${PEM('CERTIFICATE')}\n</cert>\n<key>\n${PEM('PRIVATE KEY')}\n</key>\n`;
}
function vgCsv() {
  const row = (host, ip, score, cc, op, proto, port) => [host, ip, score, 10, 1e8, 'X', cc, 5, 1000, 100, 1e9, '2weeks', op, '', btoa(vgConfig(proto, ip, port))].join(',');
  return ['*vpn_servers', '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64',
    row('public-vpn-1', '219.100.37.1', 9e6, 'JP', 'Daiyuu Nobori_ Japan. Academic Use Only.', 'tcp', 443),
    row('vpn111', '114.16.18.46', 5e6, 'JP', "someone's PC", 'tcp', 1223),
    row('vpn222', '116.123.14.251', 4e6, 'KR', 'home', 'tcp', 1236),
    row('vpn333', '1.2.3.4', 3e6, 'TH', 'home', 'udp', 1194),
    '*'].join('\r\n');
}

test('家宽：证书取前 3 条投票——排在最前的一台服务器给了别的证书，也不会让所有节点用它', async () => {
  const { parseVpnGate, pickPems } = await import('../src/control/homefeed.js');
  const evil = (cfg) => cfg.replace(`<ca>\n${PEM('CERTIFICATE')}`, `<ca>\n${PEM('EVIL')}`);
  const row = (ip, score, cfg) => ['vpn' + score, ip, score, 10, 1e8, 'X', 'JP', 5, 1000, 100, 1e9, '2weeks', 'home', '', btoa(cfg)].join(',');
  const csv = ['*vpn_servers', '#HostName,...',
    row('9.9.9.9', 9e6, evil(vgConfig('tcp', '9.9.9.9', 443))),
    row('8.8.8.8', 8e6, vgConfig('tcp', '8.8.8.8', 443)),
    row('7.7.7.7', 7e6, vgConfig('tcp', '7.7.7.7', 443)), '*'].join('\r\n');
  const r = parseVpnGate(csv);
  assert.ok(r.pems.ca.includes('BEGIN CERTIFICATE') && !r.pems.ca.includes('EVIL'));
  assert.equal(r.entries.length, 3, '节点本身照常保留（证书不对的那台握手失败，自动选择会绕开）');
  // 三条都不一样：取评分最高的
  assert.equal(pickPems([{ ca: 'a', score: 1 }, { ca: 'b', score: 3 }, { ca: 'c', score: 2 }]).ca, 'b');
  assert.equal(pickPems([]), null);
});

test('家宽：解析 VPN Gate 列表——只留 TCP、去掉自营机房、证书只存一份；Clash 里节点经家宽前置连过去', async () => {
  const { parseVpnGate, addHomeToClash } = await import('../src/control/homefeed.js');
  const r = parseVpnGate(vgCsv(), { max: 10 });
  assert.deepEqual(r.entries.map((e) => e.ip), ['114.16.18.46', '116.123.14.251']);
  assert.equal(r.entries[0].port, 1223);
  assert.ok(r.pems.ca.includes('BEGIN CERTIFICATE') && r.pems.key.includes('PRIVATE KEY'));
  assert.equal(r.cipher, 'AES-128-CBC');
  assert.equal(r.auth, 'SHA1');
  assert.equal(parseVpnGate(vgCsv(), { excludeOfficial: false }).entries.length, 3);
  const proxies = [
    { name: '【家宽】俄罗斯', obj: { name: '【家宽】俄罗斯', type: 'vless', tls: true }, desc: {}, tags: ['region'] },
    { name: 'chain-1', obj: { name: 'chain-1', type: 'vless', tls: true }, desc: {}, tags: ['custom', 'chain'] },
    { name: 'tls-1', obj: { name: 'tls-1', type: 'vless', tls: true }, desc: {}, tags: ['random'] },
    { name: 'plain-1', obj: { name: 'plain-1', type: 'vless', tls: false }, desc: {} },
    { name: 'third', obj: { name: 'third', type: 'trojan', tls: true }, desc: null },
  ];
  const groups = [{ name: '🚀 节点选择', type: 'select', proxies: ['tls-1', 'plain-1'] }];
  const h = addHomeToClash({ ...r, fetchedAt: 1 }, proxies, groups);
  assert.equal(h.added, 2);
  const ov = h.proxies.filter((p) => p.obj.type === 'openvpn');
  assert.deepEqual(ov.map((p) => p.name), ['🏠 JP-01', '🏠 KR-01']);
  assert.equal(ov[0].obj['dialer-proxy'], '🛫 家宽前置');
  assert.equal(ov[0].obj.proto, 'tcp');
  assert.equal(ov[0].obj.udp, false);
  const front = h.groups.find((g) => g.name === '🛫 家宽前置');
  assert.deepEqual(front.proxies, ['tls-1'], '前置只用本项目的普通 TLS 节点（不用地区路由 / 链式 / 明文 / 第三方）');
  assert.equal(front.type, 'url-test', '前置自动选可用节点');
  assert.deepEqual(h.groups[0].proxies.slice(0, 2), ['🏠 家宽自动', '🏠 家宽节点'], '默认走家宽');
  const auto = h.groups.find((g) => g.name === '🏠 家宽自动');
  assert.equal(auto.type, 'url-test', '自动选最快的');
  assert.equal(auto.timeout, 15000);
});

test('家宽订阅：开启后 &target=home 出 Clash（OpenVPN 节点 + 家宽组）；没开 403；列表没准备好 503；Cron 到点刷新', async () => {
  const worker = (await import('../src/index.js')).default;
  const { resetStoreState, createStore } = await import('../src/control/store.js');
  const { resetPipelineState } = await import('../src/control/pipeline.js');
  const { deriveIdentity } = await import('../src/control/identity.js');
  const { runScheduled } = await import('../src/control/cron.js');
  const { HOME_KEY } = await import('../src/control/homefeed.js');
  const { memKV, fakeFetch, settingsWith } = await import('./helpers.mjs');
  const realFetch = globalThis.fetch;
  try {
    resetStoreState(); resetPipelineState();
    globalThis.fetch = fakeFetch({});
    const kv = memKV({ 'nt.settings': settingsWith({ preferred: { home: { enabled: true } } }), 'nt.accounts': [] });
    const env = { KV: kv, ADMIN: 'pw' };
    const id = deriveIdentity(env, 'vp.example.com');
    const get = (q) => worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken + q, { headers: { 'User-Agent': 'clash-verge/v2.2.3' } }), env, { waitUntil() {} });
    assert.equal((await get('&target=home')).status, 503, '列表还没拉到');
    // Cron：到点刷新（从假的 VPN Gate 接口拉）
    const r = await runScheduled({ env, fetchFn: async () => new Response(vgCsv()), now: Date.now() });
    assert.equal(r.maintenance?.ok, true, JSON.stringify(r.maintenance));
    assert.equal(JSON.parse(kv.m.get(HOME_KEY)).entries.length, 2);
    resetStoreState();
    const res = await get('&target=home');
    assert.equal(res.status, 200);
    const yaml = await res.text();
    const ovLines = yaml.split('\n').filter((l) => l.includes('"type":"openvpn"'));
    assert.equal(ovLines.length, 2);
    const ov = JSON.parse(ovLines[0].replace(/^\s*- /, ''));
    assert.equal(ov['dialer-proxy'], '🛫 家宽前置');
    assert.ok(ov.ca.includes('\n'), 'PEM 多行，写成 JSON 转义（YAML 双引号字符串）');
    assert.ok(yaml.includes('"name":"🏠 家宽自动"'));
    // 普通订阅不受影响
    assert.ok(!(await (await get('')).text()).includes('openvpn'));
    // 关掉：403
    kv.m.set('nt.settings', JSON.stringify(settingsWith({ preferred: { home: { enabled: false } } })));
    resetStoreState();
    assert.equal((await get('&target=home')).status, 403);
  } finally { globalThis.fetch = realFetch; }
});

test('家宽订阅遇到不支持的客户端：退回它能用的普通订阅（不含 OpenVPN），响应头写明原因', async () => {
  const worker = (await import('../src/index.js')).default;
  const { resetStoreState } = await import('../src/control/store.js');
  const { resetPipelineState } = await import('../src/control/pipeline.js');
  const { deriveIdentity } = await import('../src/control/identity.js');
  const { HOME_KEY, parseVpnGate, homeClientSupport } = await import('../src/control/homefeed.js');
  const { memKV, fakeFetch, settingsWith } = await import('./helpers.mjs');
  assert.equal(homeClientSupport('mihomo/1.19.25').ok, true);
  assert.equal(homeClientSupport('mihomo/1.19.24').ok, false);
  assert.equal(homeClientSupport('clash-verge/v2.2.3').ok, true, 'UA 不带内核版本的 mihomo 系按支持处理');
  for (const ua of ['SFA/1.12.1 (sing-box 1.12.1)', 'Shadowrocket/2070', 'Stash/3.0.1 Clash/1.11.0', 'v2rayN/7.10', 'ClashforWindows/0.20.39']) assert.equal(homeClientSupport(ua).ok, false, ua);
  const realFetch = globalThis.fetch;
  try {
    resetStoreState(); resetPipelineState();
    globalThis.fetch = fakeFetch({});
    const kv = memKV({ 'nt.settings': settingsWith({ preferred: { home: { enabled: true } } }), 'nt.accounts': [], [HOME_KEY]: { ...parseVpnGate(vgCsv()), fetchedAt: Date.now() } });
    const env = { KV: kv, ADMIN: 'pw' };
    const id = deriveIdentity(env, 'vp.example.com');
    const get = (ua) => worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken + '&target=home', { headers: { 'User-Agent': ua } }), env, { waitUntil() {} });
    const sb = await get('SFA/1.12.1 (sing-box 1.12.1)');
    assert.equal(sb.status, 200);
    assert.match(sb.headers.get('X-NT-Home') || '', /^fallback/);
    const body = await sb.text();
    assert.ok(!body.includes('openvpn'));
    assert.ok(Array.isArray(JSON.parse(body).outbounds), '给的是 sing-box 自己的格式');
    const old = await get('mihomo/1.19.20');
    assert.ok(!(await old.text()).includes('openvpn'), '旧版 mihomo 也退回');
    const ok = await get('clash-verge/v2.2.3');
    assert.equal(ok.headers.get('X-NT-Home'), null);
    assert.ok((await ok.text()).includes('"type":"openvpn"'));
  } finally { globalThis.fetch = realFetch; }
});

test('封禁提示：各格式都是合法配置，只有一个提示节点、规则全直连；浏览器给提示页', async () => {
  const { noticeConfig, noticeHtml } = await import('../src/control/sub/notice.js');
  const msg = '账号已到期，请续费';
  const clash = noticeConfig('clash', msg).body;
  const lines = clash.split('\n');
  const proxy = JSON.parse(lines[lines.indexOf('proxies:') + 1].replace(/^\s*- /, ''));
  assert.equal(proxy.name, '⛔ ' + msg);
  assert.ok(clash.includes('MATCH,DIRECT'), '规则全直连，不断网');
  const sb = JSON.parse(noticeConfig('singbox', msg).body);
  assert.equal(sb.route.final, 'direct');
  assert.ok(sb.outbounds.some((o) => o.tag === '⛔ ' + msg));
  assert.ok(noticeConfig('surge', msg).body.includes('FINAL,DIRECT'));
  assert.ok(decodeURIComponent(atob(noticeConfig('base64', msg).body)).includes(msg));
  assert.ok(!noticeConfig('surge', 'a,b=c\nd').body.includes('a,b=c'), 'Surge 名字里的逗号等号换行被去掉');
  assert.ok(noticeHtml({ siteName: 's', message: '<x>' }).includes('&lt;x&gt;'));
});
