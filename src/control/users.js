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
import { banActive, banUser, evaluateRules, aggregateRows, ruleWindows, cutoffOf, nodeAggSql, subAggSql, hitReason } from './autoban.js';

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

/** 用户填写的标识：去掉控制字符和尖括号，最多 30 字 */
export const cleanLabel = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);

/**
 * 用户在订阅页设置标识。只能设置一次（已设置返回 locked）；封禁中、链接无效都不行。
 * @returns {Promise<{ok:true, label:string} | {ok:false, code:string}>}
 */
export async function setUserLabel({ store, settings, token, label, now = Date.now() }) {
  const v = await verifySubToken({ store, settings, token });
  if (!v.ok) return { ok: false, code: v.code };
  const text = cleanLabel(label);
  if (!text) return { ok: false, code: 'empty' };
  const all = await getUsers(store);
  const u = all.find((x) => x.id === v.user.id);
  if (!u) return { ok: false, code: 'bad_token' };
  if (u.labelAt) return { ok: false, code: 'locked', label: u.label };
  await saveUsers(store, all.map((x) => (x.id === u.id ? { ...x, label: text, labelAt: now } : x)));
  return { ok: true, label: text };
}

/** 还没填标识、订阅被挡着（只有「填写标识才开订阅」开启期间生成的用户才会这样） */
export const labelPending = (u) => !!(u && u.needLabel && !u.labelAt);

export function normalizeUser(u) {
  if (!u || typeof u !== 'object' || !/^[a-z0-9]{8}$/.test(String(u.id || ''))) return null;
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  return {
    id: u.id, name: cleanName(u.name), limit: cleanLimit(u.limit), banned: !!u.banned, createdAt: n(u.createdAt),
    // 封禁时长（0 = 永久）与原因；违规次数和统计起点（阶梯处罚用）；上次封禁 / 解封时间（规则只算之后的数据）
    bannedUntil: n(u.bannedUntil), banAuto: !!u.banAuto, banReason: String(u.banReason || '').replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, 80),
    vio: n(u.vio), vioSince: n(u.vioSince), banAt: n(u.banAt), unbanAt: n(u.unbanAt),
    // 用户自己在订阅页填写的标识（只能设置一次；labelAt > 0 表示已锁定，后台可重置）
    label: cleanLabel(u.label), labelAt: n(u.labelAt),
    // 生成时开着「填写标识才开订阅」：填写标识之前订阅不可用
    needLabel: !!u.needLabel,
  };
}
export const normalizeUsers = (list) => {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(normalizeUser).filter((u) => u && !seen.has(u.id) && seen.add(u.id));
};

export async function getUsers(store) { return normalizeUsers(await store.getJson(MU_KEYS.users, 30e3)); }
export async function saveUsers(store, list) { const n = normalizeUsers(list); await store.putJson(MU_KEYS.users, n, 30e3); return n; }

/** 生成一批用户（名字：前缀 + 序号） */
export function makeUsers(existing, { count, prefix = '', limit = null, now, needLabel = false }) {
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
    out.push({ id, name: base ? `${base}${String(start + out.length + 1).padStart(String(start + n).length, '0')}` : '', limit: cleanLimit(limit), banned: false, createdAt: now, ...(needLabel ? { needLabel: true } : {}) });
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
  const nodeKey = await nodeKeyOf(secret);
  // 封禁到期自动失效
  if (banActive(user)) return { ok: false, code: 'banned', user, nodeKey };
  return { ok: true, user, uuid: await userUuid(nodeKey, t.id), token: String(token), nodeKey };
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
    // 先确认这个账号能用 Analytics Engine：没开通 AE 时项目带着 AE 绑定，之后每次部署都会失败
    // （"You need to enable Analytics Engine"），节点再也更新不了。查不了就只加 KV 绑定：封禁照常生效，
    // 只是这个账号的在线统计和并行限制不生效
    const ae = await aeQuery(fetchFn, account, cfId, ONLINE_SQL);
    meta.aeMissing = !ae.ok;
    meta.aeErr = ae.ok ? '' : String(ae.error || '').slice(0, 200);
    // 把项目原有的同类绑定一起带上：不管这个接口是合并还是整段替换，都不会覆盖掉别的 KV / AE 绑定
    const prod = proj.deployment_configs?.production || {};
    const patch = { deployment_configs: { production: {
      kv_namespaces: { ...(prod.kv_namespaces || {}), [MU_KV_BINDING]: { namespace_id: meta.nsId } },
      ...(ae.ok ? { analytics_engine_datasets: { ...(prod.analytics_engine_datasets || {}), [MU_AE_BINDING]: { dataset: MU_DATASET } } } : {}),
    } } };
    const up = await cfApi(fetchFn, account, 'PATCH', `/accounts/${cfId}/pages/projects/${encodeURIComponent(proj.name)}`, patch);
    if (!up.ok) return { ...meta, manual: true, err: '添加绑定失败：' + up.error + permHint(up, 'Cloudflare Pages: Edit') };
    meta.bound = true;
    meta.boundAt = now;
    meta.manual = false;
    meta.deployId = proj.canonical_deployment?.id || proj.latest_deployment?.id || '';
    meta.bindDeployId = meta.deployId; // 加绑定时的生产部署：之后正式部署换成别的，说明重新部署过了
    meta.directUpload = !proj.source?.type; // 没有 Git 来源 = 直接上传部署
  }
  const projPath = `/accounts/${cfId}/pages/projects/${encodeURIComponent(meta.project || '')}`;
  // 2b) 之前因为账号没开通 AE 没加 NT_AE：再探测一次，能用了就补上（补上后要再部署一次才生效）
  if (meta.bound && meta.aeMissing && meta.project) {
    const ae = await aeQuery(fetchFn, account, cfId, ONLINE_SQL);
    if (ae.ok) {
      const pj = await cfApi(fetchFn, account, 'GET', projPath);
      const add = await cfApi(fetchFn, account, 'PATCH', projPath, { deployment_configs: { production: { analytics_engine_datasets: { [MU_AE_BINDING]: { dataset: MU_DATASET } } } } });
      if (add.ok) { meta.aeMissing = false; meta.aeErr = ''; meta.redeployed = false; meta.bindDeployId = pj.json?.result?.canonical_deployment?.id || meta.deployId || ''; }
    }
  }
  // 3) 绑定要重新部署才生效
  if (redeploy && meta.bound && meta.project && !meta.redeployed) {
    // 旧记录没有"加绑定时的生产部署"：用记下的 deployId（旧版在加绑定时记的就是当时的生产部署）
    if (!meta.bindDeployId) meta.bindDeployId = meta.deployId || '';
    const pj = await cfApi(fetchFn, account, 'GET', projPath);
    if (pj.ok && pj.json?.result?.name) {
      const r = pj.json.result;
      const cur = r.canonical_deployment;
      meta.directUpload = !r.source?.type;
      // 正式生产部署已经换成加绑定之后的新部署：绑定已生效
      if (cur?.id && meta.bindDeployId && cur.id !== meta.bindDeployId && cur.latest_stage?.status !== 'failure') { meta.redeployed = true; meta.blocked = false; meta.deployId = cur.id; meta.err = ''; return meta; }
      if (cur?.id) meta.deployId = cur.id;
      // 最近一次部署失败（没成为正式部署）：把失败原因读出来，而不是一直让管理员"再上传一次"
      const lat = r.latest_deployment;
      const failed = lat?.id && lat.id !== cur?.id && (lat.latest_stage?.status === 'failure' || (lat.stages || []).some((s) => s.status === 'failure'));
      if (failed) {
        const lg = await cfApi(fetchFn, account, 'GET', `${projPath}/deployments/${lat.id}/history/logs`);
        const lines = (lg.json?.result?.data || []).map((l) => String(l.line || ''));
        const errLine = lines.reverse().find((l) => /error/i.test(l)) || '';
        if (/enable Analytics Engine/i.test(errLine)) {
          // 管理员看到失败后已经开通了 AE：补齐 NT_AE（之前可能被去掉了），只差再上传一次
          const aeNow = await aeQuery(fetchFn, account, cfId, ONLINE_SQL);
          if (aeNow.ok) {
            const add = await cfApi(fetchFn, account, 'PATCH', projPath, { deployment_configs: { production: { analytics_engine_datasets: { [MU_AE_BINDING]: { dataset: MU_DATASET } } } } });
            if (add.ok) return { ...meta, aeMissing: false, aeErr: '', err: 'Analytics Engine 已开通，NT_MU / NT_AE 绑定都已就位。上次部署是在开通之前失败的：请再上传一次节点包，然后再点「自动配置」' };
          }
          // 账号没开通 AE：去掉 NT_AE 绑定，让部署能成功（封禁照常生效；开通 AE 后再点一次自动配置会加回）
          const rm = await cfApi(fetchFn, account, 'PATCH', projPath, { deployment_configs: { production: { analytics_engine_datasets: { [MU_AE_BINDING]: null } } } });
          if (!rm.ok) return { ...meta, aeMissing: true, err: '上次部署失败：这个账号没开通 Analytics Engine。自动去掉 NT_AE 绑定也失败了（' + rm.error + '）：请在 Pages 设置 → 绑定里删掉 NT_AE，或者在 Cloudflare 控制台开通 Analytics Engine，然后重新上传一次' };
          return { ...meta, aeMissing: true, aeErr: '账号未开通 Analytics Engine', err: '上次部署失败：这个账号没开通 Analytics Engine（带着 NT_AE 绑定部署会失败）。已去掉 NT_AE 绑定，请再上传一次节点包，然后再点「自动配置」。'
            + '封禁照常生效，但这个账号的在线统计和并行限制不生效；想要的话在 Cloudflare 控制台 Workers → Analytics Engine 开通后再点「自动配置」' };
        }
        if (errLine) return { ...meta, err: '上次部署失败，Cloudflare 的错误：' + errLine.slice(0, 240) };
      }
    }
    if (!meta.deployId) return { ...meta, err: '绑定已添加，但项目还没有部署：请在 Cloudflare 控制台部署一次' };
    // 直接上传的项目 Cloudflare 不允许用 API 重试（只有 Git 构建可以），只能重新上传一次代码
    if (meta.directUpload) return { ...meta, err: DIRECT_UPLOAD_HINT };
    // Git 构建的项目：重试最近一次生产部署（内容不变）
    const rd = await cfApi(fetchFn, account, 'POST', `/accounts/${cfId}/pages/projects/${encodeURIComponent(meta.project)}/deployments/${meta.deployId}/retry`);
    if (!rd.ok) {
      if (/direct upload/i.test(rd.error || '')) return { ...meta, directUpload: true, err: DIRECT_UPLOAD_HINT };
      // 项目被 Cloudflare 封禁（abuse）：根本部署不了，标记出来，不再把用户分到这个账号
      if (/has been blocked|abusereply/i.test(rd.error || '')) return { ...meta, blocked: true, err: '这个 Pages 项目已被 Cloudflare 封禁（abuse），无法部署，节点不可用。不会再把用户分到这个账号；请换一个账号或项目' };
      return { ...meta, err: '绑定已添加，但重新部署失败：' + String(rd.error || '').replace(/[。.]\s*$/, '') + '。请在 Cloudflare 控制台手动重新部署一次' };
    }
    meta.redeployed = true;
    meta.blocked = false;
  }
  return meta;
}

const DIRECT_UPLOAD_HINT = '绑定已加好，还差重新部署一次才生效。这个项目是直接上传部署的，Cloudflare 不允许用 API 重新部署：'
  + '请在 Pages 控制台重新上传一次节点包（或运行 node scripts/deploy-node.mjs），完成后再点一次「自动配置」，会自动检测到新部署并变为就绪';

/**
 * 账号是否能接用户：KV 有了，并且（自动绑定后重新部署成功，或管理员确认已手动绑定并部署）；项目被封禁的不算。
 * 绑定要重新部署后才生效：只加了绑定、部署失败时节点还读不到 NT_MU，用户连上去会被拒
 */
export const accountReady = (meta) => !!(meta?.nsId && ((meta.bound && meta.redeployed) || meta.manualBound) && !meta.blocked);

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
export function computeOver(users, settings, byUser, prevOver = {}, now = Date.now()) {
  const over = {};
  for (const u of users) {
    if (banActive(u, now)) continue;
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
export function buildState({ nodeKey, users, settings, over, now = Date.now() }) {
  const on = !!settings?.users?.enabled;
  // 封禁到期的用户自动回到名单里（名单变化会立即下发）
  return { v: 2, on, key: nodeKey, ids: on ? users.filter((u) => !banActive(u, now)).map((u) => u.id).sort() : [], over: on ? over || {} : {} };
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
      over = computeOver(users, settings, byUser, last.over, now);
    }
  }
  // 写入节流：可用名单 / 开关 / 节点密钥变了立即下发（封禁、删除要马上生效）；只有超限名单变了，
  // 最快 5 分钟一次，且每天有上限——用户在上限附近进进出出时名单可能每分钟都变，不节流会写满 KV 的每日额度
  let state = buildState({ nodeKey, users, settings, over, now });
  const urgent = !last.sig || state.on !== last.on || state.key !== last.key || !sameList(state.ids, last.ids);
  const overChanged = JSON.stringify(state.over) !== JSON.stringify(last.over || {});
  let overAt = last.overAt || 0;
  if (!urgent && overChanged) {
    const budgetLeft = writes < OVER_PUSH_DAILY_MAX && targets.every((a) => (pushN[a.id] || 0) < OVER_PUSH_DAILY_MAX);
    if (now - overAt < OVER_PUSH_MS || !budgetLeft) state = buildState({ nodeKey, users, settings, over: last.over || {}, now });
    else overAt = now;
  } else if (overChanged) overAt = now;
  over = state.over;
  // 超限记录（自动封禁"超过并行上限"规则用）：下发的超限名单里新出现的用户记一次；只留统计窗口内的、每人最多 50 条
  const keepMs = Math.max(settings?.users?.autoBan?.overLimit?.hours || 24, settings?.users?.autoBan?.resetHours || 168) * 3600e3;
  const overHits = {};
  for (const [id, list] of Object.entries(last.overHits || {})) { const l = (list || []).filter((t) => now - t < keepMs).slice(-50); if (l.length) overHits[id] = l; }
  for (const id of Object.keys(state.over)) if (!(last.over || {})[id]) (overHits[id] ||= []).push(now);
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
  if (changed && store.kvBound) await store.putJson(MU_KEYS.sync, { ...state, sig, at: now, overAt, pushed, errors, day, writes: writes + 1, pushN, overHits }, 10e3);
  return { changed, pushed: done, errors, online: onlineCount, over: Object.keys(over).length };
}

/** 每次检查最多给几个"刚封禁 / 解封过"的用户单独查（他们只能算之后的数据） */
const AUTOBAN_RECENT_MAX = 3;

/** 主站账号（role=main）：主站自己的 Analytics Engine 在这个账号下 */
const mainAccountOf = (accounts, usage) => (accounts || []).find((a) => a.role === 'main' && authAttempts(a.auth || {}).length && cfAccountIdOf(a, usage)) || null;

/**
 * 按窗口查一组账号，合并成 窗口小时数 → 用户 → 聚合。刚封禁 / 解封过的用户只算之后的数据：单独查（每次最多几个），
 * 超出的这次先不判断。
 */
async function collectAgg({ windows, accounts, usage, users, fetchFn, now, sqlOf, errors }) {
  const out = new Map();
  for (const h of windows) {
    const since = now - h * 3600e3;
    const map = new Map();
    const res = await Promise.all(accounts.map((a) => aeQuery(fetchFn, a, cfAccountIdOf(a, usage), sqlOf(since / 1000)).catch((e) => ({ ok: false, error: String(e?.message || e) }))));
    res.forEach((r, i) => { if (r.ok) aggregateRows(map, r.rows); else errors[accounts[i].id] = 'AE：' + r.error; });
    const recent = users.filter((u) => cutoffOf(u, since) > since);
    for (const u of recent) map.delete(u.id);
    for (const u of recent.slice(0, AUTOBAN_RECENT_MAX)) {
      const rs = await Promise.all(accounts.map((a) => aeQuery(fetchFn, a, cfAccountIdOf(a, usage), sqlOf(cutoffOf(u, since) / 1000, u.id)).catch(() => ({ ok: false }))));
      for (const r of rs) if (r.ok) aggregateRows(map, r.rows);
    }
    out.set(h, map);
  }
  return out;
}

/**
 * 自动封禁检查一次：查各规则需要的数据 → 判断 → 触发的用户按阶梯封禁（写用户名单）。
 * 调用方随后应 syncUsers({query:false}) 把新名单下发（封禁要马上生效）。
 * @returns {Promise<{ran:boolean, banned:{id:string, reason:string, until:number}[], errors:Record<string,string>, notes:string[]}>}
 */
export async function runAutoBan({ store, settings, accounts, usage, fetchFn = globalThis.fetch, now = Date.now(), force = false, mainAe = false }) {
  const cfg = settings?.users?.autoBan;
  const result = { ran: false, banned: [], errors: {}, notes: [] };
  if (!settings?.users?.enabled || (!cfg?.enabled && !force)) return result;
  const [users, metas, rec] = await Promise.all([getUsers(store), store.getJson(MU_KEYS.accounts, 30e3), store.getJson(MU_KEYS.sync, 10e3)]);
  const meta = metas || {};
  const targets = (accounts || []).filter((a) => meta[a.id]?.nsId && !meta[a.id]?.aeMissing && cfAccountIdOf(a, usage) && a.enabled !== false).slice(0, MAX_SYNC_ACCOUNTS);
  const nodeWindows = ruleWindows(cfg, 'node');
  const mainWindows = ruleWindows(cfg, 'main');
  const node = nodeWindows.length && targets.length
    ? await collectAgg({ windows: nodeWindows, accounts: targets, usage, users, fetchFn, now, sqlOf: (s, only) => nodeAggSql(MU_DATASET, s, only), errors: result.errors })
    : new Map();
  let main = new Map();
  if (mainWindows.length) {
    const ma = mainAccountOf(accounts, usage);
    if (!mainAe) result.notes.push('订阅相关规则没有数据：主站没有绑定 Analytics Engine（NT_AE）');
    else if (!ma) result.notes.push('订阅相关规则没有数据：没有可用的主号凭据（「额度」页填主号 Token）');
    else main = await collectAgg({ windows: mainWindows, accounts: [ma], usage, users, fetchFn, now, sqlOf: (s, only) => subAggSql(MU_DATASET, s, only), errors: result.errors });
  }
  result.ran = true;
  const hits = evaluateRules({ users, cfg, node, main, overHits: rec?.overHits || {}, now });
  if (!hits.length) return result;
  const byId = new Map(hits.map((h) => [h.id, h]));
  const next = users.map((u) => {
    const h = byId.get(u.id);
    // 两分钟内刚封过的跳过（两个实例同时检查时不重复累计违规次数）
    if (!h || now - (u.banAt || 0) < 120e3) return u;
    const v = banUser(u, { now, auto: true, reason: hitReason(h), cfg });
    result.banned.push({ id: u.id, reason: v.banReason, until: v.bannedUntil });
    return v;
  });
  if (result.banned.length) await saveUsers(store, next);
  return result;
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
