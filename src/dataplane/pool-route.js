// 地区路由：订阅里只放"地区"条目（如 日本、韩国），真正连哪台链式代理在连接建立时才决定。
//
// 订阅里的路径是 /video/<密文>，密文解开是 {type:'pool', u:[列表URL…], r:地区正则, region, kind, i, k, ttl, sticky}。
// 节点站点收到连接后：读取列表（isolate 内存缓存，默认 90 秒，多个 URL 并行读取后合并），挑出该地区当前的候选节点，
// 按"客户端 IP 段 + 时间桶"在前 k 台里分摊（同一用户一段时间内稳定、不同用户分散到不同节点，避免把单台节点压垮），
// 然后把路径改写成上游 edt 认识的 {type, hostname, port, username, password} 链式代理路径，交给上游代码处理。
// 订阅内容只在"地区集合"变化时才需要更新，不必跟着节点列表高频变化（对节点寿命很短的来源尤其有用）。
// 同时省额度：订阅里条目少 → 客户端测速（每节点 1 次请求）成倍减少。
import { base64SecretEncode, base64SecretDecode, parseChainAccount, defaultChainPort } from './edt-core.js';
import { hash32 } from '../lib/rand.js';
import { parseNodeList } from '../lib/pool-parse.js';
import { POOL_ROUTE_V } from './contract.js';

export const POOL_TYPE = 'pool';
const FETCH_TIMEOUT_MS = 3000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_STALE_MS = 6 * 3600e3;
/** 一次连接最多带上几台故障转移候选（再多只是让密文变长，收益很小） */
const MAX_FAILOVER_CANDIDATES = 4;
/** 新实例等列表的上限：超过就先用路径里的种子拨号（见 resolvePoolRoute） */
const SEED_WAIT_MS = 800;

// ---- isolate 级缓存 ----
const cache = new Map(); // `${re}\n${url}` -> {parsed, at}
const inflight = new Map();
// 每个列表 URL 的拉取策略状态：内容指纹、TTL 倍数、连续失败次数、退避截止时间
const meta = new Map();
const TTL_MAX_MULT = 8;            // 列表长期不变时，TTL 最多放大到基线的 8 倍（180s → 24min）
const BACKOFF_MAX_MS = 15 * 60e3;  // 拉取失败的最长退避
// 链路健康缓存（isolate 级）：`host:port` -> { ok?:ts, fail?:ts }。
// edt-core 的链式拨号成功/失败时经 configure({chainResultHook}) 上报到这里；
// pick() 用它把候选分成「近期成功 > 未知 > 近期失败」三档，失败的节点在冷却期内被跳过。
// 只在单个 isolate 内生效：这是设计内的折衷——节点站点刻意不绑 KV，跨 isolate 的健康态
// 通过"客户端重连散布到不同 isolate、各自标记"收敛，通常几秒内就能绕开死节点。
const health = new Map();
const HEALTH_BAD_MS = 5 * 60e3;  // 拨号失败后的冷却期：期内该节点排到最后
const HEALTH_GOOD_MS = 10 * 60e3; // 成功记录的有效期：期内该节点排到最前
const HEALTH_MAX = 256;
export function resetPoolRouteState() { cache.clear(); inflight.clear(); health.clear(); meta.clear(); }

/** 链路拨号结果上报（由 adapter 经 configure 注入到 edt-core；也可直接调用，便于测试） */
export function reportChainResult(ok, hostname, port, now = Date.now()) {
  if (!hostname) return;
  const key = String(hostname).toLowerCase().replace(/^\[|\]$/g, '') + '|' + Number(port || 0);
  let h = health.get(key);
  if (!h) {
    if (health.size >= HEALTH_MAX) {
      // 上限保护：删掉最旧的一条（按 ok/fail 里较新者比较）
      let oldest = null;
      for (const [k, v] of health) {
        const t = Math.max(v.ok || 0, v.fail || 0);
        if (!oldest || t < oldest.t) oldest = { k, t };
      }
      if (oldest) health.delete(oldest.k);
    }
    h = {};
    health.set(key, h);
  }
  if (ok) h.ok = now; else h.fail = now;
}

/** 候选的健康键（host:port）；解析失败返回 null（按未知处理） */
function chainHealthKey(c) {
  try {
    const { hostname, port } = parseChainAccount(c.account, defaultChainPort(c.type));
    if (!hostname) return null;
    return String(hostname).toLowerCase().replace(/^\[|\]$/g, '') + '|' + Number(port || 0);
  } catch { return null; }
}

async function fetchList(url, re, fetchFn) {
  const opt = {};
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchFn(url, opt);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('列表过大');
  return parseNodeList(text, re);
}

/** 取一个 URL 的解析结果：未过期直接用；过期则刷新（并发去重），刷新失败回退旧值（最长 6 小时） */
export async function getList(url, re, { fetchFn = globalThis.fetch, now = Date.now(), ttlSeconds = 180 } = {}) {
  const key = re + '\n' + url;
  // 每个 URL 的 TTL 加最多 ±20% 的固定抖动：很多实例不会在同一秒一起去拉
  const base = Math.max(15, ttlSeconds) * 1000 * (1 + ((hash32(url) % 41) - 20) / 100);
  let st = meta.get(key);
  if (!st) { st = { sig: '', mult: 1, fails: 0, nextAt: 0 }; meta.set(key, st); }
  const hit = cache.get(key);
  if (hit && now - hit.at < base * st.mult) return hit.parsed;
  // 失败退避期内不再外拉：有旧值就用旧值，没有才报错。
  // 节点站点每次外拉都是一个可被观察的出站请求，退避能同时省额度、降低"周期性外联"这个指纹。
  if (st.nextAt && now < st.nextAt) {
    if (hit && now - hit.at < MAX_STALE_MS) return hit.parsed;
    throw new Error('列表刷新退避中');
  }
  let p = inflight.get(key);
  if (!p) {
    p = fetchList(url, re, fetchFn)
      .then((parsed) => {
        const sig = listSig(parsed);
        st.fails = 0; st.nextAt = 0;
        // 列表内容没变就逐步拉长 TTL（拉取次数指数式下降）；一变立刻回到基准，保证节点新鲜度
        st.mult = (st.sig && st.sig === sig) ? Math.min(TTL_MAX_MULT, st.mult * 2) : 1;
        st.sig = sig;
        cache.set(key, { parsed, at: now });
        if (cache.size > 24) cache.delete(cache.keys().next().value);
        return parsed;
      })
      .catch((e) => {
        st.fails++;
        // 没有旧值可兜底时要尽快重试（否则新 isolate 会因为一次抖动锁死几分钟）；
        // 有旧值在手上就慢慢退避，避免对源站反复外拉。
        const 退避基数 = hit ? base : Math.min(base, 15e3);
        st.nextAt = now + Math.min(BACKOFF_MAX_MS, 退避基数 * Math.pow(2, st.fails - 1));
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  // 过期不久的旧值直接用、后台刷新（stale-while-revalidate）：不让"恰好碰上 TTL 到期"的那次连接
  // 卡在拉列表上（最长 3 秒，客户端测速会显示超时）。太旧（超过 3 个 TTL）才同步等待新列表。
  if (hit && now - hit.at < base * st.mult * 3) {
    p.catch(() => {});
    return hit.parsed;
  }
  try { return await p; } catch (e) {
    if (hit && now - hit.at < MAX_STALE_MS) return hit.parsed;
    throw e;
  }
}

/** 本 isolate 是否已缓存过其中任一列表（没有 = 新实例，拉列表要同步等待） */
export function hasCachedList(urls, re) {
  return urls.some((u) => cache.has(re + '\n' + u));
}

/** 列表内容指纹：地区集合 + 每地区节点数 + 每地区首节点。用于判断"内容没变"以便拉长 TTL */
function listSig(parsed) {
  const parts = [];
  for (const [k, g] of parsed.groups) parts.push(`${k}=${g.nodes.length}:${g.nodes[0]?.account || ''}`);
  return parts.sort().join(';').slice(0, 4096);
}

/** 多个 URL 合并（顺序=URL 顺序；某个 URL 失败只要还有别的可用就忽略） */
export async function getGroups(urls, re, opts) {
  const results = await Promise.allSettled(urls.map((u) => getList(u, re, opts)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw results[0]?.reason || new Error('没有可用的列表');
  const merged = new Map();
  for (const p of ok) {
    for (const [k, g] of p.groups) {
      const m = merged.get(k);
      if (m) m.nodes = m.nodes.concat(g.nodes); else merged.set(k, { ...g, nodes: g.nodes.slice() });
    }
  }
  return merged;
}

/** 客户端 IP 的分摊键：IPv4 取 /24，IPv6 取前三组 */
export function ipKey(ip) {
  const s = String(ip || '').trim();
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':');
  return s.split('.').slice(0, 3).join('.');
}

const PROTO_RANK = { socks5: 0, http: 0, https: 1, sstp: 2, turn: 3 };
/** 协议质量：同类健康状态下优先握手最轻、最稳的协议（列表里的 sstp/turn 最易超时，排后面） */
function protoRank(c) {
  const r = PROTO_RANK[String(c?.type || '').toLowerCase()];
  return r === undefined ? 1 : r;
}

/** 健康分区：近期成功 > 未知 > 近期失败；每层内部先按协议质量、再保持列表顺序（列表通常已按延迟排好） */
function rankWindow(list, now) {
  const good = [], unknown = [], bad = [];
  const okAt = new Map();
  for (const c of list) {
    const hk = chainHealthKey(c);
    const h = hk ? health.get(hk) : null;
    if (!h) unknown.push(c);
    else if (h.fail && now - h.fail < HEALTH_BAD_MS && (!h.ok || h.fail > h.ok)) bad.push(c);
    else if (h.ok && now - h.ok < HEALTH_GOOD_MS && (!h.fail || h.ok > h.fail)) { good.push(c); okAt.set(c, h.ok); }
    else unknown.push(c);
  }
  good.sort((a, b) => (okAt.get(b) || 0) - (okAt.get(a) || 0));
  const byProto = (a, b) => protoRank(a) - protoRank(b); // sort 稳定：同协议保持列表原有顺序
  unknown.sort(byProto);
  bad.sort(byProto);
  return { good, unknown, bad };
}

/**
 * 候选排序（与客户端无关的部分）：按「健康 → 协议质量 → 列表顺序」排好候选窗口。
 * 前 k 台全处于失败冷却期时把窗口扩大一倍，让"还没试过"的候选排到失败者前面。
 */
export function rankCandidates(cands, { k = 10, now = Date.now() } = {}) {
  const maxK = Math.max(1, k);
  let top = cands.slice(0, maxK);
  let parts = rankWindow(top, now);
  if (!parts.good.length && !parts.unknown.length && parts.bad.length && cands.length > top.length) {
    top = cands.slice(0, Math.min(cands.length, maxK * 2));
    parts = rankWindow(top, now);
  }
  // 只在当前最高优先级的一层里选，不能让取模又落回已知失败节点。
  // 没有健康记录时 unknown 就是完整候选窗口，保持旧版的确定性分散行为。
  const eligible = parts.good.length ? parts.good : parts.unknown.length ? parts.unknown : parts.bad;
  return { eligible, ordered: parts.good.concat(parts.unknown, parts.bad) };
}

/**
 * 在候选里挑一台：先按 rankCandidates 排好（近期成功 > 未知 > 近期失败、同类优先更稳协议），
 * 再用会合哈希在"最高优先级那一层"里选；sticky=0 时每次连接随机。
 * 条目序号 i 会错开选择，同一用户的多个同地区条目不会落到同一台。
 */
export function pick(cands, { k = 10, i = 0, sticky = 30, ip = '', now = Date.now(), key = '' } = {}) {
  const { eligible } = rankCandidates(cands, { k, now });
  if (!eligible.length) return null;
  if (sticky <= 0) return eligible[Math.floor(Math.random() * eligible.length)];
  // 会合哈希（rendezvous）：每台候选按 hash(客户端段, 条目序号, 地区, 节点自身标识) 打分取最高。
  // 列表增减或顺序变化时，只有"被移走的那台"的用户会换节点，其余用户不动；
  // 旧版按下标取模，列表一变几乎所有用户同时换节点（客户端表现为一起断线重连）。
  // 时间桶按客户端段错开相位，不再所有用户在同一分钟整体切换。
  const span = sticky * 60e3;
  const phase = hash32('phase|' + ipKey(ip)) % span;
  const bucket = Math.floor((now + phase) / span);
  const seed = `${ipKey(ip)}|${bucket}|${key}|${i}|`;
  let best = null, bestScore = -1;
  for (let n = 0; n < eligible.length; n++) {
    const c = eligible[n];
    const id = c.account ? `${c.type}|${c.account}` : String(n);
    const score = hash32(seed + id);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** 构造订阅里的地区路由路径（主站用；与 resolvePoolRoute 对称） */
export function buildPoolPath(data, uuid) {
  return '/video/' + base64SecretEncode(JSON.stringify({ type: POOL_TYPE, v: POOL_ROUTE_V, ...data }), uuid);
}

/**
 * 若路径是地区路由，则解析并改写成上游认识的链式代理路径。
 * @returns {Promise<{url: URL, routed: boolean, error?: string}>}
 */
export async function resolvePoolRoute(url, uuid, { ip = '', fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  const m = url.pathname.match(/\/video\/(.+)$/i);
  if (!m) return { url, routed: false };
  let data;
  try { data = JSON.parse(base64SecretDecode(m[1].replace(/\/+$/, ''), uuid)); } catch { return { url, routed: false }; }
  if (data?.type !== POOL_TYPE) return { url, routed: false };
  // 契约：路径明文的 v 比本节点支持的更高 → 明确提示更新节点，而不是静默连错；未知字段一律忽略（向前兼容）
  if ((Number(data.v) || 1) > POOL_ROUTE_V) return { url, routed: true, error: '节点站点版本过旧，请更新节点 _worker.js（需要地区路由 v' + data.v + '）' };
  const urls = (Array.isArray(data.u) ? data.u : []).filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length || !data.region) return { url, routed: true, error: '地区路由参数无效' };

  const key = `${data.region}|${data.kind || ''}`;
  const re = data.r || '';
  const listOpts = { fetchFn, now, ttlSeconds: Number(data.ttl) || 180 };
  // 种子候选（主站生成订阅时写进路径的该地区前几台）：本实例还没缓存过任何一个列表时直接用种子拨号，
  // 列表在后台拉（下一条连接就有完整列表）。原先新实例要先等最长 3 秒拉列表，再加上 VPN 握手，客户端测速常常直接超时
  const seeds = (Array.isArray(data.s) ? data.s : []).filter((x) => Array.isArray(x) && x[0] && x[1]).map(([type, account]) => ({ type: String(type).toLowerCase(), account: String(account) }));
  let cands;
  if (seeds.length && !hasCachedList(urls, re)) {
    // 列表 SEED_WAIT_MS 内回来就用列表（最新），否则（慢 / 失败）用种子先拨，列表继续在后台拉
    const p = getGroups(urls, re, listOpts);
    p.catch(() => {});
    let timer;
    const groups = await Promise.race([p, new Promise((r) => { timer = setTimeout(r, SEED_WAIT_MS, null); })]).catch(() => null);
    clearTimeout(timer);
    // 列表按时回来了就以列表为准（地区已下线就照实报错，不去拨大概率也已失效的种子）
    cands = groups ? groups.get(key)?.nodes : seeds;
  } else {
    let groups;
    try { groups = await getGroups(urls, re, listOpts); } catch (e) {
      // 列表拉不到、也没有旧值：有种子就用种子顶上
      if (!seeds.length) return { url, routed: true, error: '节点列表不可用：' + (e?.message || e) };
    }
    cands = groups ? groups.get(key)?.nodes : seeds;
  }
  if (!cands?.length) return { url, routed: true, error: `地区「${data.region}」暂无可用节点` };
  const k = Number(data.k) || 10;
  const c = pick(cands, { k, i: Number(data.i) || 0, sticky: data.sticky === undefined ? 30 : Number(data.sticky), ip, now, key });
  if (!c) return { url, routed: true, error: `地区「${data.region}」暂无可用节点` };
  // 故障转移候选：选中的这台排第一，其余按同样的「健康 → 协议质量 → 列表顺序」跟在后面，
  // 传给数据面后一旦拨号失败会自动换下一台重试，客户端不再表现为"突然断连"。
  const { ordered } = rankCandidates(cands, { k, now });
  const 候选链 = [];
  const 已用 = new Set();
  for (const n of [c, ...ordered]) {
    if (!n || 候选链.length >= MAX_FAILOVER_CANDIDATES) continue;
    let 链;
    try { 链 = { type: n.type, ...parseChainAccount(n.account, defaultChainPort(n.type)) }; } catch { continue; }
    if (!链.hostname || !链.port) continue;
    const id = `${链.type}|${String(链.hostname).toLowerCase()}|${Number(链.port)}`;
    if (已用.has(id)) continue;
    已用.add(id);
    候选链.push(链);
  }
  if (!候选链.length) return { url, routed: true, error: '节点地址无法解析' };
  const out = new URL(url.href);
  out.pathname = '/video/' + base64SecretEncode(JSON.stringify(候选链[0]), uuid);
  return { url: out, routed: true, candidates: 候选链 };
}
