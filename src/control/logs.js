// 访问日志：条目格式、截断、脱敏、过滤、去重；存储层（内存缓冲 + 批量限频写 nt.log）由 store.js 负责。
// 条目字段对齐上游 请求日志记录()（_worker.js 5336–5390 行）的 {TYPE, IP, ASN, CC, URL, UA, TIME}，
// 新格式为 API.md 的 {t, type, ip, ua, loc, msg}（另带 asn、url，便于排查）。
import { sendTelegram, formatRequestMessage, redactSecrets, TYPE_TO_EVENT, defaultNotifyState } from './notify.js';

/** 字段截断上限（字符） */
export const LOG_LIMITS = { type: 32, ip: 64, ua: 256, loc: 64, asn: 96, url: 256, msg: 300 };
/** 非订阅类同 IP+URL+UA 的重复记录间隔（与上游一致：30 分钟） */
export const DEDUPE_MS = 30 * 60e3;
/** 订阅拉取类日志类型 */
export const SUB_TYPES = new Set(['Get_SUB', 'Get_Best_SUB']);

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * 是否需要记录该类型日志。
 * - settings.log.enabled=false 或 env.OFF_LOG 为 1/true（上游兼容）→ 不记录
 * - 订阅拉取（Get_SUB 等）且 settings.log.subFetch=false → 不记录
 */
export function shouldLog(settings, type, env) {
  const l = settings?.log || {};
  if (l.enabled === false) return false;
  if (env && ['1', 'true'].includes(String(env.OFF_LOG))) return false;
  if (SUB_TYPES.has(type) && !l.subFetch) return false;
  return true;
}

/**
 * 构造日志条目（已截断、已脱敏）。
 * @param {{type:string, now:number, ip?:string, ua?:string, cf?:object, loc?:string, url?:string, msg?:string}} o
 * @returns {{t:number, type:string, ip:string, ua:string, loc:string, asn:string, url:string, msg:string}}
 */
export function makeLogEntry({ type, now, ip, ua, cf, loc, url, msg }) {
  const c = cf || {};
  return {
    t: Number(now) || 0,
    type: cut(type || 'Unknown', LOG_LIMITS.type),
    ip: cut(ip || '未知IP', LOG_LIMITS.ip),
    ua: cut(ua || 'Unknown', LOG_LIMITS.ua),
    loc: cut(loc ?? `${c.country || 'N/A'} ${c.city || 'N/A'}`, LOG_LIMITS.loc),
    asn: cut(`AS${c.asn || '0'} ${c.asOrganization || 'Unknown'}`, LOG_LIMITS.asn),
    url: cut(redactSecrets(url || ''), LOG_LIMITS.url),
    msg: cut(redactSecrets(msg || ''), LOG_LIMITS.msg),
  };
}

/** 统一新旧格式（兼容迁移前 log.json 的大写键），返回 null 表示无效条目 */
export function normalizeLogEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if ('TYPE' in e || 'TIME' in e) {
    return {
      t: Number(e.TIME) || 0, type: String(e.TYPE || 'Unknown'), ip: String(e.IP || ''), ua: String(e.UA || ''),
      loc: String(e.CC || ''), asn: String(e.ASN || ''), url: redactSecrets(e.URL || ''), msg: '',
    };
  }
  return {
    t: Number(e.t) || 0, type: String(e.type || 'Unknown'), ip: String(e.ip || ''), ua: String(e.ua || ''),
    loc: String(e.loc || ''), asn: String(e.asn || ''), url: String(e.url || ''), msg: String(e.msg || ''),
  };
}

/**
 * 过滤 + 截取：按时间倒序（最新在前），type 为空表示全部。
 * @param {object[]} logs
 * @param {{limit?:number, type?:string}} [o]
 */
export function filterLogs(logs, { limit = 200, type = '' } = {}) {
  const n = Math.max(1, Math.min(2000, Number(limit) || 200));
  const out = [];
  const arr = Array.isArray(logs) ? logs : [];
  for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
    const e = normalizeLogEntry(arr[i]);
    if (!e) continue;
    if (type && e.type !== type) continue;
    out.push(e);
  }
  // 存储顺序基本是时间升序；为保险再按时间排一次（数量 ≤2000，开销可忽略）
  return out.sort((a, b) => b.t - a.t);
}

/** 新建去重状态（isolate 内存） */
export const createLogState = () => ({ recent: new Map() });
export const defaultLogState = createLogState();

/** 上游语义：非订阅类日志，同 IP+URL+UA 30 分钟内只记一次 */
export function isDuplicate(entry, state, now) {
  if (SUB_TYPES.has(entry.type)) return false;
  const key = `${entry.type}|${entry.ip}|${entry.url}|${entry.ua}`;
  const last = state.recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return true;
  state.recent.set(key, now);
  if (state.recent.size > 1000) state.recent.delete(state.recent.keys().next().value);
  return false;
}

/**
 * 记录一条日志：判定 → 去重 → store.appendLog（内存缓冲）→ store.flushLogs（store 内部按 flushMinutes 限频）。
 * @param {{store:object, settings:object, entry:object, env?:object, now?:number, state?:object}} o
 * @returns {Promise<boolean>} 是否进入缓冲
 */
export async function recordLog({ store, settings, entry, env, now = Date.now(), state = defaultLogState }) {
  if (!store || !shouldLog(settings, entry.type, env)) return false;
  if (isDuplicate(entry, state, now)) return false;
  store.appendLog(entry);
  const l = settings?.log || {};
  try { await store.flushLogs({ flushMinutes: l.flushMinutes ?? 5, maxEntries: l.maxEntries ?? 300 }); } catch { /* 写失败不影响请求 */ }
  return true;
}

/**
 * 请求类事件的一站式处理：记日志 + 按事件开关发 TG（与上游 请求日志记录 一样两者独立）。永不抛异常。
 * 调用方应放进 executionCtx.waitUntil()。
 * @param {object} ctx AppContext（需 request/store/settings；可选 now/ip/ua/env/fetchFn/logState/notifyState）
 * @param {{type:string, msg?:string, usage?:{used:number,total:number}|null}} o
 */
/** 自定义 KEY 的快速订阅路径 /<KEY> 等同于订阅令牌：写日志 / 发 TG 前遮掉（redactSecrets 只处理 ?token= 这类查询参数） */
export function hideKeyPath(url, identity) {
  const key = identity?.hasCustomKey ? String(identity.secretKey || '') : '';
  if (!key) return String(url || '');
  let out = String(url || '');
  for (const k of new Set([key, encodeURIComponent(key)])) out = out.split('/' + k).join('/***');
  return out;
}

export async function trackRequest(ctx, { type, msg = '', usage = null }) {
  try {
    const { settings } = ctx;
    const request = ctx.request;
    const safeUrl = hideKeyPath(request.url, ctx.identity);
    const now = ctx.now ?? Date.now();
    const ip = ctx.ip || request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '未知IP';
    const ua = ctx.ua || request.headers.get('User-Agent') || 'Unknown';
    const entry = makeLogEntry({ type, now, ip, ua, cf: request.cf, loc: ctx.loc, url: safeUrl, msg });
    const logged = await recordLog({ store: ctx.store, settings, entry, env: ctx.env, now, state: ctx.logState || defaultLogState });
    const event = TYPE_TO_EVENT[type];
    let tg = { sent: false, reason: 'event_off' };
    if (event) {
      tg = await sendTelegram({
        settings, now, event, ua,
        fetchFn: ctx.fetchFn || globalThis.fetch,
        state: ctx.notifyState || defaultNotifyState,
        dedupeKey: `${type}|${ip}|${ua}`,
        text: () => formatRequestMessage({
          siteName: settings?.site?.name || 'nicetunnel', type, ip, cc: entry.loc, asn: entry.asn,
          url: safeUrl, ua, time: now, usage,
        }),
      });
    }
    return { logged, tg };
  } catch {
    return { logged: false, tg: { sent: false, reason: 'error' } };
  }
}
