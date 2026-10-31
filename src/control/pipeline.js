// 订阅管线：一次订阅请求 = 读缓存的设置/账号/用量 → 取节点候选 → 按额度分配 host → 渲染。
// 热路径约束：不写 KV；外部 fetch 尽量命中 isolate 缓存（SWR）；耗时的刷新交给 waitUntil。
import { applyPatch } from './settings.js';
import { normalizeAccounts, hasCredentials } from './accounts.js';
import { shouldLazyRefresh, pollBatch, shouldPersist, emptySnapshot } from './usage.js';
import { buildHostPool, allocateHosts, poolSummary, makeSeed, testPolicy, applyHostChecks, buildPaidRegionPool } from './allocator.js';
import { loadCustomEntries } from './sources.js';
import { buildRandomNodes, resolveIsp, parseCidrList, fetchCidrList, FALLBACK_CIDRS } from './pool.js';
import { buildNodeSpecs, makeUniqueNamer } from './nodes.js';
import { detectIsp } from '../lib/isp.js';
import { hash32 } from '../lib/rand.js';
import { base64SecretEncode, parseChainAccount, defaultChainPort, replaceStars, randomPath } from '../dataplane/edt-core.js';
import { loadRules } from './rulesfeed.js';
import { loadBest, bestAddresses } from './bestfeed.js';
import { buildLabel } from '../build-info.js';
import { loadRegionStructure, buildRegionSpecs, newRegionCache } from './regions.js';
import { renderSubscription } from './sub/index.js';
import { KEYS } from './store.js';

export const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
export const NODE_DEPS = { base64SecretEncode, parseChainAccount, defaultChainPort, replaceStars };

// ---- isolate 级状态 ----
const iso = {
  customCache: new Map(),
  regionCache: newRegionCache(),
  lazyState: {},
  lazyInflight: null,
  cidrParsed: new Map(), // text hash -> cidrs
  cidrInflight: new Map(),
};
export function resetPipelineState() {
  iso.customCache.clear(); iso.regionCache.clear(); iso.lazyState = {}; iso.lazyInflight = null; iso.cidrParsed.clear(); iso.cidrInflight.clear();
}

export const cidrKey = (isp) => `nt.cidr.${isp}`;

/** 轮询一批账号并按需写快照（Cron / 懒刷新 / 后台手动共用） */
export async function pollAndPersist({ store, settings, accounts, now, fetchFn, ids, force = false, tickMinutes = 0 }) {
  const [current, persisted] = await Promise.all([store.getUsage(), store.getPersistedUsage ? store.getPersistedUsage() : null]);
  const r = await pollBatch({ accounts, snapshot: current || emptySnapshot(now), settings, now, fetchFn, ids, force, tickMinutes });
  // 必须和"已落盘"的快照比较，而不是内存版（否则热 isolate 里永远判定"刚写过"）
  const persist = force || shouldPersist(persisted, r.snapshot, settings, now);
  if (persist) await store.saveUsage(r.snapshot, { force: true });
  else await store.saveUsage(r.snapshot, { minIntervalMs: Infinity }); // 暂存本 isolate，下次合并落盘
  return { ...r, persisted: persist };
}

/** 读取某运营商的 CIDR（KV 缓存，缺失时后台拉取一次并写 KV） */
async function getCidrs({ store, isp, settings, fetchFn, waitUntil }) {
  const text = await store.getText(cidrKey(isp), 10 * 60e3);
  if (text) {
    const h = hash32(text) + ':' + text.length;
    let list = iso.cidrParsed.get(h);
    if (!list) {
      list = parseCidrList(text);
      if (iso.cidrParsed.size > 8) iso.cidrParsed.clear();
      iso.cidrParsed.set(h, list);
    }
    if (list.length) return list;
  }
  if (store.kvBound && !iso.cidrInflight.has(isp)) {
    const p = refreshCidr({ store, isp, settings, fetchFn }).finally(() => iso.cidrInflight.delete(isp));
    iso.cidrInflight.set(isp, p);
    waitUntil(p);
  }
  return FALLBACK_CIDRS.slice();
}

/** 拉取并保存 CIDR（只在内容变化时写 KV） */
export async function refreshCidr({ store, isp, settings, fetchFn }) {
  const r = await fetchCidrList({ isp, settings, fetchFn });
  if (!r.ok) return { ok: false, isp, error: r.error };
  const text = r.cidrs.join('\n');
  const old = await store.getText(cidrKey(isp), 0);
  if (old !== text) await store.putText(cidrKey(isp), text, 10 * 60e3);
  return { ok: true, isp, count: r.cidrs.length, changed: old !== text };
}

/**
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>, settings: object, identity: object, request: Request, url: URL,
 *   now?: number, fetchFn?: typeof fetch, waitUntil?: (p:Promise<any>)=>void,
 *   format: string, ip?: string, overrides?: object, generatorMode?: boolean, subParam?: string
 * }} o
 */
export async function buildSubscription(o) {
  const now = o.now ?? Date.now();
  const fetchFn = o.fetchFn || globalThis.fetch;
  const waitUntil = o.waitUntil || ((p) => p.catch(() => {}));
  const store = o.store;
  const settings = o.overrides ? applyPatch(o.settings, o.overrides) : o.settings;
  const preview = !!(o.preview || o.overrides?.preview);
  const url = o.url || new URL(o.request.url);
  const uuid = o.generatorMode ? PLACEHOLDER_UUID : o.identity.uuid;

  const [rawAccounts, snapshot] = await Promise.all([store.getAccounts(), store.getUsage()]);
  const accounts = normalizeAccounts(rawAccounts);

  // 1) 无 Cron 时懒刷新用量（不阻塞本次响应）
  if (!preview && !iso.lazyInflight && accounts.some(hasCredentials) && shouldLazyRefresh(snapshot, settings, now, iso.lazyState)) {
    iso.lazyInflight = pollAndPersist({ store, settings, accounts, now, fetchFn, tickMinutes: settings.usage.minWriteIntervalMinutes }).catch(() => {}).finally(() => { iso.lazyInflight = null; });
    waitUntil(iso.lazyInflight);
  }

  // 2) 节点候选：优质（自定义/汇聚，SWR 缓存）+ 兜底（随机优选，无状态）
  const subText = o.subParam ? `sub://${o.subParam}` : undefined;
  const visitorIsp = detectIsp(o.request.cf);
  const [custom, cidrs, best] = await Promise.all([
    loadCustomEntries({ text: subText, settings, fetchFn, now, cache: iso.customCache, uuid }),
    settings.preferred.random.enabled
      ? getCidrs({ store, isp: resolveIsp(settings.preferred.random.isp, visitorIsp), settings, fetchFn, waitUntil })
      : Promise.resolve([]),
    // 优选订阅（多 URL / 生成器）：与优质、随机并存；只读缓存，不阻塞
    o.generatorMode ? Promise.resolve(null) : loadBest({ store, settings, isp: resolveIsp(settings.preferred.random.isp, visitorIsp), fetchFn, now, waitUntil, uuid }),
  ]);
  if (custom.refreshPromise) waitUntil(custom.refreshPromise);
  // 随机优选从"已知可用地址"里抽一部分，其余来自 CIDR：减少超时 IP
  const random = settings.preferred.random.enabled
    ? buildRandomNodes({ settings, cidrs, isp: visitorIsp, uuid, now, good: bestAddresses(best) })
    : [];
  let regionWarnings = [];
  const merged = best &&(best.entries.length || best.links.length)
    ? { ...custom, entries: custom.entries.concat(best.entries.slice(0, settings.preferred.best.maxNodes), best.links.slice(0, settings.preferred.best.maxNodes)) }
    : custom;
  const specs = buildNodeSpecs({ custom: merged, random, settings, uuid, deps: NODE_DEPS });
  // 地区路由（可选）：订阅里放地区条目，真实节点在节点站点连接时解析
  const rgCfg = settings.preferred.regions;
  if (rgCfg.enabled && rgCfg.urls.length && !o.generatorMode) {
    const structure = await loadRegionStructure({ settings, fetchFn, now, cache: iso.regionCache });
    if (structure.refreshPromise) waitUntil(structure.refreshPromise);
    const rs = buildRegionSpecs({ settings, uuid, structure, fallbackEntries: random.map((r) => ({ address: r.address, port: r.port })), ip: o.ip, now });
    const taken = new Set(specs.map((s) => s.name));
    const rename = makeUniqueNamer(taken);
    for (const s of rs.specs) s.name = rename(s.name);
    specs.unshift(...rs.specs);
    regionWarnings = structure.warnings.concat(rs.warnings);
  }

  // 3) 按额度分配承载域名。后台"检测节点"的结果：坏节点不分配；不支持地区路由的节点不承载地区条目
  const fullPool = buildHostPool({ settings, accounts, snapshot: snapshot || emptySnapshot(now), now });
  const summary = poolSummary(fullPool, settings, now);
  const checks = o.generatorMode || typeof store.getJson !== 'function' ? null : await store.getJson(KEYS.hostChecks, 300e3).catch(() => null);
  const { pool, regionPool: freeRegionPool } = applyHostChecks(fullPool, checks, now);
  // Workers Paid：有付费域名（付费节点账号 / 开通付费的主站）时，地区条目只分给它们——链式连接 CPU 开销大，免费版会被掐断
  const paidPool = settings.paid?.regionOnly === false ? [] : buildPaidRegionPool({ settings, accounts, snapshot: snapshot || emptySnapshot(now), now, mainHost: o.identity.host, checks });
  const regionPool = paidPool.length ? paidPool : freeRegionPool;
  const slotSpecs = specs.filter((s) => s.origin !== 'link');
  const isRegion = (s) => Array.isArray(s.tags) && s.tags.includes('region');
  const groupsOf = [
    { pool, slots: slotSpecs.filter((s) => !isRegion(s)) },
    { pool: regionPool, slots: slotSpecs.filter(isRegion) },
  ];
  const hostOf = new Map();
  for (const g of groupsOf) {
    if (!g.slots.length) continue;
    let hs;
    if (o.generatorMode) hs = g.slots.map(() => 'example.com');
    else if (!settings.allocation.enabled) {
      // 关闭额度分配：与上游一致，随机打乱轮流使用
      const all = g.pool.filter((h) => h.weight > 0).map((h) => h.host);
      const list = all.length ? all : g.pool.map((h) => h.host);
      const shuffled = list.slice().sort(() => Math.random() - 0.5);
      hs = g.slots.map((_, i) => shuffled[i % shuffled.length] || '');
    } else {
      const seed = makeSeed({ mode: settings.allocation.seedMode, ip: o.ip, token: o.identity.subToken, now, windowMinutes: settings.allocation.windowMinutes });
      hs = allocateHosts({ pool: g.pool, slotIds: g.slots.map((s) => s.id), settings, seed });
    }
    g.slots.forEach((s, i) => hostOf.set(s, hs[i]));
  }
  const hosts = slotSpecs.map((s) => hostOf.get(s));
  const hostShare = {};
  const fallbackHost = o.identity.host; // 没有任何可用节点域名时，用主站自己（主站同样跑数据面）
  const hostById = new Map();
  slotSpecs.forEach((s, i) => {
    const h = hosts[i] || fallbackHost;
    hostById.set(s, h);
    hostShare[h] = (hostShare[h] || 0) + 1;
  });
  const nodes = specs.map((s) => (s.origin === 'link' ? { ...s, host: '' } : { ...s, host: replaceStars(hostById.get(s)) }));

  // 4) 规则与渲染
  const rules = await loadRules({ store, settings, fetchFn, now, waitUntil, format: o.format });
  // 测速间隔按号池余量自适应（余量足就让客户端多测速，吃紧自动放慢）
  // 客户端测速：默认按 INI；只有额度吃紧时才逐步放慢（见 testPolicy）
  const policy = testPolicy(summary, settings, now);
  const renderSettings = { ...settings, sub: { ...settings.sub, testPolicy: policy } };
  const ctx = {
    uuid, settings: renderSettings, now, requestUrl: url.href, subName: settings.site.name,
    userAgent: o.ua || '', generatorMode: !!o.generatorMode, randomPath,
  };
  const out = renderSubscription({ format: o.format, nodes, ctx, ini: rules.ini, rules });

  const headers = {
    'Content-Type': out.contentType,
    'Profile-Update-Interval': String(settings.sub.updateHours),
    'Profile-Web-Page-Url': `${url.protocol}//${url.host}/admin`,
    'Cache-Control': 'no-store',
    ...(out.extraHeaders || {}),
  };
  if (settings.sub.userinfo && summary.budget > 0) {
    // 单位技巧（同上游）：按 1 次请求 ≈ 1.024 字节，客户端显示的 "KB" 即为"千次请求"
    headers['Subscription-Userinfo'] = `upload=0; download=${Math.round(summary.used * 1.024)}; total=${Math.round(summary.budget * 1.024)}; expire=${Math.floor(summary.resetAt / 1000)}`;
  }
  if (!/mozilla/i.test(o.ua || '')) headers['Content-Disposition'] = `attachment; filename*=utf-8''${encodeURIComponent(settings.site.name)}`;
  if (custom.warnings?.length) headers['X-NT-Warnings'] = String(custom.warnings.length);
  headers['X-NT-Build'] = buildLabel();
  headers['X-NT-Opts'] = `agg=${settings.preferred.random.aggregate ? 1 : 0};tmin=${policy.min}${policy.tight > 0 ? `;tight=${policy.tight}` : ''};regions=${settings.preferred.regions.enabled ? 1 : 0};random=${settings.preferred.random.enabled ? 1 : 0}`;
  if (o.unsupportedFormat) headers['X-NT-Format-Fallback'] = String(o.unsupportedFormat);
  return { body: out.body, contentType: out.contentType, headers, nodes, summary, hostShare, warnings: (custom.warnings || []).concat(regionWarnings, out.warnings || []), rulesStatus: rules.status };
}
