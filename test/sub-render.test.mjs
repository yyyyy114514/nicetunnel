import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSubscription, detectFormat, detectFormatInfo, normalizeFormat } from '../src/control/sub/index.js';
import { toProxyDescriptor, splitEarlyData } from '../src/control/sub/params.js';
import { descriptorToLink } from '../src/control/sub/links.js';
import { parseNodeLink } from '../src/control/sub/linkparse.js';
import { parseIni } from '../src/control/sub/ini.js';
import { normalizeSettings } from '../src/control/settings.js';
import { settingsWith, resolvedNodes, UUID } from './helpers.mjs';

const ctxOf = (settings, extra = {}) => ({ uuid: UUID, settings, now: 0, requestUrl: 'https://vp.example.com/sub?token=t', subName: 'nt', userAgent: '', ...extra });

/** 校验我们输出的 Clash YAML：每个列表项都是合法 JSON（流式），组成员/规则引用都存在 */
function checkClash(yaml) {
  const sec = {};
  let cur = null;
  for (const line of yaml.split('\n')) {
    if (/^[a-z-]+:\s*$/.test(line)) { cur = line.slice(0, -1); sec[cur] = []; continue; }
    if (/^[a-z-]+: /.test(line)) { cur = null; continue; }
    if (cur && line.startsWith('  - ')) sec[cur].push(line.slice(4));
    else if (cur === 'rule-providers' && line.startsWith('  ')) sec[cur].push(line.trim());
  }
  const proxies = sec.proxies.map((l) => JSON.parse(l));
  const groups = sec['proxy-groups'].map((l) => JSON.parse(l));
  const names = new Set(proxies.map((p) => p.name));
  assert.equal(names.size, proxies.length, '代理名唯一');
  const all = new Set([...names, ...groups.map((g) => g.name), 'DIRECT', 'REJECT']);
  for (const g of groups) {
    assert.ok(g.proxies.length > 0, `组 ${g.name} 非空`);
    for (const m of g.proxies) assert.ok(all.has(m), `组 ${g.name} 成员 ${m} 存在`);
    if (g.type !== 'select') { assert.equal(g.lazy, true); assert.ok(g.interval > 0); }
  }
  for (const r of sec.rules) {
    const parts = r.split(',');
    const target = parts[0] === 'MATCH' ? parts[1] : parts[parts.length - 1] === 'no-resolve' ? parts[parts.length - 2] : parts[parts.length - 1];
    assert.ok(all.has(target), `规则目标 ${target} 存在：${r}`);
  }
  return { proxies, groups, rules: sec.rules };
}

test('detectFormat：参数与 UA 判定与上游一致', () => {
  const u = (q) => new URL('https://a.com/sub?token=x' + q);
  assert.equal(detectFormat(u(''), 'clash-verge/1.0'), 'clash');
  assert.equal(detectFormat(u(''), 'mihomo'), 'clash');
  assert.equal(detectFormat(u('&clash'), 'v2rayN'), 'clash');
  assert.equal(detectFormat(u(''), 'SFA/1.10 sing-box'), 'singbox');
  assert.equal(detectFormat(u('&sb'), 'x'), 'singbox');
  assert.equal(detectFormat(u(''), 'Surge iOS/2000'), 'surge');
  assert.equal(detectFormat(u(''), 'v2rayN/6.0'), 'base64');
  assert.equal(detectFormat(u(''), 'Mozilla/5.0 Chrome'), 'mixed');
  assert.equal(detectFormat(u('&b64'), 'Mozilla/5.0 clash'), 'base64');
  assert.deepEqual(detectFormatInfo(u(''), 'Quantumult%20X'), { format: 'base64', unsupported: 'quanx' });
  assert.deepEqual(detectFormatInfo(u('&target=loon'), 'x'), { format: 'base64', unsupported: 'loon' });
  assert.equal(normalizeFormat('sb'), 'singbox');
  assert.equal(normalizeFormat('raw'), 'mixed');
});

test('VLESS 分享链接字段与上游 454 行一致', () => {
  const s = settingsWith({ node: { alpn: 'h2,http/1.1' } });
  const d = toProxyDescriptor(resolvedNodes()[0], ctxOf(s));
  const link = descriptorToLink(d);
  assert.equal(link, `vless://${UUID}@1.2.3.4:443?security=tls&type=ws&host=vp2.example.com&fp=chrome&sni=vp2.example.com&path=%2F%3Fed%3D2560&encryption=none&alpn=h2%2Chttp%2F1.1#${encodeURIComponent('日本-住宅-01')}`);
  // IPv6 加方括号
  const d6 = toProxyDescriptor(resolvedNodes()[1], ctxOf(s));
  assert.ok(descriptorToLink(d6).includes('@[2606:4700::1]:2053?'));
});

test('gRPC / XHTTP / ECH / 分片参数', () => {
  const s = settingsWith({ node: { transport: 'grpc', grpcMode: 'multi', ech: { enabled: true, dns: 'https://dns/q', sni: 'ech.com' }, tlsFragment: 'Happ' } });
  const link = descriptorToLink(toProxyDescriptor(resolvedNodes()[0], ctxOf(s)));
  assert.ok(link.includes('type=grpc&mode=multi&ech=' + encodeURIComponent('ech.com+https://dns/q')));
  assert.ok(link.includes('&authority=vp2.example.com') && link.includes('&serviceName=%2F&'));
  assert.ok(link.includes('&fragment=' + encodeURIComponent('3,1,tlshello')));
  const sx = settingsWith({ node: { transport: 'xhttp' } });
  const lx = descriptorToLink(toProxyDescriptor(resolvedNodes()[0], ctxOf(sx)));
  const extra = JSON.parse(decodeURIComponent(lx.match(/extra=([^&]+)/)[1]));
  assert.equal(extra.xPaddingHeader, UUID.slice(1, 7));
  assert.equal(extra.xPaddingKey, '_' + UUID.slice(25, 31));
});

test('SS：非 TLS 端口映射与 v2ray-plugin 参数（上游 443–451）', () => {
  const s = settingsWith({ node: { protocol: 'ss', ss: { method: 'aes-128-gcm', tls: false } } });
  const link = descriptorToLink(toProxyDescriptor(resolvedNodes()[0], ctxOf(s)));
  assert.ok(link.startsWith(`ss://${btoa('aes-128-gcm:' + UUID)}@1.2.3.4:80?plugin=v2ray-plugin`));
  const plugin = decodeURIComponent(link.match(/plugin=([^&#]+)/)[1]);
  assert.equal(plugin, 'v2ray-plugin;mode=websocket;host=vp2.example.com;path=/?enc\\=aes-128-gcm&ed\\=2560;mux=0');
});

test('mixed：其他链接在前；base64 可还原且支持中文', () => {
  const s = settingsWith();
  const plain = renderSubscription({ format: 'mixed', nodes: resolvedNodes(), ctx: ctxOf(s) });
  const lines = plain.body.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('trojan://pw@9.9.9.9'));
  const b = renderSubscription({ format: 'b64', nodes: resolvedNodes(), ctx: ctxOf(s) });
  const dec = new TextDecoder().decode(Uint8Array.from(atob(b.body), (c) => c.charCodeAt(0)));
  assert.equal(dec, plain.body);
});

test('splitEarlyData', () => {
  assert.deepEqual(splitEarlyData('/?ed=2560'), { path: '/', ed: 2560 });
  assert.deepEqual(splitEarlyData('/a?x=1&ed=2560'), { path: '/a?x=1', ed: 2560 });
  assert.deepEqual(splitEarlyData('/a?ed=2560&x=1'), { path: '/a?x=1', ed: 2560 });
  assert.deepEqual(splitEarlyData('/a'), { path: '/a', ed: 0 });
});

test('linkparse：vless / trojan / vmess / ss', () => {
  const v = parseNodeLink('vless://uuid-1@[2606::1]:8443?security=tls&type=grpc&serviceName=svc&sni=a.com&fp=chrome#%E5%90%8D');
  assert.equal(v.server, '2606::1'); assert.equal(v.port, 8443); assert.equal(v.network, 'grpc'); assert.equal(v.serviceName, 'svc'); assert.equal(v.name, '名');
  const vm = parseNodeLink('vmess://' + btoa(JSON.stringify({ ps: 'm', add: 'h.com', port: '443', id: 'u', aid: 0, net: 'ws', path: '/p', host: 'h.com', tls: 'tls' })));
  assert.equal(vm.type, 'vmess'); assert.equal(vm.tls, true); assert.equal(vm.path, '/p');
  const ss = parseNodeLink('ss://' + btoa('aes-256-gcm:pass') + '@1.1.1.1:8388#s1');
  assert.equal(ss.cipher, 'aes-256-gcm'); assert.equal(ss.password, 'pass'); assert.equal(ss.name, 's1');
  const ssp = parseNodeLink('ss://' + btoa('aes-128-gcm:x') + '@1.1.1.1:443?plugin=' + encodeURIComponent('v2ray-plugin;mode=websocket;host=a.com;path=/p;tls') + '#p');
  assert.equal(ssp.network, 'ws'); assert.equal(ssp.tls, true); assert.equal(ssp.host, 'a.com');
  assert.equal(parseNodeLink('garbage'), null);
});

const INI = parseIni([
  'ruleset=🎯 全球直连,[]GEOIP,CN',
  'ruleset=🐟 漏网之鱼,[]FINAL',
  'custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT`.*',
  'custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`60,,50',
  'custom_proxy_group=🏠 家宽`url-test`住宅`http://www.gstatic.com/generate_204`300,,50',
  'custom_proxy_group=🎯 全球直连`select`[]DIRECT`[]🚀 节点选择',
  'custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]🎯 全球直连',
].join('\n'));

test('Clash：合法结构、lazy、测速下限、ECH、0-RTT、链接节点', () => {
  const s = settingsWith({ sub: { testIntervalMin: 600 }, node: { ech: { enabled: true, dns: 'https://dns.alidns.com/dns-query', sni: 'cloudflare-ech.com' } } });
  const rules = { block: { rules: 'GEOIP,CN,🎯 全球直连\nMATCH,🐟 漏网之鱼', providers: [] }, status: 'expand' };
  const out = renderSubscription({ format: 'clash', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules });
  assert.match(out.contentType, /yaml/);
  const { proxies, groups } = checkClash(out.body);
  assert.equal(proxies.length, 3);
  const jp = proxies.find((p) => p.name === '日本-住宅-01');
  assert.equal(jp.type, 'vless'); assert.equal(jp.servername, 'vp2.example.com');
  assert.deepEqual(jp['ws-opts'], { path: '/', headers: { Host: 'vp2.example.com' }, 'max-early-data': 2560, 'early-data-header-name': 'Sec-WebSocket-Protocol' });
  assert.deepEqual(jp['ech-opts'], { enable: true, 'query-server-name': 'cloudflare-ech.com' });
  assert.equal(proxies.find((p) => p.type === 'trojan').password, 'pw');
  assert.equal(groups.find((g) => g.name === '♻️ 自动选择').interval, 600);
  assert.deepEqual(groups.find((g) => g.name === '🏠 家宽').proxies, ['日本-住宅-01']);
  assert.ok(out.body.includes('nameserver-policy:') && out.body.includes('"vp2.example.com": "https://dns.alidns.com/dns-query"'));
});

test('Clash：节点名与组名冲突时改名；规则块缺失时兜底 MATCH', () => {
  const s = settingsWith();
  const nodes = [{ ...resolvedNodes()[0], name: '🚀 节点选择' }];
  const out = renderSubscription({ format: 'clash', nodes, ctx: ctxOf(s), ini: INI, rules: null });
  const { proxies, rules } = checkClash(out.body);
  assert.equal(proxies[0].name, '🚀 节点选择 2');
  assert.equal(rules.length, 1);
});

test('Surge：trojan + ws、MANAGED-CONFIG、名称去逗号', () => {
  const s = settingsWith({ sub: { updateHours: 2 } });
  const nodes = [{ ...resolvedNodes()[0], name: 'a,b=c', path: '/x?y=1,2' }, resolvedNodes()[2]];
  const out = renderSubscription({ format: 'surge', nodes, ctx: ctxOf(s), ini: INI, rules: { block: { rules: 'FINAL,🐟 漏网之鱼' } } });
  const lines = out.body.split('\n');
  assert.equal(lines[0], '#!MANAGED-CONFIG https://vp.example.com/sub?token=t interval=7200 strict=false');
  const p = lines.find((l) => l.startsWith('a b c = trojan'));
  assert.ok(p, out.body);
  assert.ok(p.includes(`password=${UUID}`) && p.includes('ws-path=/x?y=1%2C2') && p.includes('ws-headers=Host:"vp2.example.com"'));
  assert.ok(out.body.includes('🐟 漏网之鱼 = select'));
  assert.ok(out.body.includes('[Rule]\nFINAL,🐟 漏网之鱼'));
});

test('sing-box：合法 JSON、urltest、FINAL 组', () => {
  const s = settingsWith({ node: { transport: 'grpc' } });
  const rules = { block: { rules: '{"domain_suffix":["cn"],"outbound":"🎯 全球直连"}', ruleSets: [], final: '🐟 漏网之鱼' } };
  const out = renderSubscription({ format: 'singbox', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules });
  const j = JSON.parse(out.body);
  const tags = new Set(j.outbounds.map((o) => o.tag));
  for (const o of j.outbounds) for (const m of o.outbounds || []) assert.ok(tags.has(m), `${o.tag} → ${m}`);
  assert.equal(j.route.final, '🐟 漏网之鱼');
  assert.ok(j.route.rules.some((r) => r.outbound === '🎯 全球直连'));
  const v = j.outbounds.find((o) => o.tag === '日本-住宅-01');
  assert.deepEqual(v.transport, { type: 'grpc', service_name: '' });
  assert.equal(j.outbounds.find((o) => o.tag === '♻️ 自动选择').type, 'urltest');
});

test('渲染性能基线：80 节点 + 500KB 规则块 < 15ms', () => {
  const s = settingsWith();
  const nodes = Array.from({ length: 80 }, (_, i) => ({ id: 'n' + i, name: `CF-电信-${i}`, origin: 'random', address: `1.1.${i}.1`, port: 443, path: '/', host: 'vp.example.com' }));
  const big = Array.from({ length: 20000 }, (_, i) => `DOMAIN-SUFFIX,d${i}.example.com,🚀 节点选择`).join('\n');
  const rules = { block: { rules: big + '\nMATCH,🐟 漏网之鱼', providers: [] } };
  renderSubscription({ format: 'clash', nodes, ctx: ctxOf(s), ini: INI, rules });
  // 取多次中的最小值：避免机器此刻忙（刚构建完、GC）造成偶发误报
  let ms = Infinity;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    renderSubscription({ format: 'clash', nodes, ctx: ctxOf(s), ini: INI, rules });
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.ok(ms < 15, `耗时 ${ms.toFixed(2)}ms`);
});

test('测速间隔默认完全按 INI（每组自己的间隔）；设了下限则不低于下限；额度吃紧时按 testPolicy 逐步放慢', () => {
  const dflt = normalizeSettings({});
  assert.equal(dflt.sub.testIntervalMin, 0);
  const render = (format, s) => renderSubscription({ format, nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules: { block: { rules: 'MATCH,🐟 漏网之鱼', providers: [] } } }).body;
  // INI 里 ♻️ 自动选择 写的是 60 秒；🏠 家宽 写的是 300 秒
  const clash = (s) => render('clash', s).split('\n').filter((l) => l.startsWith('  - {"name":') && l.includes('"interval"')).map((l) => JSON.parse(l.slice(4)));
  assert.deepEqual(clash(dflt).map((g) => g.interval), [60, 300], '默认按 INI');
  assert.deepEqual(clash(normalizeSettings({ sub: { testIntervalMin: 1200 } })).map((g) => g.interval), [1200, 1200]);
  const tight = (t) => ({ ...dflt, sub: { ...dflt.sub, testPolicy: { min: 0, tight: t, ceil: 1800 } } });
  assert.deepEqual(clash(tight(1)).map((g) => g.interval), [1800, 1800], '额度很紧：拉到上限');
  assert.deepEqual(clash(tight(0.5)).map((g) => g.interval), [960, 1080], '中间：按各组 INI 值向上限线性拉长');
  assert.deepEqual(clash(tight(0)).map((g) => g.interval), [60, 300]);
  assert.ok(render('surge', dflt).includes('interval=300'));
  assert.ok(render('surge', dflt).includes('interval=60,'));
  const sb = JSON.parse(renderSubscription({ format: 'singbox', nodes: resolvedNodes(), ctx: ctxOf(dflt), ini: INI, rules: { block: { rules: '', ruleSets: [], final: '🐟 漏网之鱼' } } }).body);
  assert.deepEqual(sb.outbounds.filter((o) => o.type === 'urltest').map((o) => o.interval), ['60s', '300s']);
});

test('规则块预缩进（rules.yaml）与逐行处理输出完全一致；Cron 拼装会生成 yaml', async () => {
  const { assembleBlock } = await import('../src/control/rulesfeed.js');
  const s = settingsWith();
  const plain = { rules: 'DOMAIN-SUFFIX,a.com,🎯 全球直连\nGEOIP,CN,🎯 全球直连\nMATCH,🐟 漏网之鱼', providers: [] };
  const withYaml = { ...plain, yaml: '  - ' + plain.rules.split('\n').join('\n  - ') };
  const a = renderSubscription({ format: 'clash', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules: { block: plain } });
  const b = renderSubscription({ format: 'clash', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI, rules: { block: withYaml } });
  assert.equal(a.body, b.body);
  const blk = assembleBlock(INI, 'clash', null, s);
  assert.equal(blk.yaml, '  - ' + blk.rules.split('\n').join('\n  - '));
  assert.equal(assembleBlock(INI, 'surge', null, s).yaml, undefined);
});

test('随机优选聚合：CF 节点只出现在测速组里，手动选择列表里只有那个组；可关闭；无测速组可达时不隐藏', () => {
  const nodes = [
    { id: 'r1', name: 'CF-电信-01', origin: 'random', address: '104.16.1.1', port: 443, path: '/', host: 'vp2.example.com' },
    { id: 'r2', name: 'CF-电信-02', origin: 'random', address: '104.16.2.2', port: 443, path: '/', host: 'vp3.example.com' },
    { id: 'b1', name: 'CF-优选-X', origin: 'best', address: '104.16.3.3', port: 443, path: '/', host: 'vp4.example.com' },
    { id: 'c1', name: '【家宽】日本', origin: 'custom', address: '1.2.3.4', port: 443, path: '/', host: 'vp5.example.com' },
  ];
  const groupsOf = (s, format = 'clash', ini = INI2) => {
    const body = renderSubscription({ format, nodes, ctx: ctxOf(s), ini, rules: { block: { rules: 'MATCH,🐟 漏网之鱼', providers: [] } } }).body;
    return Object.fromEntries(body.split('\n').filter((l) => l.startsWith('  - {"name":') && l.includes('"proxies"')).map((l) => JSON.parse(l.slice(4))).map((g) => [g.name, g.proxies]));
  };
  const INI2 = parseIni([
    'ruleset=🐟 漏网之鱼,[]FINAL',
    'custom_proxy_group=🚀 节点选择`select`[]🎲 随机优选`[]DIRECT`.*',
    'custom_proxy_group=🎲 随机优选`url-test`CF`http://www.gstatic.com/generate_204`300,,50',
    'custom_proxy_group=♻️ 混合`url-test`.*`http://www.gstatic.com/generate_204`300,,50',
    'custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`.*',
  ].join('\n'));
  const on = groupsOf(settingsWith());
  assert.deepEqual(on['🚀 节点选择'], ['🎲 随机优选', 'DIRECT', '【家宽】日本'], '手动选择里只有一个随机优选组 + 非 CF 节点');
  assert.deepEqual(on['🎲 随机优选'], ['CF-电信-01', 'CF-电信-02', 'CF-优选-X'], '测速组里仍有全部 CF 节点');
  assert.equal(on['♻️ 混合'].length, 4, '其它测速组不受影响');
  assert.deepEqual(on['🐟 漏网之鱼'], ['🚀 节点选择', '【家宽】日本']);
  const off = groupsOf(settingsWith({ preferred: { random: { aggregate: false } } }));
  assert.equal(off['🚀 节点选择'].length, 6, '关闭聚合：逐个列出');
  // 保护：INI 里没有任何测速组能到达 CF 节点 → 不隐藏，否则选不到
  const onlySelect = parseIni('ruleset=🐟 漏网之鱼,[]FINAL\ncustom_proxy_group=🐟 漏网之鱼`select`.*');
  assert.equal(groupsOf(settingsWith(), 'clash', onlySelect)['🐟 漏网之鱼'].length, 4);
  // Surge / sing-box 同样生效
  const sb = JSON.parse(renderSubscription({ format: 'singbox', nodes, ctx: ctxOf(settingsWith()), ini: INI2, rules: { block: { rules: '', ruleSets: [], final: '🐟 漏网之鱼' } } }).body);
  assert.deepEqual(sb.outbounds.find((o) => o.tag === '🚀 节点选择').outbounds, ['🎲 随机优选', 'direct', '【家宽】日本']);
  const sg = renderSubscription({ format: 'surge', nodes, ctx: ctxOf(settingsWith()), ini: INI2, rules: { block: { rules: 'FINAL,🐟 漏网之鱼' } } }).body;
  assert.ok(sg.includes('🚀 节点选择 = select, 🎲 随机优选, DIRECT, 【家宽】日本'));
});

test('url-test 默认容差 50ms：INI 没写才补；设为 0 不加', () => {
  const INI3 = parseIni(['ruleset=🐟 漏网之鱼,[]FINAL','custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`60','custom_proxy_group=🐟 漏网之鱼`select`[]♻️ 自动选择`[]DIRECT'].join('\n'));
  const render = (s) => renderSubscription({ format: 'clash', nodes: resolvedNodes(), ctx: ctxOf(s), ini: INI3, rules: { block: { rules: 'MATCH,🐟 漏网之鱼', providers: [] } } }).body;
  const groups = (s) => render(s).split('\n').filter((l) => l.startsWith('  - {"name":') && l.includes('"interval"')).map((l) => JSON.parse(l.slice(4)));
  const on = groups(normalizeSettings({}));
  assert.ok(on.some((g) => g.type === 'url-test' && g.tolerance === 50));
  assert.ok(groups(normalizeSettings({ sub: { tolerance: 0 } })).every((g) => g.tolerance === undefined));
  assert.ok(groups(normalizeSettings({})).every((g) => g.type !== 'url-test' || g.tolerance === 50));
});
