// 地区路由（可选功能，默认关闭）：订阅里只放"地区"条目，真实节点由节点站点在连接时从同一份列表里解析。
// 主站只需知道"有哪些地区"（结构变化很慢），所以列表按 refreshSeconds（默认 30 分钟）缓存 + SWR，不会因为列表高频变化而变更订阅。
import { parseNodeList, DEFAULT_REGION_RE } from '../lib/pool-parse.js';
import { hash32 } from '../lib/rand.js';
import { buildPoolPath } from '../dataplane/pool-route.js';
import { nodeId, makeUniqueNamer } from './nodes.js';

const FETCH_TIMEOUT_MS = 3000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_STALE_MS = 24 * 3600e3;
const FAIL_RETRY_MS = 60e3;
/** 每个地区条目写进路径的种子候选数（见 buildRegionSpecs） */
const SEED_COUNT = 4;
/**
 * 种子：在列表前 SEED_COUNT*3 台里按会合哈希（地区 + 6 小时窗口）挑 SEED_COUNT 台。
 * 不直接取"前 4 台"：VPN Gate 一类列表顺序经常变，种子一变订阅路径就变，客户端更新订阅时会重建代理、断开现有连接。
 * 会合哈希下：窗口内顺序怎么变、窗口外的节点怎么变，种子都不变；只有窗口里进出节点时才可能换掉部分种子。
 */
function pickSeeds(g, window) {
  const pool = g.nodes.slice(0, SEED_COUNT * 3);
  return pool
    .map((n) => ({ n, s: hash32(`seed|${g.region}|${g.kind}|${window}|${n.type}|${n.account}`) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SEED_COUNT)
    .map(({ n }) => [n.type, n.account]);
}

const inflight = new Map();
/** 地区规则：留空 = 自动，使用默认规则（形如 日本-住宅-01）；识别不了的名字再取名称前面的文字（见 pool-parse.extractRegion）。规则会写进订阅路径，节点按它解析 */
export const effectiveRegionRe = (cfg) => (cfg && cfg.regex ? cfg.regex : DEFAULT_REGION_RE);
export const newRegionCache = () => new Map();

async function fetchParsed(url, re, fetchFn) {
  const opt = {};
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchFn(url, opt);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('列表过大');
  return parseNodeList(text, re);
}

function refresh(url, re, { cache, fetchFn, now }) {
  const key = re + '\n' + url;
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchParsed(url, re, fetchFn)
    .then((parsed) => { cache.set(key, { parsed, fetchedAt: now, checkedAt: now, error: null }); return cache.get(key); })
    .catch((e) => {
      const prev = cache.get(key);
      const v = prev ? { ...prev, checkedAt: now, error: String(e?.message || e) } : { parsed: null, fetchedAt: 0, checkedAt: now, error: String(e?.message || e) };
      cache.set(key, v);
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * 读取并合并所有来源，返回地区结构。
 * @returns {Promise<{groups: Map<string,{region:string,kind:string,nodes:object[]}>, entries:{address:string,port:number}[], warnings:string[], total:number, refreshPromise?:Promise<any>}>}
 */
export async function loadRegionStructure({ settings, fetchFn = globalThis.fetch, now = Date.now(), cache = newRegionCache() }) {
  const cfg = settings?.preferred?.regions || {};
  const urls = cfg.urls || [];
  const re = effectiveRegionRe(cfg);
  const ttl = Math.max(60, Number(cfg.refreshSeconds) || 1800) * 1000;
  const warnings = [];
  const background = [];
  const results = await Promise.all(urls.map(async (u) => {
    const key = re + '\n' + u;
    const hit = cache.get(key);
    const usable = !!hit?.parsed && now - hit.fetchedAt <= MAX_STALE_MS;
    const recheck = hit?.error ? Math.min(ttl, FAIL_RETRY_MS) : ttl;
    if (hit && now - hit.checkedAt < recheck) {
      if (usable) return hit;
      warnings.push(`来源失败 ${u}：${hit.error || '无可用缓存'}`);
      return null;
    }
    if (usable) { background.push(refresh(u, re, { cache, fetchFn, now })); return hit; }
    const fresh = await refresh(u, re, { cache, fetchFn, now });
    if (fresh.parsed) return fresh;
    warnings.push(`来源失败 ${u}：${fresh.error}`);
    return null;
  }));
  const groups = new Map();
  const entryMap = new Map();
  let total = 0;
  for (const r of results) {
    if (!r?.parsed) continue;
    total += r.parsed.total;
    for (const [k, g] of r.parsed.groups) {
      const m = groups.get(k);
      if (m) m.nodes = m.nodes.concat(g.nodes); else groups.set(k, { ...g, nodes: g.nodes.slice() });
    }
    for (const e of r.parsed.entries) entryMap.set(e.address, e.port);
  }
  const out = { groups, entries: [...entryMap].map(([address, port]) => ({ address, port })), warnings, total };
  if (background.length) out.refreshPromise = Promise.all(background).then(() => undefined);
  return out;
}

/** 解析 "住宅=家宽" 形式的类型显示名映射 */
export function parseKindNames(list) {
  const m = new Map();
  for (const line of Array.isArray(list) ? list : []) {
    const i = String(line).indexOf('=');
    if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return m;
}

/** 条目名称：模板里 {region}=地区、{kind}=类型显示名；没有类型时只显示地区 */
export function regionLabel(cfg, region, kind) {
  if (!kind) return region;
  const shown = parseKindNames(cfg.kindNames).get(kind) || kind;
  const tpl = String(cfg.nameTemplate || '【{kind}】{region}');
  return tpl.replaceAll('{kind}', shown).replaceAll('{region}', region);
}

/**
 * 生成地区条目（NodeSpec[]）：每个 地区+类型 一个条目，名字如 【家宽】日本。
 * 入口地址（客户端连接的 CF 入口）：优先用列表里自带的入口地址，没有则用 fallbackEntries（通常是随机优选池的地址）。
 * 条目顺序按"类型显示名、地区名"排序，不随节点数变化（否则每次列表变动客户端里的顺序都会跳）。
 * 同一客户端网段在 6 小时内固定到同一入口；不同网段/地区/类型分散到不同入口，避免单入口故障影响所有用户。
 * @param {{settings:object, uuid:string, structure:object, fallbackEntries?:{address:string,port:number}[], ip?:string, now?:number}} o
 */
export function buildRegionSpecs({ settings, uuid, structure, fallbackEntries = [], ip = '', now = Date.now() }) {
  const cfg = settings?.preferred?.regions || {};
  const warnings = [];
  if (!structure.groups.size) return { specs: [], warnings };
  const pool = (structure.entries.length ? structure.entries : fallbackEntries).filter((e) => e?.address);
  if (!pool.length) {
    warnings.push('地区路由：列表里没有入口地址，且没有可用的随机优选地址作为入口');
    return { specs: [], warnings };
  }
  const addrs = pool.slice().sort((a, b) => (a.address < b.address ? -1 : 1));
  const rawIp = String(ip || '').trim();
  const clientKey = rawIp.includes(':') ? rawIp.split(':').slice(0, 4).join(':') : rawIp.split('.').slice(0, 3).join('.');
  const entryWindow = Math.floor(now / (6 * 3600e3));
  const zeroRtt = !!settings?.node?.zeroRtt;
  const nameOf = makeUniqueNamer();
  const specs = [];
  // 类型过滤（如只保留"住宅"）：留空=全部类型
  const kinds = new Set((cfg.kinds || []).map((k) => String(k).trim()).filter(Boolean));
  const kindMap = parseKindNames(cfg.kindNames);
  const shownKind = (g) => kindMap.get(g.kind) || g.kind;
  // 类型顺序：按"类型显示名"设置里的书写顺序（默认 住宅=家宽 在前），其余类型排后；地区按名字固定排序（与节点数无关，列表变动时客户端里的顺序不会跳）
  const order = [...kindMap.keys()];
  const kindRank = (g) => { const i = order.indexOf(g.kind); return i < 0 ? 1e6 : i; };
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const groups = [...structure.groups.values()]
    .filter((g) => !kinds.size || kinds.has(g.kind))
    .sort((a, b) => kindRank(a) - kindRank(b) || cmp(shownKind(a), shownKind(b)) || cmp(a.region, b.region));
  for (const g of groups) {
    const entrySeed = rawIp ? `${clientKey}|${g.region}|${g.kind}|${entryWindow}` : `${g.region}|${g.kind}`;
    const e = addrs[hash32(entrySeed) % addrs.length];
    const data = { u: cfg.urls, r: effectiveRegionRe(cfg), region: g.region, kind: g.kind, i: 0, k: Number(cfg.pickK) || 10, ttl: Number(cfg.ttlSeconds) || 180, sticky: cfg.stickyMinutes ?? 30 };
    // 种子候选：该地区列表前几台直接写进路径。节点站点的新实例（Pages 上很常见）不必先等最长 3 秒拉列表，
    // 拿种子立刻拨号，列表在后台刷新；旧节点忽略这个字段。id 用不含种子的路径算，种子变化不会让条目"换了个节点"
    const seeds = pickSeeds(g, entryWindow);
    const path = buildPoolPath(seeds.length ? { ...data, s: seeds } : data, uuid) + (zeroRtt ? '?ed=2560' : '');
    specs.push({
      id: nodeId({ address: e.address, port: e.port, path: buildPoolPath(data, uuid) }),
      name: nameOf(regionLabel(cfg, g.region, g.kind)),
      origin: 'custom', address: e.address, port: e.port, path, chain: `region://${g.region}${g.kind ? '-' + g.kind : ''}`, tags: ['custom', 'chain', 'region'],
    });
  }
  return { specs, warnings };
}
