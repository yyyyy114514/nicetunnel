// 后台演示：在浏览器里模拟主站的 /admin/api/*、/admin/check 与各节点的 /version。
// 不连接任何服务器；所有改动只保存在本浏览器的 localStorage。
// 设置清洗、账号合并、额度分配、配置自检直接用项目里的真实模块，所以演示里看到的效果与真后台一致。
import { normalizeSettings, applyPatch, publicSettings } from './src/control/settings.js';
import { normalizeAccounts, mergeAccountsWithStats, publicAccounts, parseAccountsText, importUsagePanelConfig, hasCredentials } from './src/control/accounts.js';
import { buildHostPool, poolSummary, applyHostChecks, buildPaidRegionPool, HOST_CHECK_TTL_MS } from './src/control/allocator.js';
import { selfCheck } from './src/control/selfcheck.js';
import { applyPollResult, emptySnapshot, utcDay } from './src/control/usage.js';
import { DATAPLANE_VERSION, CAPS } from './src/dataplane/contract.js';

const KEY = 'nt.demo.v1';
const UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const MIN = 60e3, HOUR = 3600e3;
const token = (c) => c.repeat(40).slice(0, 40);

// ---------------- 演示数据 ----------------
function seed(now = Date.now()) {
  const settings = normalizeSettings({
    site: { name: 'nicetunnel 演示' },
    preferred: {
      custom: { enabled: true, text: '104.17.1.10:443#日本-住宅-01\n104.18.2.20:443#美国-住宅-01\n104.19.3.30:2053#新加坡-机房-01\nhttps://lists.example.com/gate-nodes.txt' },
      best: { enabled: true, urls: ['https://best.example.com/{isp}.csv'] },
      regions: { enabled: true, urls: ['https://lists.example.com/vpngate.txt'] },
    },
    hosts: { unmanaged: ['extra.example.net'] },
    notify: { telegram: { enabled: true, chatId: '123456789' } }, // 没填 Bot Token：自检会提示
  });
  const acc = (id, name, host, extra = {}) => ({ id, name, hosts: host ? [host] : [], role: 'node', enabled: true, weight: 1, auth: { apiToken: token('d' + id), accountId: (id.charCodeAt(1) % 16).toString(16).repeat(32) }, ...extra });
  const accounts = normalizeAccounts([
    acc('a1', '一号', 'n1.example.com'),
    acc('a2', '二号', 'n2.example.com'),
    acc('a3', '三号（偏低）', 'n3.example.com'),
    acc('a4', '四号（耗尽）', 'n4.example.com'),
    acc('a5', '五号（过期）', 'n5.example.com'),
    acc('a6', '六号（Token 错）', 'n6.example.com'),
    acc('a7', '七号（默认域名）', 'nt-node7.pages.dev', { auth: { apiToken: token('d7') } }), // 没有 Account ID 且自动获取失败：会出现 Account ID 输入框
    acc('a8', '八号（没填凭据）', 'n8.example.com', { auth: {} }),
    acc('a9', '九号（已停用）', 'n9.example.com', { enabled: false }),
    acc('a10', '付费号', 'n10.example.com', { paid: true }),
    { id: 'main', name: '主站', hosts: [], role: 'main', enabled: true, weight: 1, auth: { apiToken: token('dm'), accountId: 'f'.repeat(32) } },
  ]);
  const snap = emptySnapshot(now);
  const ok = (used, rate, agoMin) => ({ used, workers: Math.round(used * 0.8), pages: Math.round(used * 0.2), rate, polledAt: now - agoMin * MIN, triedAt: now - agoMin * MIN, ok: true, err: null, fails: 0, alerted: {} });
  Object.assign(snap.accounts, {
    a1: ok(18200, 28, 4),
    a2: ok(52300, 61, 6),
    a3: ok(83100, 88, 3),
    a4: ok(96800, 120, 2),
    a5: { ...ok(41000, 40, 190) }, // 3 小时没更新 → 过期
    a6: { ...ok(0, 0, 0), polledAt: 0, used: 0, ok: false, err: '查询失败: 400 9106 Authentication failed（已尝试 API Token、Global Key）', errKind: 'auth', fails: 3, triedAt: now - 5 * MIN },
    a7: { ...ok(0, 0, 0), polledAt: 0, used: 0, ok: false, err: '账户获取失败: 403 9109 Unauthorized to access requested resource', errKind: 'auth', fails: 2, triedAt: now - 8 * MIN },
    a10: ok(126000, 95, 5),
    main: ok(9400, 7, 4),
  });
  const logs = [
    { t: now - 2 * MIN, type: 'Admin_Login', ip: '203.0.113.45', loc: 'CN · 广东 · 深圳', msg: '后台登录', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' },
    { t: now - 25 * MIN, type: 'Save_Config', ip: '203.0.113.45', loc: 'CN · 广东 · 深圳', msg: '保存设置：sub.tolerance', ua: 'Mozilla/5.0 Chrome/130' },
    { t: now - 1.5 * HOUR, type: 'Sub_Fetch', ip: '198.51.100.7', loc: 'CN · 上海', msg: '订阅拉取（clash）', ua: 'clash-verge/v2.0.3' },
    { t: now - 3 * HOUR, type: 'Low_Quota', ip: '-', loc: '-', msg: '四号（耗尽）剩余额度低于下限', ua: '' },
    { t: now - 5 * HOUR, type: 'Account_Error', ip: '-', loc: '-', msg: '六号（Token 错）连续 3 次轮询失败', ua: '' },
  ];
  const rules = {
    mode: settings.rules.mode, lastRefreshAt: now - 40 * MIN,
    ini: { url: settings.rules.configUrl, fetchedAt: now - 2 * HOUR, groups: 9, rulesets: 27, bytes: 6420, errors: [] },
    lists: [
      { url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list', ok: true, n: 112, fetchedAt: now - 40 * MIN },
      { url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyGFWlist.list', ok: true, n: 6312, fetchedAt: now - 70 * MIN },
      { url: 'https://example.com/broken-rules.list', ok: false, err: 'HTTP 404', fetchedAt: now - 70 * MIN },
    ],
  };
  return { settings, accounts, usage: snap, hostChecks: null, logs, rules, lastPollAt: 0 };
}

// ---------------- 存取 ----------------
let db;
function load() {
  if (db) return db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { db = null; }
  if (!db || !db.settings) db = seed();
  // 过了 UTC 0 点：用量按新的一天重新造一份（演示里的数字始终是"今天"的）
  if (db.usage?.day !== utcDay(Date.now())) db.usage = seed().usage;
  db.settings = normalizeSettings(db.settings);
  db.accounts = normalizeAccounts(db.accounts);
  return db;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* 隐私模式等：只在内存里 */ } }
export function resetDemo() { db = seed(); save(); }

// ---------------- 接口 ----------------
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (status, error) => json({ ok: false, error }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = () => location.host || 'demo.example.com';
const identity = () => ({ uuid: UUID, uuidSource: 'env', secretKey: 'demo', adminPassword: 'demo-admin-password', hasCustomKey: false, host: host() });

function poolView(now) {
  const pool = buildHostPool({ settings: db.settings, accounts: db.accounts, snapshot: db.usage, now });
  const total = pool.reduce((s, h) => s + Math.max(0, h.weight || 0), 0);
  const hosts = pool.map((h) => ({ host: h.host, accountId: h.accountId, used: h.used, budget: h.budget, remaining: h.remaining, weight: h.weight, state: h.state, rate: h.rate ?? 0, pace: h.pace ?? null, sharePct: total > 0 ? Math.round((Math.max(0, h.weight || 0) / total) * 10000) / 100 : 0 }));
  return { summary: poolSummary(pool, db.settings, now), hosts };
}

function state() {
  const now = Date.now();
  return {
    ok: true, version: '0.1.0', role: 'main', now, uuid: UUID, uuidSource: 'env', build: 'demo',
    dataplane: { version: DATAPLANE_VERSION, caps: CAPS },
    subUrl: `https://${host()}/sub?token=0123456789abcdef0123456789abcdef`,
    host: host(),
    settings: publicSettings(db.settings),
    accounts: publicAccounts(db.accounts),
    usage: db.usage,
    pool: poolView(now),
    kv: { bound: true, writesTodayEstimate: 37 },
    rules: db.rules,
    checks: selfCheck({ settings: db.settings, accounts: db.accounts, usage: db.usage, host: host(), now, kvBound: true, rules: db.rules, identity: identity() }),
  };
}

// 轮询：按账号情况模拟结果（Token 错的继续失败；自动获取 Account ID 失败的，在账号页填上 ID 后就会成功）
function poll(ids) {
  const now = Date.now();
  const wait = db.lastPollAt + 10e3 - now;
  if (wait > 0) return fail(429, `轮询过于频繁，请 ${Math.ceil(wait / 1000)} 秒后再试（真实后台为每分钟 1 次）`);
  db.lastPollAt = now;
  const want = ids?.length ? new Set(ids) : null;
  const polled = [];
  for (const a of db.accounts) {
    if (a.enabled === false || a.role === 'off' || !hasCredentials(a) || (want && !want.has(a.id))) continue;
    const prev = db.usage.accounts[a.id];
    let res;
    if (a.id === 'a6' && a.auth.apiToken === token('da6')) res = { ok: false, error: '查询失败: 400 9106 Authentication failed（已尝试 API Token、Global Key）', kind: 'auth' };
    else if (!a.auth.accountId && !prev?.accountId && a.id === 'a7') res = { ok: false, error: '账户获取失败: 403 9109 Unauthorized to access requested resource', kind: 'auth' };
    else {
      const used = Math.round((prev?.used || 0) + 300 + Math.random() * 2500);
      res = { ok: true, used, workers: Math.round(used * 0.8), pages: Math.round(used * 0.2) };
    }
    db.usage.accounts[a.id] = applyPollResult(prev, res, now);
    polled.push({ id: a.id, ok: res.ok, used: res.used, ...(res.ok ? {} : { error: res.error, kind: res.kind }) });
  }
  db.usage.ts = now;
  save();
  return json({ ok: true, polled, usage: db.usage, pool: poolView(now) });
}

// 预览订阅：按当前（含未保存的）设置造一份节点清单，承载域名按额度权重分摊
function preview(patch) {
  const now = Date.now();
  const s = patch && Object.keys(patch).length ? applyPatch(db.settings, patch) : db.settings;
  // 与真实订阅相同的选域规则：检测判坏的节点不分配；地区条目只给付费域名（有的话）或支持地区路由的节点
  const full = buildHostPool({ settings: s, accounts: db.accounts, snapshot: db.usage, now });
  const { pool: normalPool, regionPool: freeRegion } = applyHostChecks(full, db.hostChecks, now);
  const paid = s.paid?.regionOnly === false ? [] : buildPaidRegionPool({ settings: s, accounts: db.accounts, snapshot: db.usage, now, mainHost: host(), checks: db.hostChecks });
  const picker = (list) => { const pool = list.filter((h) => h.weight > 0); const total = pool.reduce((a, h) => a + h.weight, 0); return (i) => { if (!pool.length) return host(); let x = ((i * 0.6180339887) % 1) * total; for (const h of pool) { if ((x -= h.weight) <= 0) return h.host; } return pool[pool.length - 1].host; }; };
  const pickNormal = picker(normalPool), pickRegion = picker(paid.length ? paid : freeRegion);
  const nodes = [];
  if (s.preferred.regions.enabled) for (const r of ['【家宽】日本', '【家宽】韩国', '【家宽】美国', '【机房】日本']) nodes.push({ name: r, origin: 'custom', region: true, address: '104.16.' + (nodes.length + 1) + '.8', port: 443 });
  if (s.preferred.custom.enabled) for (const l of String(s.preferred.custom.text || '').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('http'))) {
    const [ap, name] = l.split('#'); const [address, port] = ap.split(':');
    nodes.push({ name: name || address, origin: 'custom', address, port: Number(port) || 443 });
  }
  if (s.preferred.best.enabled) for (let i = 0; i < 6; i++) nodes.push({ name: `${s.preferred.best.namePrefix}-${String(i + 1).padStart(2, '0')}`, origin: 'best', address: `172.64.${40 + i}.${(i * 37) % 250 + 2}`, port: 443 });
  if (s.preferred.random.enabled) for (let i = 0; i < s.preferred.random.count; i++) nodes.push({ name: `${s.preferred.random.namePrefix}-电信-${String(i + 1).padStart(2, '0')}`, origin: 'random', address: `104.${16 + (i % 8)}.${(i * 53) % 250}.${(i * 91) % 250 + 2}`, port: i % 2 ? [2053, 2083, 2087, 2096, 8443][i % 5] : 443 });
  const hostShare = {};
  nodes.forEach((n, i) => { n.host = n.region ? pickRegion(i) : pickNormal(i); delete n.region; hostShare[n.host] = (hostShare[n.host] || 0) + 1; });
  return json({ ok: true, nodes, hostShare });
}

function testSource(body) {
  const ms = 80 + Math.round(Math.random() * 400);
  if (body.kind === 'custom') {
    const lines = String(body.text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const links = lines.filter((x) => /^https?:\/\//.test(x));
    return json({ ok: true, count: lines.length - links.length + links.length * 12, ms, warnings: links.length ? [`演示：${links.length} 个远程来源按每个 12 条模拟`] : [], sample: lines.filter((x) => !/^https?:/.test(x)).concat(links.flatMap((u, i) => [`104.21.${i}.11:443#日本-住宅-0${i + 2}`, `104.21.${i}.12:443#韩国-住宅-0${i + 1}`])).slice(0, 20) });
  }
  if (body.kind === 'regions') {
    if (!(body.urls || []).length) return json({ ok: true, regions: [], count: 0, entries: 0, ms, warnings: ['没有填写节点列表 URL'] });
    return json({ ok: true, ms, count: 86, entries: 3, warnings: [], regions: [{ name: '【家宽】日本', nodes: 31 }, { name: '【家宽】韩国', nodes: 18 }, { name: '【家宽】美国', nodes: 22 }, { name: '【机房】日本', nodes: 15 }] });
  }
  if (body.kind === 'cidr') return json({ ok: true, count: 182, ms, warnings: [], sample: ['104.16.0.0/20', '104.17.32.0/20', '104.18.64.0/19', '104.19.128.0/20', '172.64.0.0/18', '172.67.96.0/19'] });
  return json({ ok: true, count: 40, ms, warnings: [], sample: Array.from({ length: 10 }, (_, i) => `172.64.${40 + i}.${(i * 37) % 250 + 2}:443#优选-${body.isp || 'ct'}-${i + 1}`) });
}

function importAccounts(body) {
  let parsed;
  if (body.format === 'usage_panel_json') {
    try { parsed = importUsagePanelConfig(JSON.parse(body.text)); } catch { return fail(400, '用量面板配置不是合法 JSON'); }
  } else parsed = parseAccountsText(body.text || '');
  if (!String(body.text || '').trim()) return fail(400, '导入内容为空');
  const r = mergeAccountsWithStats(db.accounts, parsed.accounts || [], { mode: body.mode === 'replace' ? 'replace' : 'merge' });
  const merged = normalizeAccounts(r.accounts);
  if (body.dryRun === false) { db.accounts = merged; save(); }
  return json({ ok: true, dryRun: body.dryRun !== false, accounts: publicAccounts(merged), errors: parsed.errors || [], added: r.added, updated: r.updated });
}

function reset(body) {
  if (body.confirm !== 'RESET') return fail(400, '需要确认');
  const fresh = seed();
  if (body.scope === 'usage') db.usage = emptySnapshot(Date.now());
  else if (body.scope === 'logs') db.logs = [];
  else if (body.scope === 'settings') db.settings = normalizeSettings({});
  else db = fresh;
  save();
  return json({ ok: true });
}

// 节点 /version：每个演示域名一种检测结果，覆盖检测节点的所有状态
const stats = (conn, extra = {}) => ({ since: 0, upMin: 35 + (conn % 50), ws: conn, post: 0, guardBlocked: 0, authFail: 0, regionErr: 0, chainOk: 0, chainFail: 0, noSocket: 0, fails: 0, recent: [], ...extra });
const NODE = {
  'n1.example.com': { kind: 'ok', st: stats(820, { chainOk: 140, chainFail: 6, fails: 6, recent: [{ ago: 12, m: '[SSTP代理] SSTP server connection timed out' }] }) },
  'n2.example.com': { kind: 'ok', st: stats(431) },
  'n3.example.com': { kind: 'ok', drop: ['pool-seed@1', 'socket-fallback@1'], st: stats(205) },
  'n4.example.com': { kind: 'ok', st: stats(0, { upMin: 0 }) },
  'n5.example.com': { kind: 'edt' },
  'n6.example.com': { kind: 'cors' },
  'nt-node7.pages.dev': { kind: 'ok', socket: { fetcher: false, sockets: true, using: 'sockets' }, st: stats(97, { guardBlocked: 3, authFail: 5 }) },
  'n8.example.com': { kind: 'down' },
  'n10.example.com': { kind: 'ok', st: stats(1290, { chainOk: 412, chainFail: 9 }) },
  'extra.example.net': { kind: 'bad' },
};
async function nodeVersion(u, opts) {
  const h = u.hostname;
  const n = NODE[h] || { kind: 'ok', st: stats(64) };
  await sleep(150 + Math.random() * 700);
  if (n.kind === 'down') throw new TypeError('Failed to fetch');
  if (n.kind === 'cors') { if (opts.mode === 'no-cors') return new Response(null, { status: 200 }); throw new TypeError('Failed to fetch'); }
  if (n.kind === 'bad') return new Response('<!DOCTYPE html><title>Welcome to nginx!</title>', { headers: { 'Content-Type': 'text/html' } });
  if (n.kind === 'edt') return json({ Version: 20261008222327 });
  const caps = CAPS.filter((c) => !(n.drop || []).includes(c));
  return json({ Version: 20261008222327, Dataplane: DATAPLANE_VERSION, Caps: caps, Edition: h === host() ? 'full' : 'node', Build: 'demo', Stats: n.st, Socket: n.socket || { fetcher: true, sockets: false, using: 'fetcher' } });
}

export async function handle(input, opts = {}, realFetch) {
  const u = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.pathname === '/version' && u.host !== location.host) return nodeVersion(u, opts);
  if (u.pathname === '/admin/check') {
    await sleep(500);
    const [[type, value] = []] = [...u.searchParams];
    const good = /1080|8080|443/.test(value || '');
    return json(good ? { success: true, type, proxy: value, ip: '198.51.100.23', loc: 'JP · Tokyo', ms: 186 } : { success: false, type, proxy: value, error: '连接超时（演示）' });
  }
  if (!u.pathname.startsWith('/admin/api/')) return realFetch(input, opts);
  load();
  const path = u.pathname.slice('/admin/api/'.length);
  const body = opts.body ? JSON.parse(opts.body) : {};
  await sleep(120 + Math.random() * 180);
  const route = `${method} ${path}`;
  switch (route) {
    case 'GET state': return json(state());
    case 'PUT settings': db.settings = applyPatch(db.settings, body); save(); return json({ ok: true, settings: publicSettings(db.settings) });
    case 'PUT accounts': {
      const r = mergeAccountsWithStats(db.accounts, body.accounts || [], { mode: body.mode === 'merge' ? 'merge' : 'replace' });
      db.accounts = normalizeAccounts(r.accounts);
      save();
      return json({ ok: true, accounts: publicAccounts(db.accounts) });
    }
    case 'POST accounts/import': return importAccounts(body);
    case 'POST usage/poll': return poll(body.ids);
    case 'POST hosts/checks': {
      const now = Date.now();
      const hosts = {};
      for (const [k, v] of Object.entries(db.hostChecks?.hosts || {})) if (now - v.at < HOST_CHECK_TTL_MS) hosts[k] = v;
      for (const r of body.results || []) hosts[r.host] = { s: r.state, at: now, ...(r.caps ? { caps: r.caps } : {}) };
      db.hostChecks = { at: now, hosts };
      save();
      const excluded = Object.keys(hosts).filter((k) => ['bad', 'down'].includes(hosts[k].s));
      const noRegion = Object.keys(hosts).filter((k) => !excluded.includes(k) && (hosts[k].s === 'edt' || (hosts[k].caps && !hosts[k].caps.includes('pool-route@1'))));
      return json({ ok: true, saved: Object.keys(hosts).length, excluded, noRegion });
    }
    case 'POST preview': return preview(body.settings);
    case 'POST test-source': return testSource(body);
    case 'GET netinfo': return json({ ok: true, ip: '203.0.113.45', prefix: '203.0.113.0/24', country: 'CN', region: 'Guangdong', city: 'Shenzhen', asn: 4134, asOrganization: 'Chinanet', colo: 'HKG', httpProtocol: 'HTTP/2', tlsVersion: 'TLSv1.3', ispName: '电信', adaptiveIspName: '电信', ua: navigator.userAgent });
    case 'POST notify/test': return body.telegram?.botToken || db.settings.notify.telegram.botToken ? json({ ok: true }) : fail(400, '演示：没有填写 Bot Token，无法发送');
    case 'POST rules/ini/fetch': db.rules.ini = { ...db.rules.ini, url: body.url || db.settings.rules.configUrl, fetchedAt: Date.now() }; save(); return json({ ok: true, changed: Math.random() < 0.5, groups: db.rules.ini.groups, rulesets: db.rules.ini.rulesets, rules: { updated: db.rules.lists.filter((l) => l.ok).map((l) => l.url), pending: 0 }, errors: [] });
    case 'POST rules/refresh': {
      const now = Date.now();
      db.rules.lists = db.rules.lists.map((l) => (l.ok ? { ...l, fetchedAt: now } : l));
      db.rules.lastRefreshAt = now;
      save();
      return json({ ok: true, updated: db.rules.lists.filter((l) => l.ok).map((l) => l.url), pending: 0, errors: db.rules.lists.filter((l) => !l.ok).map((l) => `${l.url}：${l.err}`) });
    }
    case 'GET logs': return json({ ok: true, logs: db.logs });
    case 'POST logs/clear': db.logs = []; save(); return json({ ok: true });
    case 'GET export': return json({ ok: true, data: { app: 'nicetunnel-demo', exportedAt: Date.now(), settings: db.settings, accounts: db.accounts } });
    case 'POST import': {
      const d = body.data || {};
      if (d.settings) db.settings = normalizeSettings(d.settings);
      if (d.accounts) db.accounts = normalizeAccounts(d.accounts);
      save();
      return json({ ok: true });
    }
    case 'POST reset': return reset(body);
    default:
      if (method === 'GET' && path.startsWith('logs')) return json({ ok: true, logs: db.logs });
      return fail(404, '演示里没有这个接口：' + route);
  }
}

// 交给页面里的引导脚本：之前排队的请求从这里开始处理
window.__ntDemoReady?.(handle);
window.__ntDemoReset = () => { resetDemo(); location.reload(); };
