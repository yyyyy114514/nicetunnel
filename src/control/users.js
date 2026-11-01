// 多用户凭据：主站这一侧（用户名单、节点账号配置、在线汇总、状态下发）。
// 算法和常量在 lib/mu.js（与节点共用）；节点校验在 dataplane/mu-guard.js。
//
// 存储（主站 KV）：
//   nt.users        用户列表 [{id, name, limit, banned, createdAt}]
//   nt.mu.secret    签名密钥（首次使用时随机生成，永不改变；改了所有用户链接都会失效）
//   nt.mu.accounts  各节点账号的配置结果 {账号id: {cfId, nsId, project, bound, manual, err, at}}
//   nt.mu.state     下发状态 + 同步记录（主站自己的数据面直接读这里；节点账号 KV 里只有状态部分）
//                   {v, on, key, ids, over, sig, at, overAt, pushed:{账号id: sig}, errors, day, writes, pushN}
import {
  MU_STATE_KEY, MU_KV_BINDING, MU_AE_BINDING, MU_KV_TITLE, MU_DATASET, MU_ONLINE_WINDOW_MIN,
  newUserId, newSecret, userUuid, userSubToken, userSubSig, parseSubToken, nodeKeyOf,
} from '../lib/mu.js';
import { authAttempts } from './usage.js';
import { hash32 } from '../lib/rand.js';
import { safeEqual } from './auth.js';

// sync 与下发状态合成一个键：每次变化主站只写一次 KV
export const MU_KEYS = { users: 'nt.users', secret: 'nt.mu.secret', accounts: 'nt.mu.accounts', sync: MU_STATE_KEY };
export const MAX_USERS = 5000;
export const MAX_BATCH = 500;
export const MAX_LIMIT = 50;
const CF_API = 'https://api.cloudflare.com/client/v4';
const MAX_SYNC_ACCOUNTS = 20;

// ---------------------------------------------------------------------------
// 用户名单
// ---------------------------------------------------------------------------
const cleanName = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 40);
/** limit：null = 用默认值；0 = 不限；1~50 */
const cleanLimit = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.min(MAX_LIMIT, Math.round(Number(v)) || 0)));

export function normalizeUser(u) {
  if (!u || typeof u !== 'object' || !/^[a-z0-9]{8}$/.test(String(u.id || ''))) return null;
  return { id: u.id, name: cleanName(u.name), limit: cleanLimit(u.limit), banned: !!u.banned, createdAt: Number(u.createdAt) || 0 };
}
export const normalizeUsers = (list) => {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(normalizeUser).filter((u) => u && !seen.has(u.id) && seen.add(u.id));
};

export async function getUsers(store) { return normalizeUsers(await store.getJson(MU_KEYS.users, 30e3)); }
export async function saveUsers(store, list) { const n = normalizeUsers(list); await store.putJson(MU_KEYS.users, n, 30e3); return n; }

/** 生成一批用户（名字：前缀 + 序号） */
export function makeUsers(existing, { count, prefix = '', limit = null, now }) {
  const n = Math.max(1, Math.min(MAX_BATCH, Math.round(Number(count)) || 1));
  if (existing.length + n > MAX_USERS) throw Object.assign(new Error(`用户总数上限 ${MAX_USERS}`), { code: 'too_many' });
  const ids = new Set(existing.map((u) => u.id));
  const base = cleanName(prefix);
  const start = existing.filter((u) => base && u.name.startsWith(base)).length;
  const out = [];
  while (out.length < n) {
    const id = newUserId();
    if (ids.has(id)) continue;
    ids.add(id);
    out.push({ id, name: base ? `${base}${String(start + out.length + 1).padStart(String(start + n).length, '0')}` : '', limit: cleanLimit(limit), banned: false, createdAt: now });
  }
  return out;
}

/** 签名密钥：没有就生成一个写进 KV（只会发生一次） */
export async function getMuSecret(store) {
  const v = await store.getText(MU_KEYS.secret, 3600e3);
  if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) return v;
  const s = newSecret();
  await store.putText(MU_KEYS.secret, s, 3600e3);
  return s;
}

/** 该用户实际的并行上限（0 = 不限） */
export const effectiveLimit = (user, settings) => (user?.limit ?? settings?.users?.defaultLimit ?? 2);

/** 订阅链接 */
export async function userSubUrl(secret, origin, id) { return `${origin}/sub?u=${await userSubToken(secret, id)}`; }

/**
 * 校验订阅令牌。返回用户（含 uuid）或错误码。
 * @returns {Promise<{ok:true, user:object, uuid:string, token:string} | {ok:false, code:'bad_token'|'disabled'|'banned'}>}
 */
export async function verifySubToken({ store, settings, token }) {
  const t = parseSubToken(token);
  if (!t) return { ok: false, code: 'bad_token' };
  if (!settings?.users?.enabled) return { ok: false, code: 'disabled' };
  const secret = await getMuSecret(store);
  if (!safeEqual(t.sig, await userSubSig(secret, t.id))) return { ok: false, code: 'bad_token' };
  const user = (await getUsers(store)).find((u) => u.id === t.id);
  if (!user) return { ok: false, code: 'bad_token' };
  if (user.banned) return { ok: false, code: 'banned' };
  return { ok: true, user, uuid: await userUuid(await nodeKeyOf(secret), t.id), token: String(token) };
}

// ---------------------------------------------------------------------------
// Cloudflare API（用账号里已有的凭据）
// ---------------------------------------------------------------------------
export function cfAccountIdOf(account, usage) {
  return String(account?.auth?.accountId || usage?.accounts?.[account?.id]?.accountId || '').trim().toLowerCase();
}

/** 调 CF API；凭据像两种格式时换一种再试（与用量轮询一致） */
export async function cfApi(fetchFn, account, method, path, body, { contentType = 'application/json', timeoutMs = 10000 } = {}) {
  const attempts = authAttempts(account?.auth || {});
  if (!attempts.length) return { ok: false, status: 0, error: '账号没有凭据' };
  let last = { ok: false, status: 0, error: '请求失败' };
  for (const at of attempts) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const r = await fetchFn(CF_API + path, {
        method, signal: ac?.signal,
        headers: { ...at.headers, ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      if (r.ok && (json?.success !== false)) return { ok: true, status: r.status, json, text };
      const msg = json?.errors?.[0]?.message || text.slice(0, 160) || ('HTTP ' + r.status);
      last = { ok: false, status: r.status, error: `HTTP ${r.status} ${msg}`.slice(0, 200), json };
      if (![400, 401, 403].includes(r.status)) break;
    } catch (e) {
      last = { ok: false, status: 0, error: e?.name === 'AbortError' ? '请求超时' : String(e?.message || e).slice(0, 160) };
      break;
    } finally { if (timer) clearTimeout(timer); }
  }
  return last;
}

/** 权限不足时给出要加的权限 */
const permHint = (r, perm) => (r.status === 403 || /authentication|permission|not authorized/i.test(r.error || '') ? `（Token 需要「${perm}」权限）` : '');

// ---------------------------------------------------------------------------
// 节点账号配置：建 KV 命名空间 → 给 Pages 项目加 NT_MU / NT_AE 绑定 → 重新部署一次
// ---------------------------------------------------------------------------
const hostOfDomain = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];

/** 在项目列表里找承载这个账号域名的 Pages 项目 */
export function findPagesProject(projects, hosts) {
  const want = new Set((hosts || []).map(hostOfDomain).filter(Boolean));
  for (const p of projects || []) {
    const ds = [p.subdomain, ...(p.domains || [])].map(hostOfDomain);
    if (ds.some((d) => want.has(d) || [...want].some((h) => h.endsWith('.' + d) && d.endsWith('.pages.dev')))) return p;
  }
  return null;
}

/**
 * 配置一个节点账号。每一步的结果都记下来，失败也返回（后台显示原因与手动步骤）。
 * @returns {Promise<object>} meta
 */
export async function setupAccount({ account, cfId, fetchFn, now, prev = {}, redeploy = true }) {
  const meta = { ...prev, cfId, at: now, err: '' };
  if (!cfId) return { ...meta, err: '还不知道这个账号的 Account ID：先在「账号」页轮询一次用量，或填写 Account ID' };
  // 1) KV 命名空间
  if (!meta.nsId) {
    const list = await cfApi(fetchFn, account, 'GET', `/accounts/${cfId}/storage/kv/namespaces?per_page=100`);
    if (!list.ok) return { ...meta, err: '读取 KV 命名空间失败：' + list.error + permHint(list, 'Workers KV Storage: Edit') };
    const found = (list.json?.result || []).find((n) => n.title === MU_KV_TITLE);
    if (found) meta.nsId = found.id;
    else {
      const mk = await cfApi(fetchFn, account, 'POST', `/accounts/${cfId}/storage/kv/namespaces`, { title: MU_KV_TITLE });
      if (!mk.ok) return { ...meta, err: '创建 KV 命名空间失败：' + mk.error + permHint(mk, 'Workers KV Storage: Edit') };
      meta.nsId = mk.json?.result?.id || '';
    }
  }
  // 2) Pages 项目绑定
  if (!meta.bound) {
    // Pages 项目列表不接受 per_page=100（报 400 Invalid list options），按默认页大小逐页翻，找到就停
    let proj = null;
    for (let page = 1; page <= 10 && !proj; page++) {
      const pl = await cfApi(fetchFn, account, 'GET', `/accounts/${cfId}/pages/projects?page=${page}`);
      if (!pl.ok) return { ...meta, manual: true, err: '读取 Pages 项目失败：' + pl.error + permHint(pl, 'Cloudflare Pages: Edit') };
      const list = Array.isArray(pl.json?.result) ? pl.json.result : [];
      proj = findPagesProject(list, account.hosts);
      const info = pl.json?.result_info || {};
      const last = !list.length || (info.total_pages ? page >= info.total_pages : info.count !== undefined && info.per_page !== undefined && info.count < info.per_page);
      if (last) break;
    }
    if (!proj) return { ...meta, manual: true, err: '没找到承载这个账号域名的 Pages 项目（Worker 部署的节点需要手动绑定）' };
    meta.project = proj.name;
    // 把项目原有的同类绑定一起带上：不管这个接口是合并还是整段替换，都不会覆盖掉别的 KV / AE 绑定
    const prod = proj.deployment_configs?.production || {};
    const patch = { deployment_configs: { production: {
      kv_namespaces: { ...(prod.kv_namespaces || {}), [MU_KV_BINDING]: { namespace_id: meta.nsId } },
      analytics_engine_datasets: { ...(prod.analytics_engine_datasets || {}), [MU_AE_BINDING]: { dataset: MU_DATASET } },
    } } };
    const up = await cfApi(fetchFn, account, 'PATCH', `/accounts/${cfId}/pages/projects/${encodeURIComponent(proj.name)}`, patch);
    if (!up.ok) return { ...meta, manual: true, err: '添加绑定失败：' + up.error + permHint(up, 'Cloudflare Pages: Edit') };
    meta.bound = true;
    meta.manual = false;
    meta.deployId = proj.canonical_deployment?.id || proj.latest_deployment?.id || '';
  }
  // 3) 绑定要重新部署才生效：重试最近一次生产部署（内容不变）
  if (redeploy && meta.bound && meta.project && !meta.redeployed) {
    if (!meta.deployId) return { ...meta, err: '绑定已添加，但项目还没有部署：请在 Cloudflare 控制台重新部署一次' };
    const rd = await cfApi(fetchFn, account, 'POST', `/accounts/${cfId}/pages/projects/${encodeURIComponent(meta.project)}/deployments/${meta.deployId}/retry`);
    if (!rd.ok) return { ...meta, err: '绑定已添加，但重新部署失败：' + rd.error + '。请在 Cloudflare 控制台手动重新部署一次' };
    meta.redeployed = true;
  }
  return meta;
}

/** 账号是否能接用户（KV 有了 + 已绑定，或管理员确认已手动绑定） */
export const accountReady = (meta) => !!(meta?.nsId && (meta.bound || meta.manualBound));

// ---------------------------------------------------------------------------
// 在线汇总与并行限制
// ---------------------------------------------------------------------------
const ONLINE_SQL = `SELECT blob1 AS u, blob2 AS t, min(timestamp) AS f, max(timestamp) AS l FROM ${MU_DATASET} WHERE timestamp > NOW() - INTERVAL '${MU_ONLINE_WINDOW_MIN}' MINUTE GROUP BY u, t`;
const DAY_SQL = `SELECT blob1 AS u, SUM(_sample_interval * double1) AS c FROM ${MU_DATASET} WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY u`;
const tsOf = (v) => { const t = Date.parse(String(v).replace(' ', 'T') + (/[zZ+]/.test(String(v)) ? '' : 'Z')); return Number.isFinite(t) ? t : 0; };

export async function aeQuery(fetchFn, account, cfId, sql) {
  const r = await cfApi(fetchFn, account, 'POST', `/accounts/${cfId}/analytics_engine/sql`, sql, { contentType: 'text/plain' });
  if (!r.ok) {
    // 数据集还没有任何数据时 AE 会报表不存在：当作没人在线
    if (/unknown table|does not exist|not found/i.test(r.error || '')) return { ok: true, rows: [] };
    return { ok: false, error: r.error + permHint(r, 'Account Analytics: Read') };
  }
  return { ok: true, rows: Array.isArray(r.json?.data) ? r.json.data : [] };
}

/** 合并各账号的在线行：同一用户同一 IP 取最早 / 最晚 */
export function mergeOnline(rowsList) {
  const m = new Map();
  for (const rows of rowsList) for (const r of rows || []) {
    const u = String(r.u || ''), t = String(r.t || '');
    if (!u || !t) continue;
    const f = tsOf(r.f), l = tsOf(r.l);
    const k = u + '|' + t;
    const o = m.get(k);
    if (!o) m.set(k, { u, t, f, l });
    else { o.f = Math.min(o.f, f); o.l = Math.max(o.l, l); }
  }
  const byUser = new Map();
  for (const o of m.values()) { if (!byUser.has(o.u)) byUser.set(o.u, []); byUser.get(o.u).push(o); }
  return byUser;
}

/**
 * 算出超限用户允许的 IP 标记。先到先得；上一轮已放行的 IP 优先保留（否则持续在线的设备和新设备"首次出现时间"
 * 都会落在 5 分钟窗口的起点，顺序会来回跳）。
 * @returns {Record<string,string[]>}
 */
export function computeOver(users, settings, byUser, prevOver = {}) {
  const over = {};
  for (const u of users) {
    if (u.banned) continue;
    const limit = effectiveLimit(u, settings);
    const list = byUser.get(u.id);
    if (!limit || !list || list.length <= limit) continue;
    const prev = new Set(prevOver?.[u.id] || []);
    const sorted = list.slice().sort((a, b) => (prev.has(b.t) - prev.has(a.t)) || a.f - b.f || (a.t < b.t ? -1 : 1));
    over[u.id] = sorted.slice(0, limit).map((x) => x.t).sort();
  }
  return over;
}

/** 下发给数据面的状态：只列出可用的用户（删除和封禁的都不在里面） */
/**
 * 下发给数据面的状态：只列出可用的用户（删除和封禁的都不在里面）。
 * key 是由主密钥派生的节点密钥（HMAC(主密钥, "node")），只能算用户 UUID 和 IP 标记；
 * 订阅令牌用主密钥签，主密钥只在主站 KV —— 某个节点账号的 KV 泄露也伪造不了订阅链接。
 */
export function buildState({ nodeKey, users, settings, over }) {
  const on = !!settings?.users?.enabled;
  return { v: 2, on, key: nodeKey, ids: on ? users.filter((u) => !u.banned).map((u) => u.id).sort() : [], over: on ? over || {} : {} };
}

/** 只有超限名单变化时，最快多久下发一次（可用名单 / 开关变化总是立即下发） */
export const OVER_PUSH_MS = 5 * 60e3;
/** 只有错误信息变化时，最快多久记一次 */
const ERROR_WRITE_MS = 30 * 60e3;
/** 每天超限名单变化最多下发多少次（主站和每个节点账号各算；免费 KV 每天 1000 次写入，还要留给设置、用量等） */
export const OVER_PUSH_DAILY_MAX = 200;
const utcDayOf = (t) => new Date(t).toISOString().slice(0, 10);
const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
export const stateSig = (state) => hash32(JSON.stringify(state)).toString(16);

/**
 * 同步一次：查各账号最近 5 分钟的在线情况（query=false 时沿用上次结果）→ 算状态 → 有变化才写主站 KV 和各节点账号 KV。
 * @returns {Promise<{changed:boolean, pushed:string[], errors:Record<string,string>, online:number, over:number}>}
 */
export async function syncUsers({ store, settings, accounts, usage, fetchFn = globalThis.fetch, now = Date.now(), query = true }) {
  const [users, secret, metas, prev] = await Promise.all([getUsers(store), getMuSecret(store), store.getJson(MU_KEYS.accounts, 30e3), store.getJson(MU_KEYS.sync, 10e3)]);
  const meta = metas || {};
  const nodeKey = await nodeKeyOf(secret);
  const last = prev && prev.sig ? prev : { sig: '', over: {}, pushed: {}, errors: {} };
  const day = utcDayOf(now);
  const sameDay = last.day === day;
  const writes = sameDay ? last.writes || 0 : 0;
  const pushN = sameDay ? { ...(last.pushN || {}) } : {};
  const targets = (accounts || []).filter((a) => meta[a.id]?.nsId && cfAccountIdOf(a, usage) && a.enabled !== false).slice(0, MAX_SYNC_ACCOUNTS);
  const errors = {};
  let over = last.over || {};
  let onlineCount = 0;
  if (query && settings?.users?.enabled && targets.length) {
    const res = await Promise.all(targets.map((a) => aeQuery(fetchFn, a, cfAccountIdOf(a, usage), ONLINE_SQL).catch((e) => ({ ok: false, error: String(e?.message || e) }))));
    res.forEach((r, i) => { if (!r.ok) errors[targets[i].id] = 'AE：' + r.error; });
    // 全部失败时保留上次的限制，不因为查询抖动把超限用户放开
    if (res.some((r) => r.ok)) {
      const byUser = mergeOnline(res.filter((r) => r.ok).map((r) => r.rows));
      onlineCount = [...byUser.values()].reduce((n, l) => n + l.length, 0);
      over = computeOver(users, settings, byUser, last.over);
    }
  }
  // 写入节流：可用名单 / 开关 / 节点密钥变了立即下发（封禁、删除要马上生效）；只有超限名单变了，
  // 最快 5 分钟一次，且每天有上限——用户在上限附近进进出出时名单可能每分钟都变，不节流会写满 KV 的每日额度
  let state = buildState({ nodeKey, users, settings, over });
  const urgent = !last.sig || state.on !== last.on || state.key !== last.key || !sameList(state.ids, last.ids);
  const overChanged = JSON.stringify(state.over) !== JSON.stringify(last.over || {});
  let overAt = last.overAt || 0;
  if (!urgent && overChanged) {
    const budgetLeft = writes < OVER_PUSH_DAILY_MAX && targets.every((a) => (pushN[a.id] || 0) < OVER_PUSH_DAILY_MAX);
    if (now - overAt < OVER_PUSH_MS || !budgetLeft) state = buildState({ nodeKey, users, settings, over: last.over || {} });
    else overAt = now;
  } else if (overChanged) overAt = now;
  over = state.over;
  const sig = stateSig(state);
  const pushed = { ...(last.pushed || {}) };
  const done = [];
  const body = JSON.stringify(state);
  await Promise.all(targets.filter((a) => pushed[a.id] !== sig).map(async (a) => {
    const cfId = cfAccountIdOf(a, usage);
    const r = await cfApi(fetchFn, a, 'PUT', `/accounts/${cfId}/storage/kv/namespaces/${meta[a.id].nsId}/values/${encodeURIComponent(MU_STATE_KEY)}`, body, { contentType: 'text/plain' });
    if (r.ok) { pushed[a.id] = sig; pushN[a.id] = (pushN[a.id] || 0) + 1; done.push(a.id); } else errors[a.id] = (errors[a.id] ? errors[a.id] + '；' : '') + 'KV 写入：' + r.error + permHint(r, 'Workers KV Storage: Edit');
  }));
  // 主站只写一个键（状态 + 同步记录）。只有错误信息变了：最快 30 分钟记一次
  const errChanged = JSON.stringify(errors) !== JSON.stringify(last.errors || {});
  const changed = sig !== last.sig || done.length > 0 || (errChanged && now - (last.at || 0) >= ERROR_WRITE_MS);
  if (changed && store.kvBound) await store.putJson(MU_KEYS.sync, { ...state, sig, at: now, overAt, pushed, errors, day, writes: writes + 1, pushN }, 10e3);
  return { changed, pushed: done, errors, online: onlineCount, over: Object.keys(over).length };
}

/** 后台统计：每个用户最近 5 分钟在线 IP 数、最近 24 小时连接数（每个账号 2 次 AE 查询） */
export async function userStats({ store, accounts, usage, fetchFn = globalThis.fetch }) {
  const meta = (await store.getJson(MU_KEYS.accounts, 30e3)) || {};
  const targets = (accounts || []).filter((a) => meta[a.id]?.nsId && cfAccountIdOf(a, usage)).slice(0, MAX_SYNC_ACCOUNTS);
  const errors = {};
  const online = [], day = new Map();
  await Promise.all(targets.map(async (a) => {
    const cfId = cfAccountIdOf(a, usage);
    const [o, d] = await Promise.all([aeQuery(fetchFn, a, cfId, ONLINE_SQL), aeQuery(fetchFn, a, cfId, DAY_SQL)]);
    if (o.ok) online.push(o.rows); else errors[a.id] = o.error;
    if (d.ok) for (const r of d.rows) day.set(String(r.u), (day.get(String(r.u)) || 0) + (Number(r.c) || 0));
    else if (!errors[a.id]) errors[a.id] = d.error;
  }));
  const byUser = mergeOnline(online);
  const out = {};
  for (const [u, list] of byUser) out[u] = { online: list.length, lastSeen: Math.max(...list.map((x) => x.l)) };
  for (const [u, c] of day) out[u] = { ...(out[u] || { online: 0, lastSeen: 0 }), conns: Math.round(c) };
  return { stats: out, errors, accounts: targets.length };
}

/** 能接用户订阅的账号 id：配置好多用户的节点账号 + 主站账号（role=main，读自己的 KV） */
export async function readyAccountSet(store) {
  const [metas, accounts] = await Promise.all([store.getJson(MU_KEYS.accounts, 30e3), store.getAccounts()]);
  const set = new Set();
  for (const a of accounts || []) if (a.role === 'main' || accountReady(metas?.[a.id])) set.add(a.id);
  return set;
}
