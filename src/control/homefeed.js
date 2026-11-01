// 家宽（客户端链式，可选，默认关闭）：思路来自 cfnew 的"家宽链式"。
//
// 链路：客户端 → 本项目的 CF 节点（只是普通 TCP 转发）→ VPN Gate 志愿者的住宅宽带（OpenVPN）→ 目标网站。
// OpenVPN 由客户端（mihomo 1.19.25+ 的 type: openvpn）自己跑，靠 dialer-proxy 把 OpenVPN 的 TCP 连接塞进 CF 节点。
// 和"地区路由"（Worker 里跑 SSTP）相比：Worker 只做普通转发，免费版 10ms CPU 也不会被掐断；代价是只有 mihomo 能用、只走 TCP。
//
// 数据：Cron 每小时拉一次 VPN Gate 公开列表（约 1.3MB，太慢，不能放在订阅热路径），只留 TCP、去掉 VPN Gate 自营的
// 机房服务器，按得分取前 N 个，写进 KV（nt.home）。所有服务器共用同一份 CA / 客户端证书，只存一份。

export const HOME_KEY = 'nt.home';
export const DEFAULT_HOME_SOURCE = 'https://www.vpngate.net/api/iphone/';
const FRONT = '🛫 家宽前置';
const AUTO = '🏠 家宽自动';
const PICK = '🏠 家宽节点';

const pemOf = (cfg, tag) => { const m = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(cfg); return m ? m[1].trim() + '\n' : ''; };
const lineOf = (cfg, key) => { const m = new RegExp(`^${key}\\s+(.+?)\\s*$`, 'm').exec(cfg); return m ? m[1] : ''; };
/** 每条配置只解码这么多 base64 字符（4 的倍数，约 3.6KB 明文） */
const HEAD_B64 = 4800;
const decodeB64 = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return ''; } };
/** OpenVPN 配置是纯 ASCII：atob 的结果直接用，不逐字节转换 */
const asciiB64 = (s) => { try { return atob(s); } catch { return ''; } };

/** mihomo 支持 type: openvpn 的最低版本 */
export const HOME_MIN_MIHOMO = [1, 19, 25];

/**
 * 这个客户端能不能用家宽订阅。不认识 type: openvpn 的客户端拿到家宽配置会整份加载失败（连普通节点也用不了），
 * 所以明确不支持的退回普通订阅。
 * - UA 里写了 mihomo / clash.meta 内核版本：≥ 1.19.25 才支持；
 * - 其它内核的客户端（sing-box、Shadowrocket、Stash、Surge、v2ray 系、Clash Premium 等）：不支持；
 * - 基于 mihomo 但 UA 不带内核版本的（Clash Verge Rev、FlClash、Clash Meta for Android）和认不出的：按支持处理。
 * @returns {{ok:boolean, reason?:string}}
 */
export function homeClientSupport(ua) {
  const s = String(ua || '');
  const v = /(?:mihomo|clash\.meta)[\s/]v?(\d+)\.(\d+)\.(\d+)/i.exec(s);
  if (v) {
    const got = v.slice(1, 4).map(Number);
    for (let i = 0; i < 3; i++) {
      if (got[i] > HOME_MIN_MIHOMO[i]) return { ok: true };
      if (got[i] < HOME_MIN_MIHOMO[i]) return { ok: false, reason: `mihomo ${got.join('.')} 太旧（需要 ${HOME_MIN_MIHOMO.join('.')} 以上）` };
    }
    return { ok: true };
  }
  if (/clash-?verge|flclash|clashmeta|clash\.meta|mihomo|nyanpasu|clashx\.meta/i.test(s)) return { ok: true };
  const other = /sing-?box|\bSF[AIMT]\/|shadowrocket|stash|surge|quantumult|loon|v2ray|nekobox|nekoray|hiddify|karing|streisand|clash-?for-?windows|clashforwindows|clashx(?!\.meta)|^clash\//i.exec(s);
  if (other) return { ok: false, reason: `${other[0]} 不支持 OpenVPN 节点` };
  return { ok: true };
}

/** VPN Gate 自营的机房服务器（不是住宅宽带） */
export const isOfficial = (host, operator) => /^public-vpn-/i.test(host || '') || /Daiyuu Nobori/i.test(operator || '');

/**
 * 解析 VPN Gate 的 CSV（*vpn_servers / #HostName,IP,Score,… / 每行最后一列是 base64 的 OpenVPN 配置）。
 * @returns {{entries:{cc:string, ip:string, port:number, score:number}[], pems:{ca:string, cert:string, key:string}, cipher:string, auth:string}}
 */
export function parseVpnGate(text, { max = 40, excludeOfficial = true } = {}) {
  const entries = [];
  let pems = null, cipher = '', auth = '';
  const s = String(text || '');
  // 免费版 Cron 只有 10ms CPU：不把 1.3MB 文本拆成数组，按位置取字段；每条只解码 base64 的开头
  // （proto / remote 在前约 2.5KB 里），完整解码只做一次（取证书；所有服务器共用同一份 CA 和客户端证书）
  for (let at = 0; at < s.length;) {
    let end = s.indexOf('\n', at);
    if (end < 0) end = s.length;
    const lineStart = at;
    at = end + 1;
    const c0 = s[lineStart];
    if (end - lineStart < 20 || c0 === '*' || c0 === '#') continue;
    // 前 13 列（到 Operator 为止）都很短，只拆这一段；最后一列是 base64 配置
    let cut = lineStart;
    for (let i = 0; i < 13 && cut >= 0; i++) cut = s.indexOf(',', cut + (i ? 1 : 0));
    if (cut < 0 || cut > end) continue;
    const p = s.slice(lineStart, cut).split(',');
    const host = p[0], score = p[2], cc = p[6];
    const lastComma = s.lastIndexOf(',', end);
    if (lastComma <= cut) continue;
    if (excludeOfficial && isOfficial(host, s.slice(cut + 1, Math.min(cut + 120, end)))) continue;
    const b64 = s.slice(lastComma + 1, end).trim();
    const head = asciiB64(b64.slice(0, HEAD_B64));
    if (!/^proto\s+tcp/m.test(head)) continue; // CF 节点只能转发 TCP
    const remote = lineOf(head, 'remote').split(/\s+/);
    const ip = remote[0], port = Number(remote[1]);
    if (!/^[\d.]+$|^[0-9a-f:]+$/i.test(ip || '') || !(port >= 1 && port <= 65535)) continue;
    if (!pems) {
      const cfg = decodeB64(b64);
      pems = { ca: pemOf(cfg, 'ca'), cert: pemOf(cfg, 'cert'), key: pemOf(cfg, 'key') };
      cipher = lineOf(cfg, 'cipher') || 'AES-128-CBC';
      auth = lineOf(cfg, 'auth') || 'SHA1';
      if (!pems.ca) { pems = null; continue; }
    }
    entries.push({ cc: String(cc || '').toUpperCase().slice(0, 2) || '??', ip, port, score: Number(score) || 0 });
  }
  entries.sort((a, b) => b.score - a.score);
  return { entries: entries.slice(0, max), pems: pems || { ca: '', cert: '', key: '' }, cipher, auth };
}

/** Cron：到点了就刷新一次（默认每小时）。拉不到时保留旧数据 */
export async function refreshHome({ store, settings, fetchFn = globalThis.fetch, now = Date.now(), force = false, timeoutMs = 45000 }) {
  const cfg = settings?.preferred?.home;
  if (!cfg?.enabled && !force) return { skipped: '未启用家宽' };
  const old = await store.getJson(HOME_KEY, 0).catch(() => null);
  if (!force && old && now - (old.fetchedAt || 0) < (cfg.refreshMinutes || 60) * 60e3) return { skipped: '未到刷新时间' };
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  let text;
  try {
    const r = await fetchFn(cfg?.sourceUrl || DEFAULT_HOME_SOURCE, { signal: ac?.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (e) {
    return { ok: false, error: '拉取 VPN Gate 列表失败：' + (e?.name === 'AbortError' ? '超时' : String(e?.message || e)).slice(0, 160) };
  } finally { if (timer) clearTimeout(timer); }
  const parsed = parseVpnGate(text, { max: cfg?.maxNodes || 40, excludeOfficial: cfg?.excludeOfficial !== false });
  if (!parsed.entries.length || !parsed.pems.ca) return { ok: false, error: 'VPN Gate 列表里没有可用的 TCP 住宅节点' };
  const data = { ...parsed, fetchedAt: now };
  if (store.kvBound) await store.putJson(HOME_KEY, data, 10 * 60e3);
  return { ok: true, count: parsed.entries.length };
}

/** 订阅热路径：只读 KV（内存缓存 10 分钟） */
export async function loadHome(store) {
  const d = await store.getJson(HOME_KEY, 10 * 60e3).catch(() => null);
  return d && Array.isArray(d.entries) && d.entries.length && d.pems?.ca ? d : null;
}

/**
 * 往 Clash 配置里加家宽：OpenVPN 节点（dialer-proxy 指向"家宽前置"组）+ 三个组；家宽组放到第一个手动选择组的最前面。
 * @param {{entries:any[], pems:any, cipher:string, auth:string}} home
 * @param {{name:string, obj:any, desc?:any}[]} proxies 已渲染的 Clash 节点
 * @param {{name:string, type:string, proxies:string[]}[]} groups
 */
export function addHomeToClash(home, proxies, groups) {
  // 前置只用本项目的普通 TLS 节点：
  // - 不用明文节点：OpenVPN 的握手特征很明显，套在明文节点里等于裸奔；
  // - 不用地区路由 / 链式条目：它们自己要在 Worker 里再跑一层 SSTP，又慢又常挂（实测前置默认选中了一个不通的地区条目，
  //   导致所有家宽节点全部超时）
  const plain = (p) => p.desc && !(p.tags || []).some((t) => t === 'region' || t === 'chain');
  let front = proxies.filter((p) => plain(p) && p.obj?.tls === true).map((p) => p.name);
  if (!front.length) front = proxies.filter(plain).map((p) => p.name);
  if (!front.length) return { proxies, groups, added: 0 };
  const seen = new Map();
  const sorted = home.entries.slice().sort((a, b) => a.cc.localeCompare(b.cc) || b.score - a.score);
  const ovpn = sorted.map((e) => {
    const n = (seen.get(e.cc) || 0) + 1;
    seen.set(e.cc, n);
    const name = `🏠 ${e.cc}-${String(n).padStart(2, '0')}`;
    return {
      name, desc: null,
      obj: { name, type: 'openvpn', server: e.ip, port: e.port, proto: 'tcp', cipher: home.cipher || 'AES-128-CBC', auth: home.auth || 'SHA1', ca: home.pems.ca, cert: home.pems.cert, key: home.pems.key, udp: false, 'dialer-proxy': FRONT },
    };
  });
  const names = ovpn.map((o) => o.name);
  const homeGroups = [
    // 自动选最快的可用节点（故障转移组只挑排在最前面的可用节点，实测会选中 5 秒的而不是 0.5 秒的）；
    // OpenVPN 要多绕一圈握手，测速时限放宽到 10 秒，慢但能用的节点也算进去
    { name: AUTO, type: 'url-test', proxies: names, url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 100, timeout: 10000 },
    { name: PICK, type: 'select', proxies: names },
    // 前置自动选延迟最低的可用节点：手动选择组默认用第一个，那个节点不通时所有家宽节点都会超时
    { name: FRONT, type: 'url-test', proxies: front, url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 },
  ];
  const firstSelect = groups.findIndex((g) => g.type === 'select');
  const next = groups.map((g, i) => (i === firstSelect ? { ...g, proxies: [AUTO, PICK, ...g.proxies.filter((x) => x !== AUTO && x !== PICK)] } : g));
  return { proxies: proxies.concat(ovpn), groups: next.concat(homeGroups), added: ovpn.length };
}
