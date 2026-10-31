import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings, applyPatch, publicSettings, importLegacyEdt, deepMerge, normalizeHost, SCHEMA_VERSION } from '../src/control/settings.js';

test('默认值经 normalize 后保持不变（幂等）', () => {
  const d = defaultSettings();
  assert.deepEqual(normalizeSettings(d), d);
  assert.deepEqual(normalizeSettings(normalizeSettings(d)), d);
  assert.deepEqual(normalizeSettings(undefined), d);
  assert.deepEqual(normalizeSettings('垃圾'), d);
});

test('schema 4：地区路由旧默认值迁移，自定义值与新 schema 保留', () => {
  const old = defaultSettings();
  old.schema = 3;
  Object.assign(old.preferred.regions, { pickK: 5, stickyMinutes: 10, ttlSeconds: 90 });
  const migrated = normalizeSettings(old);
  assert.equal(migrated.schema, SCHEMA_VERSION);
  assert.deepEqual(
    (({ pickK, stickyMinutes, ttlSeconds }) => ({ pickK, stickyMinutes, ttlSeconds }))(migrated.preferred.regions),
    { pickK: 10, stickyMinutes: 30, ttlSeconds: 180 },
  );
  const custom = { schema: 3, preferred: { regions: { pickK: 7, stickyMinutes: 5, ttlSeconds: 60 } } };
  assert.deepEqual(
    (({ pickK, stickyMinutes, ttlSeconds }) => ({ pickK, stickyMinutes, ttlSeconds }))(normalizeSettings(custom).preferred.regions),
    { pickK: 7, stickyMinutes: 5, ttlSeconds: 60 },
  );
  const explicitOldValues = { schema: 4, preferred: { regions: { pickK: 5, stickyMinutes: 10, ttlSeconds: 90 } } };
  assert.deepEqual(
    (({ pickK, stickyMinutes, ttlSeconds }) => ({ pickK, stickyMinutes, ttlSeconds }))(normalizeSettings(explicitOldValues).preferred.regions),
    { pickK: 5, stickyMinutes: 10, ttlSeconds: 90 },
  );
});

test('非法输入被收敛到合法范围/枚举', () => {
  const s = normalizeSettings({
    node: { protocol: 'vmess', transport: 'tcp', path: 'a/b', tlsFragment: 'x' },
    usage: { batchSize: 999, safetyMargin: 5, limitPerAccount: -1, floorRemaining: 1e9 },
    allocation: { maxShare: 0, alpha: 'abc', seedMode: 'weird' },
    preferred: { random: { count: -5, ports: ['443', 'x', 70000, 8443], isp: 'zzz' } },
  });
  assert.equal(s.node.protocol, 'vless');
  assert.equal(s.node.transport, 'ws');
  assert.equal(s.node.path, '/a/b');
  assert.equal(s.node.tlsFragment, null);
  assert.equal(s.usage.batchSize, 45);
  assert.equal(s.usage.safetyMargin, 0.9);
  assert.equal(s.usage.limitPerAccount, 1000);
  assert.ok(s.usage.floorRemaining <= s.usage.limitPerAccount);
  assert.equal(s.allocation.maxShare, 0.02);
  assert.equal(s.allocation.alpha, 1);
  assert.equal(s.allocation.seedMode, 'ip');
  assert.equal(s.preferred.random.count, 0);
  assert.deepEqual(s.preferred.random.ports, [443, 8443]);
  assert.equal(s.preferred.random.isp, 'auto');
});

test('deepMerge：对象合并、数组整体替换、未知键丢弃', () => {
  const base = { a: { x: 1, y: [1, 2] }, b: 2 };
  const out = deepMerge(base, { a: { y: [9] }, c: 3 });
  assert.deepEqual(out, { a: { x: 1, y: [9] }, b: 2 });
  assert.deepEqual(base, { a: { x: 1, y: [1, 2] }, b: 2 }); // 不修改入参
});

test('applyPatch：botToken 空串表示保持不变；publicSettings 脱敏', () => {
  let s = applyPatch(defaultSettings(), { notify: { telegram: { botToken: '123456:ABCDEFGHIJKLMNOP', chatId: '42' } } });
  assert.equal(s.notify.telegram.botToken, '123456:ABCDEFGHIJKLMNOP');
  s = applyPatch(s, { notify: { telegram: { botToken: '', enabled: true } } });
  assert.equal(s.notify.telegram.botToken, '123456:ABCDEFGHIJKLMNOP');
  assert.equal(s.notify.telegram.enabled, true);
  const pub = publicSettings(s);
  assert.notEqual(pub.notify.telegram.botToken, s.notify.telegram.botToken);
  assert.ok(!pub.notify.telegram.botToken.includes('ABCDEFGH'));
});

test('normalizeHost 去协议/路径/端口并小写', () => {
  assert.equal(normalizeHost('HTTPS://VP2.Example.COM:443/x'), 'vp2.example.com');
});

test('站点名：已保存为 edgetunnel（任意大小写）的设置读出时显示为 nicetunnel，其他名字不动', () => {
  for (const n of ['edgetunnel', 'EdgeTunnel', ' edgetunnel ']) assert.equal(normalizeSettings({ site: { name: n } }).site.name, 'nicetunnel');
  assert.equal(normalizeSettings({ site: { name: 'edgetunnel-vip' } }).site.name, 'edgetunnel-vip');
  assert.equal(normalizeSettings({ site: { name: '我的站' } }).site.name, '我的站');
  assert.equal(normalizeSettings({}).site.name, 'nicetunnel');
  // 经过 applyPatch 也一样（后台保存其它设置时不会把旧名字写回去）
  assert.equal(applyPatch({ site: { name: 'edgetunnel' } }, { sub: { udp: true } }).site.name, 'nicetunnel');
});

test('importLegacyEdt：按用户现网配置迁移', () => {
  const hosts = Array.from({ length: 24 }, (_, i) => `vp${i + 2}.example.org`);
  const legacy = {
    UUID: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', HOSTS: hosts, PATH: '/', 协议类型: 'vless', 传输协议: 'ws', Fingerprint: 'chrome', ALPN: '',
    随机路径: true, ECH: true, ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
    优选订阅生成: { local: true, 本地IP库: { 随机IP: true, 随机数量: 16, 指定端口: -1 }, SUB: null, SUBNAME: 'edgetunnel', SUBUpdateTime: 3 },
    订阅转换配置: { SUBAPI: 'https://SUBAPI.cmliussss.net', SUBCONFIG: 'https://raw.githubusercontent.com/yyyyy114514/edgetunnel-misc/main/subconfig2.ini', EXPAND: true },
    反代: { PROXYIP: 'auto', SOCKS5: { 启用: null, 全局: false, 账号: '', 白名单: ['*a.com'] } },
    TG: { 启用: false },
  };
  const s = importLegacyEdt(legacy, { addTxt: 'https://yyyyy114514.github.io/gate/nodes.txt?port=443' });
  assert.deepEqual(s.hosts.unmanaged, hosts);
  assert.equal(s.node.randomPath, true);
  assert.equal(s.node.ech.enabled, true);
  assert.equal(s.node.transport, 'ws');
  assert.equal(s.site.name, 'nicetunnel', '没改过的 edt 默认订阅名 edgetunnel 自动显示为 nicetunnel');
  assert.equal(importLegacyEdt({ ...legacy, 优选订阅生成: { ...legacy.优选订阅生成, SUBNAME: '我的订阅' } }).site.name, '我的订阅', '自己起过的名字保持不变');
  assert.equal(s.sub.updateHours, 3);
  assert.equal(s.preferred.custom.text, 'https://yyyyy114514.github.io/gate/nodes.txt?port=443');
  assert.equal(s.preferred.random.count, 16);
  assert.deepEqual(s.preferred.random.ports, defaultSettings().preferred.random.ports); // 指定端口 -1 → 用默认端口集
  assert.equal(s.rules.mode, 'expand');
  assert.equal(s.rules.configUrl, 'https://raw.githubusercontent.com/yyyyy114514/edgetunnel-misc/main/subconfig2.ini');
  assert.equal(s.proxy.mode, 'proxyip');
  assert.deepEqual(s.proxy.socks5Whitelist, ['*a.com']);
  assert.deepEqual(normalizeSettings(s), s);
});
