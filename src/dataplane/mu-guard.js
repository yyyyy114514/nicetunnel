// 多用户凭据：节点（和主站的数据面）这一侧。不发任何请求：
// - 下发状态（密钥、可用用户名单、超限用户允许的 IP）从本账号 KV 读，每个实例每 60 秒最多读一次；
// - 在线上报写本账号 Analytics Engine（不算 Worker 请求），同一用户同一 IP 每个实例每 2 分钟最多一条。
// 没绑定 KV、读不到状态、或主站关闭了多用户：带用户前缀的连接一律拒绝；普通（共享 UUID）连接不受影响。
import { MU_PATH_RE, MU_STATE_KEY, MU_KV_BINDING, MU_AE_BINDING, MU_REPORT_MS, userUuid, ipTag } from '../lib/mu.js';

const STATE_TTL_MS = 60e3;
const ERROR_TTL_MS = 15e3;
const iso = { state: null, at: 0, loading: null, lastErr: '', reports: new Map() };
export function resetMuGuard() { iso.state = null; iso.at = 0; iso.loading = null; iso.lastErr = ''; iso.reports.clear(); }

/** 节点读本账号 KV（NT_MU）；主站读自己的 KV */
const kvOf = (env) => env?.[MU_KV_BINDING] || env?.KV || null;

async function loadState(env, now) {
  if (iso.state !== undefined && iso.at && now - iso.at < (iso.state ? STATE_TTL_MS : ERROR_TTL_MS)) return iso.state;
  if (iso.loading) return iso.loading;
  const kv = kvOf(env);
  if (!kv || typeof kv.get !== 'function') { iso.lastErr = 'no_kv'; return null; }
  iso.loading = (async () => {
    try {
      const raw = await kv.get(MU_STATE_KEY);
      const s = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      iso.state = s && typeof s.key === 'string' && s.key.length >= 32 ? s : null;
      iso.lastErr = iso.state ? '' : 'no_state';
    } catch (e) {
      iso.lastErr = 'read_failed';
      // 读失败：继续用上一份状态（如果有），不因 KV 抖动拒绝所有用户
      if (!iso.state) iso.state = null;
    }
    iso.at = now;
    return iso.state;
  })().finally(() => { iso.loading = null; });
  return iso.loading;
}

const idSets = new WeakMap();
function idSet(st) {
  let s = idSets.get(st);
  if (!s) { s = new Set(Array.isArray(st.ids) ? st.ids : []); idSets.set(st, s); }
  return s;
}

function report(env, id, tag, colo, allowed, now) {
  const ae = env?.[MU_AE_BINDING];
  if (!ae || typeof ae.writeDataPoint !== 'function') return;
  const k = id + '|' + tag;
  const r = iso.reports.get(k);
  if (r) { r.n++; if (now - r.at < MU_REPORT_MS && r.allowed === allowed) return; }
  const n = r ? r.n : 1;
  if (iso.reports.size > 4096) iso.reports.clear();
  iso.reports.set(k, { at: now, n: 0, allowed });
  // blob1 用户、blob2 IP 标记、blob3 机房、blob4 是否放行；double1 = 距上次上报的连接数
  try { ae.writeDataPoint({ indexes: [id], blobs: [id, tag, String(colo || ''), allowed ? '1' : '0'], doubles: [n] }); } catch { /* 超额或未绑定 */ }
}

/**
 * 紧急锁定检查：state.lock === true 时封锁所有代理连接（包括共享 UUID）。
 * 返回 true = 已锁定，调用方应返回伪装页。
 */
export async function lockCheck(env, now = Date.now()) {
  const st = await loadState(env, now);
  return !!(st?.lock);
}

/**
 * 仅多用户检查：state.muOnly === true 时拒绝不带 /_u<ID> 前缀的共享 UUID 连接。
 * 应在 gate 剥离之后、muCheck 之前调用；pathname 是剥离 gate 后的路径。
 * 返回 true = 应拒绝（给伪装页），false = 放行。
 */
export async function muOnlyCheck(env, now = Date.now()) {
  const st = await loadState(env, now);
  return !!(st?.muOnly);
}

/**
 * Gate 前缀剥离：若 state.gate 非空，且路径以 /<gate>/ 开头（或正好是 /<gate>），则返回去掉前缀的新 URL；
 * 否则 state.gate 非空但路径不匹配时返回 null（表示请求不合法，应拒绝）；state.gate 为空返回 url 原值。
 * @returns {URL|null} null = gate 不匹配，拒绝；URL = 已剥离（或无需剥离）
 */
export async function gateStrip(url, env, now = Date.now()) {
  const st = await loadState(env, now);
  const gate = typeof st?.gate === 'string' ? st.gate.trim() : '';
  if (!gate) return url; // 未设置 gate，直接放行
  const prefix = '/' + gate;
  const p = url.pathname;
  if (p === prefix || p.startsWith(prefix + '/')) {
    const next = new URL(url.href);
    next.pathname = p.slice(prefix.length) || '/';
    return next;
  }
  return null; // gate 已设置但路径不带正确前缀：拒绝
}

/**
 * 处理带用户前缀的连接。
 * @returns {Promise<null | {ok:false, reason:string} | {ok:true, id:string, uuid:string, url:URL}>}
 *   null = 不是用户链接（照常用共享 UUID）
 */
export async function muCheck(request, env, url, ip, now = Date.now()) {
  const m = MU_PATH_RE.exec(url.pathname);
  if (!m) return null;
  const id = m[1];
  const st = await loadState(env, now);
  if (!st) return { ok: false, reason: iso.lastErr || 'no_state' };
  if (st.on === false) return { ok: false, reason: 'disabled' };
  const tag = await ipTag(st.key, ip);
  const colo = request.cf?.colo || '';
  // ids 是可用用户的名单：删除的、封禁的都不在里面
  if (!idSet(st).has(id)) return { ok: false, reason: 'banned' };
  const allow = st.over && Array.isArray(st.over[id]) ? st.over[id] : null;
  const allowed = !allow || allow.includes(tag);
  // 被拦的连接也上报：主站据此知道这个用户仍有多余的设备在连，限制保持稳定，不会几分钟一放开
  report(env, id, tag, colo, allowed, now);
  if (!allowed) return { ok: false, reason: 'over_limit' };
  const next = new URL(url.href);
  next.pathname = url.pathname.slice(m[0].length) || '/';
  return { ok: true, id, uuid: await userUuid(st.key, id), url: next };
}

/** 检测节点时显示（/version?stats=1）：绑定是否就绪、状态是否读到 */
export function muInfo(env) {
  return {
    kv: !!env?.[MU_KV_BINDING], ae: !!env?.[MU_AE_BINDING],
    state: iso.state ? { on: iso.state.on !== false, v: iso.state.v || 0, ageSec: iso.at ? Math.round((Date.now() - iso.at) / 1000) : null, gate: !!(iso.state.gate), lock: !!(iso.state.lock), muOnly: !!(iso.state.muOnly) } : null,
    err: iso.lastErr || '',
  };
}
