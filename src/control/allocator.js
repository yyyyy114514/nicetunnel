// 额度感知的节点承载域名(host)分配：
//   有效剩余 → 权重 → 加权 rendezvous hashing（-ln(u)/w 取最小）→ maxShare 封顶顺延 → 全部耗尽时兜底。
// 纯函数、确定性；随机性全部来自 hashUnit(seed|slotId|host)。
import { hash32, pairUnit } from '../lib/rand.js';
import { defaultSettings } from './settings.js';
import { usageCfg, usageForToday, nextResetMs } from './usage-core.js';

/** @typedef {import('../types.js').Account} Account */
/** @typedef {import('../types.js').AccountUsage} AccountUsage */
/** @typedef {import('../types.js').HostInfo} HostInfo */
/** @typedef {import('../types.js').UsageSnapshot} UsageSnapshot */

/** 燃烧预测的最长时间窗（分钟） */
export const MAX_PROJECT_MINUTES = 180;
/** 低于预算的该比例视为 low */
export const LOW_RATIO = 0.15;
/** 全部耗尽时兜底使用的 host 数 */
export const FALLBACK_HOSTS = 5;
/** stale 状态的权重折扣 */
export const STALE_FACTOR = 0.5;

let DEFAULTS = null;
const defaults = () => (DEFAULTS ||= defaultSettings());
const allocCfg = (s) => ({ ...defaults().allocation, ...(s?.allocation || {}) });
const hostsCfg = (s) => ({ ...defaults().hosts, ...(s?.hosts || {}) });

/**
 * 计算一个账号的有效剩余额度与状态。
 * - budget = limit*(1-safetyMargin)
 * - remaining = budget - used - rate*min(ageMin + horizonMinutes, 180)
 * - 状态优先级：unknown(从未成功轮询) > exhausted(remaining<=floorRemaining) > stale(最近一次失败或 age>staleMinutes) > low(<15% budget) > ok
 * - weightFactor：exhausted 0、stale 0.5、其余 1（unknown 的权重由 buildHostPool 用中位数决定）
 * usage 若来自之前的 UTC 日会自动按"今日 0 点 used=0"换算。
 * @param {Account} account
 * @param {AccountUsage|undefined} usage
 * @returns {{limit:number, budget:number, used:number, remaining:number, state:'ok'|'low'|'exhausted'|'stale'|'unknown', weightFactor:number, ageMin:number|null, rate:number}}
 */
export function effectiveRemaining(account, usage, settings, now) {
  const cfg = usageCfg(settings);
  // 付费账号没有每日 10 万的硬上限：按 settings.paid.dailyBudget（默认 10M/月 ÷ 30）估算；账号自己填了额度时以账号为准
  const limit = Number(account?.limit) > 0 ? Number(account.limit) : account?.paid ? Number(settings?.paid?.dailyBudget) || 330000 : cfg.limitPerAccount;
  const budget = limit * (1 - cfg.safetyMargin);
  const u = usageForToday(usage, now);
  if (!u || !u.polledAt) return { limit, budget, used: 0, remaining: budget, state: 'unknown', weightFactor: 1, ageMin: null, rate: 0 };
  const used = Number(u.used) || 0;
  const rate = Math.max(0, Number(u.rate) || 0);
  const ageMin = Math.max(0, (now - u.polledAt) / 60000);
  const remaining = budget - used - rate * Math.min(ageMin + cfg.horizonMinutes, MAX_PROJECT_MINUTES);
  let state = 'ok';
  let weightFactor = 1;
  if (remaining <= cfg.floorRemaining) { state = 'exhausted'; weightFactor = 0; }
  else if (u.ok === false || ageMin > cfg.staleMinutes) { state = 'stale'; weightFactor = STALE_FACTOR; }
  else if (remaining < LOW_RATIO * budget) state = 'low';
  return { limit, budget, used, remaining, state, weightFactor, ageMin, rate };
}

/**
 * 节奏因子：按当前燃烧速度，到下一个 UTC 0 点该号会剩多少。
 *   ratio = 有效剩余 / (rate × 距重置分钟数)
 *   ratio>1：照现在的速度到重置时还有剩余 → 加权（多分流量过来，把额度用掉）
 *   ratio<1：照现在的速度会提前耗尽 → 降权（提前分流，避免撞上限后客户端断流）
 * 夹在 [1/paceMax, paceMax]；没有燃烧数据（rate=0，如刚过 0 点或一直没分到流量）按 paceMax，即优先使用闲置号。
 * 所有号的节奏因子都趋于 1 时，说明它们会在重置前同时用到预算——这就是"每个号都用上、不死薅少数号"的平衡点。
 */
export function paceFactor(e, now, paceMax = 4) {
  const max = Math.max(1, Number(paceMax) || 1);
  if (max === 1) return 1;
  const minsLeft = Math.max(30, (nextResetMs(now) - now) / 60000);
  const need = (e.rate || 0) * minsLeft;
  if (need <= 0) return max;
  const ratio = Math.max(0, e.remaining) / need;
  return Math.min(max, Math.max(1 / max, ratio));
}

function median(xs) {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 构建分配用主机池。
 * - 只有 role==='node' 且 enabled 的账号进池；同一账号多个 host 时，账号权重在其 host 间平分（used/budget/remaining 为账号级数值）。
 * - weight = max(0,remaining)^alpha × account.weight × weightFactor ÷ hosts数。
 * - unknown（从未轮询的受管账号）与 settings.hosts.unmanaged 中的裸 host：
 *   weight = unmanagedWeight × 中位数(受管已知账号的 max(0,remaining)^alpha，仅取 >0 的；无则 1)（受管账号再乘 account.weight 并平分）。
 * - usage.enabled=false 时：受管账号一律视为 unknown（按中位数规则即等权）。
 * 输出按 host 名排序（确定性）。
 * @returns {HostInfo[]}
 */
export function buildHostPool({ settings, accounts, snapshot, now }) {
  const ac = allocCfg(settings);
  const alpha = ac.alpha;
  const pace = (e) => (ac.pace ? paceFactor(e, now, ac.paceMax) : 1);
  const hc = hostsCfg(settings);
  const useUsage = usageCfg(settings).enabled;
  const rows = [];
  const seen = new Set();
  for (const a of accounts || []) {
    if (!a || a.role !== 'node' || a.enabled === false || !a.hosts?.length) continue;
    const hosts = a.hosts.filter((h) => h && !seen.has(h));
    if (!hosts.length) continue;
    hosts.forEach((h) => seen.add(h));
    const e = effectiveRemaining(a, useUsage ? snapshot?.accounts?.[a.id] : undefined, settings, now);
    const mult = (Number.isFinite(Number(a.weight)) ? Math.max(0, Number(a.weight)) : 1) / hosts.length;
    rows.push({ a, e, hosts, mult });
  }
  const baseOf = (e) => Math.pow(Math.max(0, e.remaining), alpha) * pace(e);
  const known = rows.filter((r) => r.e.state !== 'unknown' && r.e.weightFactor > 0 && r.e.remaining > 0).map((r) => baseOf(r.e));
  const med = known.length ? median(known) : 1;
  const unknownBase = Math.max(0, Number(hc.unmanagedWeight) || 0) * med;
  /** @type {HostInfo[]} */
  const pool = [];
  for (const { a, e, hosts, mult } of rows) {
    const base = e.state === 'unknown' ? unknownBase : e.state === 'exhausted' ? 0 : baseOf(e) * e.weightFactor;
    const weight = base * mult;
    const pf = e.state === 'unknown' || e.state === 'exhausted' ? null : Math.round(pace(e) * 100) / 100;
    for (const host of hosts) {
      pool.push({ host, accountId: a.id, used: e.used, budget: e.budget, remaining: e.remaining, rate: e.rate, pace: pf, weight: Number.isFinite(weight) ? weight : 0, state: e.state });
    }
  }
  for (const h of hc.unmanaged || []) {
    if (!h || seen.has(h)) continue;
    seen.add(h);
    pool.push({ host: h, accountId: null, used: 0, budget: 0, remaining: 0, weight: unknownBase, state: 'unknown' });
  }
  pool.sort((x, y) => (x.host < y.host ? -1 : x.host > y.host ? 1 : 0));
  return pool;
}

/** 本轮实际参与分配的候选 host 与权重（含兜底与 allocation.enabled=false 的等权） */
export function candidateHosts(pool, settings) {
  const enabled = allocCfg(settings).enabled;
  const list = (pool || []).filter((h) => h && h.host);
  let cand = list.filter((h) => h.weight > 0).map((h) => ({ host: h.host, weight: enabled ? h.weight : 1 }));
  let fallback = false;
  if (!cand.length && list.length) {
    // 全部 weight=0：取剩余最多的前 5 个等权兜底（剩余相同按 host 名）
    fallback = true;
    cand = list
      .slice()
      .sort((x, y) => (y.remaining || 0) - (x.remaining || 0) || (x.host < y.host ? -1 : x.host > y.host ? 1 : 0))
      .slice(0, FALLBACK_HOSTS)
      .map((h) => ({ host: h.host, weight: 1 }));
  }
  cand.sort((x, y) => (x.host < y.host ? -1 : x.host > y.host ? 1 : 0));
  return { cand, fallback };
}

/** 单个 host 的最大 slot 数：max(1, ceil(maxShare*N))，且保证 cap*H ≥ N */
export function shareCap(n, hostCount, maxShare) {
  if (!hostCount) return 0;
  return Math.max(1, Math.ceil(maxShare * n), Math.ceil(n / hostCount));
}

/**
 * 为每个 slot 分配承载 host（加权 rendezvous hashing + maxShare 封顶）。
 * 对 slotIds 顺序处理：每个 slot 按 score=-ln(hashUnit(`${seed}|${slotId}|${host}`))/weight 升序，取第一个未满的 host。
 * 池为空时返回空串。
 * @param {{pool: HostInfo[], slotIds: string[], settings: object, seed: string, now?: number}} p
 * @returns {string[]} 与 slotIds 等长
 */
export function allocateHosts({ pool, slotIds, settings, seed }) {
  const ids = slotIds || [];
  const { cand } = candidateHosts(pool, settings);
  if (!cand.length) return ids.map(() => '');
  const n = ids.length;
  const cap = shareCap(n, cand.length, allocCfg(settings).maxShare);
  const counts = new Array(cand.length).fill(0);
  const out = new Array(n);
  // 每个 host 哈希一次、每个 slot 哈希一次，每一对只做整数混合（pairUnit）
  const hostHash = cand.map((c) => hash32(c.host));
  const invW = cand.map((c) => 1 / c.weight);
  for (let s = 0; s < n; s++) {
    const sh = hash32(seed + '|' + ids[s]);
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < cand.length; i++) {
      if (counts[i] >= cap) continue;
      const score = -Math.log(pairUnit(sh, hostHash[i])) * invW[i];
      if (score < bestScore) { bestScore = score; best = i; }
    }
    counts[best]++;
    out[s] = cand[best].host;
  }
  return out;
}

/**
 * 号池汇总（按账号去重，不按 host 重复计）。unknown 账号按 used=0、remaining=budget 计入预算。
 * resetAt 为下一个 UTC 0 点（毫秒；Subscription-Userinfo 的 expire 需 /1000）。
 * @param {HostInfo[]} pool
 */
export function poolSummary(pool, settings, now) {
  const byAcc = new Map();
  let hostsOk = 0, hostsLow = 0, hostsExhausted = 0, hostsStale = 0, hostsUnknown = 0;
  for (const h of pool || []) {
    if (h.state === 'ok') hostsOk++;
    else if (h.state === 'low') hostsLow++;
    else if (h.state === 'exhausted') hostsExhausted++;
    else if (h.state === 'stale') hostsStale++;
    else hostsUnknown++;
    if (h.accountId && !byAcc.has(h.accountId)) byAcc.set(h.accountId, h);
  }
  let used = 0, budget = 0, remaining = 0;
  for (const h of byAcc.values()) {
    used += h.used || 0;
    budget += h.budget || 0;
    remaining += Math.max(0, h.remaining || 0);
  }
  return {
    used: Math.round(used),
    budget: Math.round(budget),
    remaining: Math.round(remaining),
    total: (pool || []).length,
    accounts: byAcc.size,
    hostsOk, hostsLow, hostsExhausted, hostsStale, hostsUnknown,
    resetAt: nextResetMs(now),
  };
}

/**
 * 后台展示用：每个 host 的期望占比(sharePct, 0~100)。按权重归一，并按 maxShare 做注水封顶（超出部分按权重分给未满者）；
 * 若全部 weight=0 则为兜底的等权占比。实际单次订阅里的数量受 N 取整影响。
 * @param {HostInfo[]} pool
 * @param {object} [settings]
 * @returns {(HostInfo & {sharePct:number, fallback:boolean})[]}
 */
export function explainPool(pool, settings) {
  const { cand, fallback } = candidateHosts(pool, settings);
  const H = cand.length;
  const capFrac = H ? Math.max(allocCfg(settings).maxShare, 1 / H) : 0;
  const share = new Map();
  let free = cand.slice();
  let left = 1;
  // 注水：反复把超过上限的 host 固定在上限，剩余份额按权重分给其余 host
  for (let iter = 0; iter < H && free.length; iter++) {
    const sw = free.reduce((t, c) => t + c.weight, 0);
    const over = free.filter((c) => (c.weight / sw) * left > capFrac + 1e-12);
    if (!over.length) { for (const c of free) share.set(c.host, (c.weight / sw) * left); break; }
    for (const c of over) { share.set(c.host, capFrac); left -= capFrac; }
    free = free.filter((c) => !over.includes(c));
  }
  return (pool || []).map((h) => ({ ...h, sharePct: Math.round((share.get(h.host) || 0) * 10000) / 100, fallback: fallback && share.has(h.host) }));
}

/** 将 IP 规整为分配用前缀：IPv4 → /24（a.b.c.0），IPv6 → /48（前三组），IPv4 映射地址按 IPv4 处理；非法返回 '' */
export function ipPrefix(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) s = mapped[1];
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return v4.slice(1, 4).every((x) => Number(x) <= 255) && Number(v4[4]) <= 255 ? `${Number(v4[1])}.${Number(v4[2])}.${Number(v4[3])}.0/24` : '';
  if (!s.includes(':') || !/^[0-9a-f:.%a-z]+$/.test(s)) return '';
  s = s.split('%')[0];
  const [head, tail] = s.split('::');
  if (s.split('::').length > 2) return '';
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (groups.length < 3 || groups.slice(0, 3).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return '';
  return groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/48';
}

/**
 * 分配种子：`${mode}|${value}|${floor(now/windowMs)}`。
 * ip 模式 value=IP 前缀（IPv4 /24、IPv6 /48）；token 模式 value=token；none 模式 value 固定为 '-'（仍随时间窗轮换）。
 * @param {{mode?:'ip'|'token'|'none', ip?:string, token?:string, now:number, windowMinutes?:number}} p
 */
export function makeSeed({ mode = 'ip', ip, token, now, windowMinutes = 30 }) {
  const windowMs = Math.max(1, Number(windowMinutes) || 30) * 60000;
  const value = mode === 'ip' ? ipPrefix(ip) : mode === 'token' ? String(token || '') : '-';
  return `${mode}|${value}|${Math.floor(now / windowMs)}`;
}

/**
 * 客户端测速策略。默认完全按 INI 里每个组写的间隔（随机优选 300 秒、故障转移 180 秒……）。
 * testIntervalAuto 开启时只做"额度保护"：号池余量低于平均节奏才放慢，余量正常时一律不改。
 *   余量比 h = 号池剩余 / (号池预算 × 今天剩余时间占比)；h=1 表示照平均节奏刚好用到重置。
 *   h ≥ 1 → tight = 0（按 INI）；0.5 < h < 1 → 线性；h ≤ 0.5 → tight = 1（拉到 testIntervalCeil）。
 * 以前的做法是把所有组都拉到至少 600 秒（最长 1800 秒），坏掉或变慢的 CF IP 要 10~30 分钟才被换掉，客户端表现为卡、慢。
 * @returns {{min:number, tight:number, ceil:number}}
 */
export function testPolicy(summary, settings, now) {
  const sub = settings?.sub || {};
  const min = Math.max(0, Number(sub.testIntervalMin) || 0);
  const ceil = Math.max(60, Number(sub.testIntervalCeil) || 1800);
  if (sub.testIntervalAuto === false || !(summary?.budget > 0)) return { min, tight: 0, ceil };
  const left = Math.min(1, Math.max(0.05, ((summary.resetAt || nextResetMs(now)) - now) / 86400e3));
  const h = Math.max(0, summary.remaining) / (summary.budget * left);
  const tight = h >= 1 ? 0 : h <= 0.5 ? 1 : (1 - h) / 0.5;
  return { min, tight: Math.round(tight * 100) / 100, ceil };
}

/** 某个组实际使用的测速间隔（秒）：INI 值 → 按 tight 向 ceil 拉长（取整到 60 秒，订阅内容不会每次都变）→ 不低于 min */
export function groupInterval(iniSeconds, policy) {
  const base = Number(iniSeconds) > 0 ? Number(iniSeconds) : 300;
  const p = policy || { min: 0, tight: 0, ceil: 1800 };
  let sec = base;
  if (p.tight > 0 && p.ceil > base) sec = Math.round((base + (p.ceil - base) * p.tight) / 60) * 60;
  return Math.max(sec, Number(p.min) || 0);
}

/** 节点检测结果的有效期：超过后忽略（节点可能已修好；重新检测即刷新） */
export const HOST_CHECK_TTL_MS = 3 * 86400e3;

/**
 * 把后台"检测节点"的结果用到分配上（检测在浏览器里做，不占节点额度；结果经一次 API 写入 KV）。
 *   - 不可达 / UUID 不符（down / bad）：整个排除，客户端不会再拿到连不上的节点；
 *   - 不支持地区路由（edt 原版、旧数据面：Caps 里没有 pool-route@1）：只从"地区节点"的承载池里排除。
 * 排除后池子为空时回退原池（宁可给可能坏的，也不让订阅没有节点）。未检测过、读不到（cors）的域名照常参与。
 * @param {HostInfo[]} pool
 * @param {{hosts?: Record<string, {s:string, caps?:string[], at:number}>}|null} checks
 * @returns {{pool: HostInfo[], regionPool: HostInfo[], excluded: string[], noRegion: string[]}}
 */
/**
 * 付费域名池（地区条目用）：开通 Workers Paid 的节点账号的域名 + 主站自己（settings.paid.main）。
 * 地区路由的链式连接 CPU 开销大，免费版每请求 10ms 会把连接掐断，付费版 30 秒。
 * 主站的用量取 role=main 账号的轮询数据（有的话），按付费预算算权重，和付费节点账号放在同一尺度上分摊。
 * 后台"检测节点"判为不可达 / UUID 不符 / 不支持地区路由的域名同样排除。
 * @returns {HostInfo[]} 可能为空（没有任何付费域名）
 */
export function buildPaidRegionPool({ settings, accounts, snapshot, now, mainHost = '', checks = null }) {
  const pd = settings?.paid || {};
  const list = (accounts || []).filter((a) => a && a.paid && a.role === 'node' && a.enabled !== false && a.hosts?.length);
  const mainHosts = pd.main ? (pd.mainHosts?.length ? pd.mainHosts : [mainHost].filter(Boolean)) : [];
  const taken = new Set(list.flatMap((a) => a.hosts));
  if (mainHosts.length) {
    const mainAcc = (accounts || []).find((a) => a?.role === 'main');
    list.push({ ...(mainAcc || {}), id: mainAcc?.id || 'main', role: 'node', enabled: true, paid: true, weight: 1, hosts: mainHosts.filter((h) => !taken.has(h)) });
  }
  if (!list.length) return [];
  const pool = buildHostPool({ settings: { ...settings, hosts: { unmanaged: [], unmanagedWeight: 1 } }, accounts: list, snapshot, now })
    .map((h) => ({ ...h, paid: true }));
  const map = checks?.hosts || {};
  const fresh = (c) => c && now - (Number(c.at) || 0) < HOST_CHECK_TTL_MS;
  return pool.filter((h) => {
    const c = map[h.host];
    if (!fresh(c)) return true;
    return !(c.s === 'down' || c.s === 'bad' || c.s === 'edt' || (Array.isArray(c.caps) && !c.caps.includes('pool-route@1')));
  });
}

export function applyHostChecks(pool, checks, now) {
  const map = checks?.hosts || {};
  const fresh = (c) => c && now - (Number(c.at) || 0) < HOST_CHECK_TTL_MS;
  const excluded = [], noRegion = [];
  let kept = (pool || []).filter((h) => {
    const c = map[h.host];
    if (fresh(c) && (c.s === 'down' || c.s === 'bad')) { excluded.push(h.host); return false; }
    return true;
  });
  if (!kept.length) { kept = (pool || []).slice(); excluded.length = 0; }
  let regionPool = kept.filter((h) => {
    const c = map[h.host];
    if (fresh(c) && (c.s === 'edt' || (Array.isArray(c.caps) && !c.caps.includes('pool-route@1')))) { noRegion.push(h.host); return false; }
    return true;
  });
  if (!regionPool.length) { regionPool = kept; noRegion.length = 0; }
  return { pool: kept, regionPool, excluded, noRegion };
}
