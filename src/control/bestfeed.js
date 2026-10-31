// 优选订阅：多个"优选 URL / 优选订阅生成器"汇总成一个按运营商区分的优选池。
//  - 支持的 URL 与优质来源一致（IP 列表、CloudflareSpeedTest CSV、sub://生成器、节点订阅），由 sources.fetchRemoteSource 解析。
//  - URL 中的 {isp} 按访问者运营商替换为 ct/cu/cmcc/cf（运营商自适应）；不含 {isp} 时所有运营商共用一份（键 all）。
//  - Cron 负责拉取并写 KV（内容变化才写）；订阅热路径只读 KV + isolate 内存，不等待外部请求。
//    KV 没有数据时（首次部署 / 无 Cron）在后台拉一次放进内存，本次订阅先不含优选节点。
import { fetchRemoteSource } from './sources.js';
import { mapLimit } from './usage.js';
import { hash32 } from '../lib/rand.js';

export const bestKey = (isp) => `nt.best.${isp}`;
const ISPS = ['cf', 'ct', 'cu', 'cmcc'];
const MEM_TTL = 10 * 60e3;

const iso = { mem: new Map(), inflight: new Map() };
export function resetBestState() { iso.mem.clear(); iso.inflight.clear(); }

/** 该配置下实际需要维护的运营商键：URL 含 {isp} → 四个运营商各一份；否则共用 all */
export function bestIspKeys(settings) {
  const urls = settings?.preferred?.best?.urls || [];
  return urls.some((u) => u.includes('{isp}')) ? ISPS.slice() : ['all'];
}
const keyFor = (settings, isp) => (bestIspKeys(settings)[0] === 'all' ? 'all' : ISPS.includes(isp) ? isp : 'cf');

/**
 * 拉取全部优选 URL 并合并去重。
 * @returns {Promise<{isp:string, entries:object[], links:object[], fetchedAt:number, errors:string[], sig:string}>}
 */
export async function fetchBest({ settings, isp, fetchFn = globalThis.fetch, now = Date.now(), uuid = '' }) {
  const cfg = settings.preferred.best;
  const code = isp === 'all' ? 'cf' : isp;
  const urls = cfg.urls.map((u) => u.replace(/\{isp\}/g, code));
  const errors = [];
  const results = await mapLimit(urls, 6, async (u) => {
    try { return await fetchRemoteSource(u, { fetchFn, uuid }); } catch (e) { errors.push(`${u}：${e?.message || e}`); return null; }
  });
  const entries = [], links = [], seen = new Set();
  results.forEach((r) => {
    if (!r) return;
    let n = 0;
    for (const e of r.entries) {
      if (n >= cfg.maxPerUrl) break;
      const k = `${e.address}|${e.port}`;
      if (seen.has(k)) continue;
      seen.add(k); n++;
      // 只保留渲染需要的字段，控制 KV 体积
      entries.push({ kind: 'addr', address: e.address, port: e.port, remark: e.remark || '', best: true, ...(e.proxyIp ? { proxyIp: true } : {}) });
    }
    for (const l of r.links.slice(0, cfg.maxPerUrl)) {
      if (seen.has(l.link)) continue;
      seen.add(l.link);
      links.push({ kind: 'link', link: l.link, best: true });
    }
  });
  const sig = hash32(JSON.stringify(entries) + JSON.stringify(links)).toString(16);
  return { isp, entries: entries.slice(0, cfg.maxNodes), links: links.slice(0, cfg.maxNodes), fetchedAt: now, errors, sig };
}

/** Cron：刷新一个运营商键的优选池，内容变化才写 KV（只更新时间不写，省写入预算） */
export async function refreshBest({ store, settings, isp, fetchFn, now = Date.now(), uuid = '' }) {
  const cfg = settings?.preferred?.best;
  if (!cfg?.enabled || !cfg.urls.length) return { skipped: '未启用优选订阅' };
  const key = keyFor(settings, isp);
  const r = await fetchBest({ settings, isp: key, fetchFn, now, uuid });
  if (!r.entries.length && !r.links.length) return { ok: false, isp: key, errors: r.errors };
  iso.mem.set(key, { v: r, exp: now + MEM_TTL });
  const old = await store.getJson(bestKey(key), 0);
  const changed = !old || old.sig !== r.sig;
  if (changed && store.kvBound) await store.putJson(bestKey(key), r, MEM_TTL);
  return { ok: true, isp: key, count: r.entries.length + r.links.length, changed, errors: r.errors };
}

/**
 * 订阅热路径：取优选池（KV → 内存；都没有时后台拉取）。
 * @returns {Promise<{entries:object[], links:object[], fetchedAt:number, source:'kv'|'memory'|'none'}>}
 */
export async function loadBest({ store, settings, isp, fetchFn, now = Date.now(), waitUntil, uuid = '' }) {
  const cfg = settings?.preferred?.best;
  const empty = { entries: [], links: [], fetchedAt: 0, source: 'none' };
  if (!cfg?.enabled || !cfg.urls.length) return empty;
  const key = keyFor(settings, isp);
  const mem = iso.mem.get(key);
  if (mem && mem.exp > now) return { ...mem.v, source: 'memory' };
  const kv = store?.kvBound ? await store.getJson(bestKey(key), MEM_TTL) : null;
  // KV 数据过旧（Cron 不在跑，例如主站是 Pages）：后台在内存里刷新，当前仍返回旧数据
  const tooOld = !kv || now - (kv.fetchedAt || 0) > Math.max(cfg.refreshSeconds * 3, 30 * 60) * 1000;
  if (tooOld && !iso.inflight.has(key)) {
    const p = fetchBest({ settings, isp: key, fetchFn, now, uuid })
      .then((r) => { if (r.entries.length || r.links.length) iso.mem.set(key, { v: r, exp: now + MEM_TTL }); })
      .catch(() => {}).finally(() => iso.inflight.delete(key));
    iso.inflight.set(key, p);
    waitUntil?.(p);
  }
  if (kv) return { ...kv, source: 'kv' };
  if (mem) return { ...mem.v, source: 'memory' };
  return empty;
}

/** 从优选池里取出纯 IPv4/IPv6 地址（给随机优选的"优选池抽样"模式用） */
export function bestAddresses(best) {
  const out = [];
  for (const e of best?.entries || []) if (/^[\d.]+$|:/.test(e.address)) out.push({ ip: e.address, port: Number(e.port) || 443 });
  return out;
}
