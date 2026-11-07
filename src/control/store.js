// KV 存储封装：所有 KV 读写都经过这里。
// 目标：① 热路径（订阅）尽量命中 isolate 内存缓存，少读 KV；② 写入有预算与限频（免费版每天 1000 次写）。
import { defaultSettings, normalizeSettings, importLegacyEdt } from './settings.js';
import { mergeSnapshots } from './usage-core.js';

export const KEYS = {
  settings: 'nt.settings',
  accounts: 'nt.accounts',
  usage: 'nt.usage',
  log: 'nt.log',
  meta: 'nt.meta',
  hostChecks: 'nt.hostchecks', // 后台"检测节点"的结果（用于分配时排除坏节点）
  authKey: 'nt.authkey', // 后台 cookie 签名密钥（随机生成）
  legacyConfig: 'config.json',
  legacyTg: 'tg.json',
  legacyCf: 'cf.json',
  legacyAdd: 'ADD.txt',
};

const TTL = { settings: 30e3, accounts: 30e3, usage: 20e3, log: 10e3 };

// ---- isolate 级共享状态（同一 isolate 内多个请求共用；不同 isolate 各自一份） ----
const memo = new Map(); // key -> {v, exp}
// localUsage：本 isolate 轮询得到但尚未落盘的快照（不能被 KV 里的旧快照覆盖，否则下一轮又从同一批账号开始）
// persistedUsage：最近一次从 KV 读到或写入 KV 的快照（判断"是否需要写"必须和它比，而不是和内存版比）
const fresh = () => ({ day: '', writes: 0, lastUsageWrite: 0, lastLogFlush: 0, logBuf: [], localUsage: null, persistedUsage: null });
const state = fresh();

/** 测试用：清空 isolate 级缓存 */
export function resetStoreState() {
  memo.clear();
  Object.assign(state, fresh());
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{kv: any, now?: () => number, normalizeAccounts?: (a:any)=>any[]}} opts
 */
export function createStore({ kv, now = Date.now, normalizeAccounts = (a) => (Array.isArray(a) ? a : []) }) {
  const kvBound = !!(kv && typeof kv.get === 'function');

  const countWrite = () => {
    const d = utcDay(now());
    if (d !== state.day) { state.day = d; state.writes = 0; }
    state.writes++;
  };

  async function rawGet(key, type) {
    if (!kvBound) return null;
    try { return await kv.get(key, type === 'json' ? { type: 'json' } : undefined); } catch (e) {
      // 只有 JSON 损坏才当作"没有"（避免整个站点不可用）；KV 本身出错（503、超时等）必须抛出，
      // 否则调用方会把它当成"首次运行"，用默认值覆盖已有数据
      if (type === 'json' && e instanceof SyntaxError) return null;
      throw e;
    }
  }
  async function rawPut(key, value) {
    if (!kvBound) throw new Error('未绑定 KV');
    countWrite();
    await kv.put(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  /** 带 TTL 的读缓存。ttlMs 也是这次能接受的最长缓存时间：传 0 就一定读 KV（别处缓存了 30 秒也不用） */
  async function cached(key, ttlMs, loader) {
    const hit = memo.get(key);
    const t = now();
    if (hit && hit.exp > t && ttlMs > 0 && t - (hit.at ?? -Infinity) < ttlMs) return hit.v;
    let v;
    try { v = await loader(); } catch (e) {
      // KV 暂时读不到：有旧缓存就先用旧的（10 秒后再试），没有才报错
      if (hit) { memo.set(key, { v: hit.v, at: t, exp: t + 10e3 }); return hit.v; }
      throw e;
    }
    memo.set(key, { v, at: t, exp: t + ttlMs });
    return v;
  }
  const setMemo = (key, v, ttlMs) => { const t = now(); memo.set(key, { v, at: t, exp: t + ttlMs }); };

  async function getJson(key, ttlMs = 30e3) { return cached(key, ttlMs, () => rawGet(key, 'json')); }
  async function getText(key, ttlMs = 30e3) { return cached(key, ttlMs, () => rawGet(key, 'text')); }
  async function putJson(key, val, ttlMs = 30e3) { await rawPut(key, val); setMemo(key, val, ttlMs); }
  async function putText(key, val, ttlMs = 30e3) { await rawPut(key, String(val)); setMemo(key, String(val), ttlMs); }
  /** 写 JSON 并带上 KV 元数据（listMeta 一次 list 就能读到，不用逐个 get）；同时让这个前缀的 list 缓存失效 */
  async function putJsonMeta(key, val, metadata, ttlMs = 30e3) {
    if (!kvBound) throw new Error('未绑定 KV');
    countWrite();
    await kv.put(key, JSON.stringify(val), { metadata });
    setMemo(key, val, ttlMs);
    for (const k of [...memo.keys()]) if (k.startsWith('list:') && key.startsWith(k.slice(5))) memo.delete(k);
  }
  /** 前缀下所有键的元数据 {键名: metadata}。KV list 每次最多 1000 个键；免费版每天 1000 次 list，所以带缓存 */
  async function listMeta(prefix, ttlMs = 30e3) {
    return cached('list:' + prefix, ttlMs, async () => {
      const out = {};
      if (!kvBound || typeof kv.list !== 'function') return out;
      let cursor;
      for (let i = 0; i < 20; i++) {
        const r = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
        for (const k of r?.keys || []) out[k.name] = k.metadata ?? null;
        if (r?.list_complete !== false || !r.cursor) break;
        cursor = r.cursor;
      }
      return out;
    });
  }

  // ---------------- settings（含首次迁移） ----------------
  async function loadSettings() {
    if (!kvBound) return defaultSettings();
    // 读失败直接抛出（不写 KV）；内容损坏时本次用默认值但不写回；只有键确实不存在才算首次运行
    const raw = await kv.get(KEYS.settings);
    if (raw != null) {
      if (typeof raw === 'object') return normalizeSettings(raw);
      try { return normalizeSettings(JSON.parse(raw)); } catch { return defaultSettings(); }
    }
    // 首次运行：尝试从 edgetunnel 旧配置迁移（只读旧键，不删除）
    const [legacy, tg, addTxt] = await Promise.all([
      rawGet(KEYS.legacyConfig, 'json'), rawGet(KEYS.legacyTg, 'json'), rawGet(KEYS.legacyAdd, 'text'),
    ]);
    const s = legacy ? importLegacyEdt(legacy, { tg, addTxt }) : defaultSettings();
    try {
      await rawPut(KEYS.settings, s);
      await rawPut(KEYS.meta, { migratedAt: now(), from: legacy ? 'edgetunnel' : 'fresh' });
    } catch { /* 写失败不影响本次使用 */ }
    return s;
  }
  const getSettings = () => cached(KEYS.settings, TTL.settings, loadSettings);
  async function saveSettings(s) { const n = normalizeSettings(s); await putJson(KEYS.settings, n, TTL.settings); return n; }

  // ---------------- accounts ----------------
  async function loadAccounts() {
    const raw = await rawGet(KEYS.accounts, 'json');
    if (Array.isArray(raw)) return normalizeAccounts(raw);
    // 迁移：edgetunnel 的 cf.json（主站自身用量凭据）→ role=main 的账号
    const cf = await rawGet(KEYS.legacyCf, 'json');
    if (cf && ((cf.AccountID && cf.APIToken) || (cf.Email && cf.GlobalAPIKey))) {
      return normalizeAccounts([{
        id: 'main', name: '主站', hosts: [], role: 'main', enabled: true, weight: 1, limit: null, note: '由 edgetunnel cf.json 迁移',
        auth: { accountId: cf.AccountID || '', apiToken: cf.APIToken || '', email: cf.Email || '', globalKey: cf.GlobalAPIKey || '' },
      }]);
    }
    return [];
  }
  const getAccounts = () => cached(KEYS.accounts, TTL.accounts, loadAccounts);
  async function saveAccounts(a) { const n = normalizeAccounts(a); await putJson(KEYS.accounts, n, TTL.accounts); return n; }

  // ---------------- usage ----------------
  async function loadUsage() {
    const kvSnap = await rawGet(KEYS.usage, 'json');
    if (kvSnap) state.persistedUsage = kvSnap;
    return mergeSnapshots(kvSnap, state.localUsage);
  }
  /** 当前最新视图 = KV 快照 ⊕ 本 isolate 未落盘的轮询结果（逐账号取较新） */
  const getUsage = () => cached(KEYS.usage, TTL.usage, loadUsage);
  /** 最近一次已持久化的快照（用于判断是否需要写） */
  async function getPersistedUsage() {
    if (state.persistedUsage) return state.persistedUsage;
    await getUsage();
    return state.persistedUsage;
  }
  /**
   * 写用量快照（限频）。调用方应先用 usage.shouldPersist 判断；这里再兜底防止同一 isolate 短时间重复写。
   * 写入前重新读 KV 并逐账号合并，避免覆盖其他 isolate 刚写入的结果。
   * @returns {Promise<boolean>} 是否真的写入
   */
  async function saveUsage(u, { force = false, minIntervalMs = 60e3, liveIds = null } = {}) {
    const t = now();
    // liveIds：当前还存在的账号。合并是取并集，不剪掉的话已删除账号的旧条目会被 KV 里的旧快照带回来（直到 UTC 换日）
    const live = Array.isArray(liveIds) ? new Set(liveIds) : null;
    const prune = (snap) => {
      if (!live || !snap?.accounts) return snap;
      const accounts = {};
      for (const [id, v] of Object.entries(snap.accounts)) if (live.has(id)) accounts[id] = v;
      return { ...snap, accounts };
    };
    state.localUsage = prune(mergeSnapshots(prune(state.localUsage), u));
    if (!force && t - state.lastUsageWrite < minIntervalMs) { setMemo(KEYS.usage, state.localUsage, TTL.usage); return false; }
    const merged = prune(mergeSnapshots(prune(kvBound ? await rawGet(KEYS.usage, 'json') : null), state.localUsage));
    await putJson(KEYS.usage, merged, TTL.usage);
    state.lastUsageWrite = t;
    state.persistedUsage = merged;
    state.localUsage = null;
    return true;
  }

  // ---------------- logs（内存缓冲 + 批量限频写） ----------------
  const getLogs = async () => {
    const stored = (await cached(KEYS.log, TTL.log, () => rawGet(KEYS.log, 'json'))) || [];
    return state.logBuf.length ? stored.concat(state.logBuf) : stored;
  };
  function appendLog(entry) {
    state.logBuf.push(entry);
    if (state.logBuf.length > 500) state.logBuf.splice(0, state.logBuf.length - 500);
  }
  /**
   * @param {{force?:boolean, flushMinutes?:number, maxEntries?:number}} o
   */
  async function flushLogs({ force = false, flushMinutes = 5, maxEntries = 300 } = {}) {
    if (!kvBound || !state.logBuf.length) return false;
    const t = now();
    if (!force && t - state.lastLogFlush < flushMinutes * 60e3 && state.logBuf.length < 50) return false;
    const buf = state.logBuf.splice(0);
    state.lastLogFlush = t;
    try {
      const stored = (await rawGet(KEYS.log, 'json')) || [];
      const merged = (Array.isArray(stored) ? stored : []).concat(buf);
      const trimmed = merged.length > maxEntries ? merged.slice(merged.length - maxEntries) : merged;
      await putJson(KEYS.log, trimmed, TTL.log);
      return true;
    } catch {
      state.logBuf.unshift(...buf); // 失败放回，下次再试
      return false;
    }
  }
  async function clearLogs() { state.logBuf.length = 0; await putJson(KEYS.log, [], TTL.log); }

  // ---------------- 后台 cookie 签名密钥（随机生成一次，存 KV） ----------------
  async function loadAuthSecret() {
    const v = await kv.get(KEYS.authKey);
    if (typeof v === 'string' && /^[0-9a-f]{32,}$/.test(v)) return v;
    const b = crypto.getRandomValues(new Uint8Array(32));
    const s = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    await rawPut(KEYS.authKey, s);
    // 首次部署时几个实例可能同时生成各自的密钥；写完读回一次，以 KV 里最终那份为准
    const back = await kv.get(KEYS.authKey).catch(() => null);
    return typeof back === 'string' && /^[0-9a-f]{32,}$/.test(back) ? back : s;
  }
  let authRefreshAt = 0;
  /**
   * 没绑定 KV 或读写失败时返回 ''（调用方退回推导的密钥）。
   * refresh=true：cookie 校验失败时重新读一次 KV（每个实例 30 秒最多一次）——首次部署的竞态下，
   * 本实例缓存的可能是被别的实例覆盖掉的那份密钥
   */
  async function getAuthSecret({ refresh = false } = {}) {
    if (!kvBound) return '';
    if (refresh) {
      if (now() - authRefreshAt < 30e3) return '';
      authRefreshAt = now();
      memo.delete(KEYS.authKey);
    }
    try { return await cached(KEYS.authKey, 3600e3, loadAuthSecret); } catch { return ''; }
  }

  return {
    kvBound,
    getSettings, saveSettings,
    getAccounts, saveAccounts,
    getUsage, saveUsage, getPersistedUsage,
    getLogs, appendLog, flushLogs, clearLogs,
    getAuthSecret,
    getJson, putJson, getText, putText, putJsonMeta, listMeta,
    writesToday: () => (state.day === utcDay(now()) ? state.writes : 0),
    invalidate: (key) => (key ? memo.delete(key) : memo.clear()),
    /** 原始 KV（给规则模块等需要直接 get/put 的地方；写入仍计数） */
    kv: kvBound ? {
      get: (k, type) => rawGet(k, type),
      put: (k, v) => rawPut(k, v),
    } : null,
  };
}
