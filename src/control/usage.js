// 用量轮询：查询各 Cloudflare 账号今日 Workers+Pages 请求数，维护 UsageSnapshot（燃烧速率 EMA、失败计数、告警去重）。
// GraphQL 查询、鉴权头、/accounts 发现逻辑与上游 edgetunnel getCloudflareUsage（_worker.js 6349–6404）一致。
// 纯函数 + 注入 fetchFn/now，无顶层副作用。
import { effectiveRemaining } from './allocator.js';
import { usageCfg, utcDay, dayStartMs, nextResetMs, usageForToday } from './usage-core.js';

/** @typedef {import('../types.js').Account} Account */
/** @typedef {import('../types.js').UsageSnapshot} UsageSnapshot */
/** @typedef {import('../types.js').AccountUsage} AccountUsage */

export const CF_API = 'https://api.cloudflare.com/client/v4';
const DAY_MS = 86400000;
/** 单次调用最多并行等待的连接数（CF 限制 6） */
export const MAX_CONCURRENCY = 6;
/** 一批轮询最多消耗的外部子请求数（Free 版 50，留余量） */
export const MAX_SUBREQUESTS = 45;
/** 主号开通 Workers Paid 时一批的子请求上限（付费版每次调用约 1000 个，留余量） */
export const MAX_SUBREQUESTS_PAID = 400;
/** 本次可用的子请求预算：主号付费时放大，账号多也能一轮轮完 */
export const subrequestBudget = (settings) => (settings?.paid?.main ? MAX_SUBREQUESTS_PAID : MAX_SUBREQUESTS);
/** 连续失败多少次发 pollFailing 告警 */
export const FAIL_ALERT_THRESHOLD = 3;
/** 同一账号两次尝试的最小间隔（避免懒刷新/手动轮询过于频繁打 CF API） */
export const MIN_POLL_INTERVAL_MS = 60000;

// 与上游逐字一致的 GraphQL 查询
export const USAGE_QUERY = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
					viewer { accounts(filter: {accountTag: $AccountID}) {
						pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
						workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
					} }
				}`;

// usageCfg / utcDay / dayStartMs / nextResetMs / usageForToday 在 usage-core.js（避免与 allocator.js 循环依赖），此处转出
export { usageCfg, utcDay, dayStartMs, nextResetMs, usageForToday };

/** @returns {UsageSnapshot} */
export function emptySnapshot(now) {
  return { v: 1, ts: now, day: utcDay(now), cursor: 0, accounts: {} };
}

/** @returns {AccountUsage} */
export function emptyAccountUsage() {
  return { used: 0, workers: 0, pages: 0, rate: 0, polledAt: 0, triedAt: 0, ok: false, err: null, fails: 0, alerted: {} };
}

/** 快照跨日：整体换算到今天（返回新对象） */
export function rolloverSnapshot(snapshot, now) {
  const day = utcDay(now);
  const src = snapshot && typeof snapshot === 'object' && snapshot.accounts ? snapshot : emptySnapshot(now);
  if (src.day === day) return src;
  const accounts = {};
  for (const [id, u] of Object.entries(src.accounts || {})) accounts[id] = usageForToday(u, now);
  return { ...src, v: 1, day, accounts };
}

// ---------------------------------------------------------------------------
// 单账号查询
// ---------------------------------------------------------------------------
class PollError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}
const kindOfStatus = (s) => (s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate' : 'api');
/** GraphQL errors 分类（CF 的具体 code 未完全确认，按 extensions.code 与文本启发式判断） */
function kindOfGqlError(e) {
  const code = String(e?.extensions?.code || '').toLowerCase();
  const msg = String(e?.message || '');
  if (code === 'authz' || code === 'authn' || /auth|permission|not authorized|forbidden|access denied/i.test(msg)) return 'auth';
  if (/rate.?limit|too many|quota/i.test(msg) || code.includes('rate')) return 'rate';
  return 'api';
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new PollError(ctl.signal.aborted ? `请求超时(${timeoutMs}ms)` : `网络错误: ${e?.message || e}`, 'net');
  } finally {
    clearTimeout(timer);
  }
}
async function readJson(res) {
  try { return await res.json(); } catch { throw new PollError('响应不是 JSON', 'api'); }
}
const sumRequests = (a) => (Array.isArray(a) ? a.reduce((t, i) => t + (Number(i?.sum?.requests) || 0), 0) : 0);

/** 去掉凭据里不可能合法的字符：空白（含全角空格、零宽字符）、引号——常见于从网页/聊天里复制 */
const cleanSecret = (v) => String(v || '').replace(/[\s\u200b-\u200d\ufeff\u3000"'`]/g, '');
/** Global API Key：37 位十六进制；API Token：40 位（字母数字 _ -） */
export const looksGlobalKey = (v) => /^[0-9a-f]{37}$/i.test(v);
export const looksApiToken = (v) => /^[A-Za-z0-9_-]{40}$/.test(v) && !looksGlobalKey(v);

/**
 * 按凭据格式排出鉴权方式（先最可能对的）。填错栏位是 400 的常见原因：
 * Global Key 填进了 API Token 栏 → 被当 Bearer 发出（CF 返回 400 "Invalid format for Authorization header"）；
 * API Token 填进了 Global Key 栏 → 被当 X-Auth-Key 发出（400 "Invalid format for X-Auth-Key header"）。
 * @returns {{label:string, headers:Record<string,string>}[]}
 */
export function authAttempts(auth = {}) {
  const email = String(auth.email || '').trim();
  const token = cleanSecret(auth.apiToken);
  const key = cleanSecret(auth.globalKey);
  const out = [];
  const seen = new Set();
  const add = (label, headers) => { const k = JSON.stringify(headers); if (!seen.has(k)) { seen.add(k); out.push({ label, headers }); } };
  const bearer = (v, label) => add(label, { Authorization: `Bearer ${v}` });
  const xkey = (v, label) => add(label, { 'X-AUTH-EMAIL': email, 'X-AUTH-KEY': v });
  if (token) {
    if (looksGlobalKey(token) && email) xkey(token, 'API Token 栏里的 Global Key');
    bearer(token, 'API Token');
  }
  if (key && email) {
    if (looksApiToken(key)) bearer(key, 'Global Key 栏里的 API Token');
    xkey(key, 'Global Key');
  }
  return out;
}

/** 把 CF API 的错误体整理成一句话：「400 6003 Invalid request headers / 6111 Invalid format for Authorization header」 */
async function describeHttpError(res) {
  let detail = '';
  try {
    const j = await res.json();
    const parts = [];
    for (const e of (j?.errors || []).slice(0, 2)) {
      parts.push(`${e.code ?? ''} ${e.message ?? ''}`.trim());
      for (const c of (e.error_chain || []).slice(0, 2)) parts.push(`${c.code ?? ''} ${c.message ?? ''}`.trim());
    }
    detail = parts.filter(Boolean).join(' / ');
  } catch { /* 非 JSON */ }
  return detail ? `${res.status} ${detail}` : String(res.status);
}
/** 400/401/403：凭据或请求头有问题（换一种鉴权方式可能就好） */
const authish = (status) => status === 400 || status === 401 || status === 403;

/** 失败提示：针对最常见的原因给出怎么改 */
function hintFor(status, detail, auth) {
  if (status === 400 && /authorization header/i.test(detail)) return '：API Token 格式不对（可能把 Global API Key 填进了 API Token 栏，或复制时带了多余字符）';
  if (status === 400 && /x-auth-key/i.test(detail)) return '：Global API Key 格式不对（可能把 API Token 填进了 Global Key 栏）';
  if (status === 400 && /x-auth-email/i.test(detail)) return '：邮箱格式不对';
  if (status === 400) return auth?.accountId ? '：请求被拒绝，请核对 Account ID 是否为该账号的 32 位 ID' : '：请求被拒绝，请填写 Account ID';
  if (status === 403 || status === 401) return '：凭据无效，或 Token 缺少 Account Analytics: Read 权限';
  return '';
}

/**
 * 查询一个账号今日（UTC）的 Workers + Pages Functions 请求数。
 * 鉴权：按凭据格式自动判断（见 authAttempts），某种方式返回 400/401/403 时换另一种再试；
 * 缺 accountId 时先 GET /accounts（多个账户时选 name 以 email 开头的，否则第一个，与上游一致）。
 * 失败时 error 带上 CF 返回的错误码与说明，便于排查。
 * @param {Account} account
 * @param {{fetchFn?: typeof fetch, now?: number, timeoutMs?: number}} opts
 * @returns {Promise<{ok:boolean, workers:number, pages:number, used:number, accountId?:string, error?:string, kind?:'auth'|'rate'|'net'|'api', subrequests:number, authUsed?:string}>}
 */
export async function pollAccount(account, { fetchFn = globalThis.fetch, now = Date.now(), timeoutMs = 8000 } = {}) {
  const auth = account?.auth || {};
  const email = String(auth.email || '').trim();
  const cfg = { 'Content-Type': 'application/json' };
  let subrequests = 0;
  const fail = (e) => ({ ok: false, workers: 0, pages: 0, used: 0, error: String(e?.message || e).slice(0, 300), kind: e?.kind || 'api', subrequests });
  const attempts = authAttempts(auth);
  if (!attempts.length) return fail(new PollError('缺少凭据（需 apiToken，或 email+globalKey）', 'auth'));
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let lastErr = null;
  let discovered;
  for (const at of attempts) {
    const hdr = { ...cfg, ...at.headers };
    try {
      let accountId = String(auth.accountId || '').trim().toLowerCase();
      if (!accountId) {
        subrequests++;
        const r = await fetchWithTimeout(fetchFn, `${CF_API}/accounts`, { method: 'GET', headers: hdr }, timeoutMs);
        if (!r.ok) {
          const d = await describeHttpError(r);
          const e = new PollError(`账户获取失败: ${d}${hintFor(r.status, d, auth)}`, authish(r.status) ? 'auth' : kindOfStatus(r.status));
          e.retry = authish(r.status);
          throw e;
        }
        const d = await readJson(r);
        if (!d?.result?.length) throw new PollError('未找到账户（Token 需要能读取账户列表，或直接填写 Account ID）', 'api');
        const idx = email ? d.result.findIndex((a) => a?.name?.toLowerCase().startsWith(email.toLowerCase())) : -1;
        accountId = discovered = String(d.result[idx >= 0 ? idx : 0]?.id || '');
        if (!accountId) throw new PollError('未找到账户', 'api');
      }
      subrequests++;
      const res = await fetchWithTimeout(fetchFn, `${CF_API}/graphql`, {
        method: 'POST',
        headers: hdr,
        body: JSON.stringify({
          query: USAGE_QUERY,
          variables: { AccountID: accountId, filter: { datetime_geq: iso(dayStartMs(now)), datetime_leq: iso(now) } },
        }),
      }, timeoutMs);
      if (!res.ok) {
        const d = await describeHttpError(res);
        const e = new PollError(`查询失败: ${d}${hintFor(res.status, d, auth)}`, authish(res.status) ? 'auth' : kindOfStatus(res.status));
        e.retry = authish(res.status);
        throw e;
      }
      const result = await readJson(res);
      if (result?.errors?.length) throw new PollError(result.errors[0]?.message || 'GraphQL 错误', kindOfGqlError(result.errors[0]));
      const acc = result?.data?.viewer?.accounts?.[0];
      if (!acc) throw new PollError('未找到账户数据（Account ID 不属于这个凭据？）', 'api');
      const pages = sumRequests(acc.pagesFunctionsInvocationsAdaptiveGroups);
      const workers = sumRequests(acc.workersInvocationsAdaptive);
      const out = { ok: true, workers, pages, used: workers + pages, subrequests, authUsed: at.label };
      if (discovered) out.accountId = discovered;
      return out;
    } catch (e) {
      lastErr = e instanceof PollError ? e : new PollError(e?.message || String(e), 'api');
      // 只有"凭据/请求头被拒"才换下一种鉴权方式；网络、限频、数据为空等换了也没用
      if (!lastErr.retry) break;
    }
  }
  const out = fail(lastErr);
  if (attempts.length > 1 && lastErr?.retry) out.error = (out.error + `（已尝试 ${attempts.map((a) => a.label).join('、')}）`).slice(0, 300);
  if (discovered) out.accountId = discovered;
  return out;
}

// ---------------------------------------------------------------------------
// 批量轮询
// ---------------------------------------------------------------------------
/** 是否需要监控用量：node/main 且启用 */
export const isMonitored = (a) => !!a && a.enabled !== false && (a.role === 'node' || a.role === 'main');
const hasCreds = (a) => !!(a?.auth?.apiToken || (a?.auth?.email && a?.auth?.globalKey));

/**
 * 排序键：最久未成功轮询优先（polledAt 小的先）。
 * 为避免一直失败的账号永远排在最前、挤占批次：最近一次失败的账号用 triedAt 作为键（相当于"刚轮询过"，排到后面）。
 */
const pollKey = (u) => (!u ? 0 : !u.ok && u.triedAt ? Math.max(u.polledAt || 0, u.triedAt) : u.polledAt || 0);

/**
 * 选出本批要轮询的账号。
 * @param {Account[]} accounts
 * @param {UsageSnapshot} snapshot
 * @param {{batchSize:number, now:number, ids?:string[], force?:boolean}} o
 */
export function selectBatch(accounts, snapshot, { batchSize, now, ids, force = false, maxSubrequests = MAX_SUBREQUESTS }) {
  const want = ids ? new Set(ids) : null;
  const cand = (accounts || []).filter((a) => isMonitored(a) && hasCreds(a) && (!want || want.has(a.id)));
  const rows = cand
    .map((a, i) => ({ a, i, u: snapshot?.accounts?.[a.id] }))
    .filter((r) => force || !r.u || now - (r.u.triedAt || 0) >= MIN_POLL_INTERVAL_MS)
    .sort((x, y) => pollKey(x.u) - pollKey(y.u) || x.i - y.i);
  // 子请求预算：缺 accountId 的号需要 2 次（/accounts + /graphql）
  const out = [];
  let budget = maxSubrequests;
  for (const r of rows) {
    if (out.length >= batchSize) break;
    const cost = r.a.auth.accountId || r.u?.accountId ? 1 : 2;
    if (cost > budget) continue;
    budget -= cost;
    out.push(r.a);
  }
  return out;
}

/**
 * 自动批大小：保证每个账号在 cycleMinutes 内至少轮询一次。
 * batch = max(batchSize, ceil(可轮询账号数 × tickMinutes / cycleMinutes))，上限由 selectBatch 的子请求预算（45）兜住。
 * tickMinutes=0（未知触发间隔）时退化为 batchSize。
 */
export function autoBatchSize(accounts, cfg, tickMinutes, maxSubrequests = MAX_SUBREQUESTS) {
  const n = (accounts || []).filter((a) => isMonitored(a) && hasCreds(a)).length;
  const cycle = Math.max(1, Number(cfg.cycleMinutes) || 15);
  const need = tickMinutes > 0 ? Math.ceil((n * tickMinutes) / cycle) : 0;
  return Math.min(maxSubrequests, Math.max(cfg.batchSize, need));
}

/** 以 ≤limit 的并发执行 tasks（返回与 items 同序的结果） */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 把一次轮询结果合并进 AccountUsage（纯函数）。
 * burn rate：同日内两次成功轮询间隔 ≥1 分钟时 rate = 0.5*rate + 0.5*Δused/Δmin；Δused<0 忽略；跨日清零（由 usageForToday 处理）。
 * @returns {AccountUsage}
 */
export function applyPollResult(prev, res, now) {
  const p = { ...emptyAccountUsage(), ...(usageForToday(prev, now) || {}) };
  p.alerted = { ...(p.alerted || {}) };
  p.triedAt = now;
  if (res.accountId) p.accountId = res.accountId;
  if (!res.ok) {
    p.ok = false;
    p.err = res.error || '查询失败';
    p.errKind = res.kind || 'api';
    p.fails = (p.fails || 0) + 1;
    return p;
  }
  if (p.polledAt > 0 && utcDay(p.polledAt) === utcDay(now)) {
    const dMin = (now - p.polledAt) / 60000;
    const dUsed = res.used - p.used;
    if (dMin >= 1 && dUsed >= 0) p.rate = 0.5 * (p.rate || 0) + 0.5 * (dUsed / dMin);
  } else {
    p.rate = 0;
  }
  Object.assign(p, { used: res.used, workers: res.workers, pages: res.pages, polledAt: now, ok: true, err: null, fails: 0 });
  delete p.errKind;
  return p;
}

/**
 * 根据新旧 AccountUsage 生成告警事件（同一事件同一账号同一 UTC 日只报一次，记录在 next.alerted[type]=day）。
 * 事件类型：low / exhausted（首次进入该状态）、authFailed（鉴权失败）、pollFailing（连续失败 ≥3 次）、
 * recovered（今天报过 authFailed/pollFailing 后恢复）。
 * @returns {object[]}
 */
function collectEvents(account, prev, next, settings, now) {
  const day = utcDay(now);
  const events = [];
  const fire = (type, extra) => {
    if (next.alerted[type] === day) return;
    next.alerted[type] = day;
    events.push({ type, accountId: account.id, name: account.name || account.hosts?.[0] || account.id, role: account.role, day, ...extra });
  };
  if (next.ok) {
    const e = effectiveRemaining(account, next, settings, now);
    const info = { used: e.used, budget: Math.round(e.budget), remaining: Math.round(e.remaining), limit: e.limit };
    if (e.state === 'exhausted') fire('exhausted', info);
    else if (e.state === 'low') fire('low', info);
    const failedToday = next.alerted.authFailed === day || next.alerted.pollFailing === day;
    if (prev && prev.ok === false && failedToday) fire('recovered', info);
  } else {
    if (next.errKind === 'auth') fire('authFailed', { error: next.err, kind: next.errKind });
    if (next.fails >= FAIL_ALERT_THRESHOLD) fire('pollFailing', { error: next.err, kind: next.errKind, fails: next.fails });
  }
  return events;
}

/**
 * 轮询一批账号并返回新快照（不写 KV）。
 * - 只轮询 role 为 node/main 且 enabled、有凭据的账号；最久未成功轮询的优先；批大小 settings.usage.batchSize；并发 ≤6。
 * - 快照跨日自动换算；已删除账号的条目被清理。
 * @param {{accounts: Account[], snapshot?: UsageSnapshot, settings: object, now: number, fetchFn?: typeof fetch,
 *          ids?: string[], force?: boolean, timeoutMs?: number}} p  ids/force 供后台"立即轮询"使用
 * @returns {Promise<{snapshot: UsageSnapshot, polled: {id:string, ok:boolean, used:number, error?:string, kind?:string}[], events: object[]}>}
 */
export async function pollBatch({ accounts, snapshot, settings, now, fetchFn = globalThis.fetch, ids, force = false, timeoutMs = 8000, tickMinutes = 0 }) {
  const cfg = usageCfg(settings);
  const base = rolloverSnapshot(snapshot, now);
  const live = new Set((accounts || []).map((a) => a.id));
  const nextAccounts = {};
  for (const [id, u] of Object.entries(base.accounts || {})) if (live.has(id)) nextAccounts[id] = u;
  const out = { ...base, v: 1, day: utcDay(now), accounts: nextAccounts };
  if (!cfg.enabled && !force) return { snapshot: out, polled: [], events: [] };
  const maxSub = subrequestBudget(settings);
  const batch = selectBatch(accounts, out, { batchSize: ids ? Math.max(cfg.batchSize, ids.length) : autoBatchSize(accounts, cfg, tickMinutes, maxSub), now, ids, force, maxSubrequests: maxSub });
  const results = await mapLimit(batch, MAX_CONCURRENCY, (a) => {
    const known = a.auth.accountId || out.accounts[a.id]?.accountId || '';
    const acc = known === a.auth.accountId ? a : { ...a, auth: { ...a.auth, accountId: known } };
    const r = pollAccount(acc, { fetchFn, now, timeoutMs });
    // 用的是上次自动发现缓存的 Account ID 且失败了（可能换过 Token）：不带 ID 重新发现一次
    if (!known || a.auth.accountId) return r;
    return r.then((res) => (res.ok || res.kind === 'net' || res.kind === 'rate' ? res : pollAccount({ ...a, auth: { ...a.auth, accountId: '' } }, { fetchFn, now, timeoutMs })
      .then((again) => ({ ...again, subrequests: (again.subrequests || 0) + (res.subrequests || 0) }))));
  });
  const polled = [];
  const events = [];
  batch.forEach((a, i) => {
    const res = results[i];
    const prev = out.accounts[a.id];
    const next = applyPollResult(prev, res, now);
    out.accounts[a.id] = next;
    const row = { id: a.id, ok: res.ok, used: res.used };
    if (!res.ok) Object.assign(row, { error: res.error, kind: res.kind });
    polled.push(row);
    events.push(...collectEvents(a, prev, next, settings, now));
  });
  out.ts = now;
  out.cursor = ((base.cursor || 0) + batch.length) % 1e9;
  return { snapshot: out, polled, events };
}

// ---------------------------------------------------------------------------
// 持久化与懒刷新判定
// ---------------------------------------------------------------------------
/**
 * 是否应把 next 写入 KV（nt.usage）。规则：
 * - 无旧快照 / 跨日 → 写；
 * - 距上次写 < minWriteIntervalMinutes → 不写；
 * - 否则有"显著变化"才写：账号集合变化、任一账号 ok/err 种类/accountId/告警记录变化、
 *   used 变化 ≥ max(200, 0.2%·limit)、或 polledAt 前进 ≥ staleMinutes/4（保证其他 isolate 看到的数据不过期、批次游标能前进）。
 * @param {UsageSnapshot|null} prev 上次已持久化的快照
 * @param {UsageSnapshot} next
 */
export function shouldPersist(prev, next, settings, now) {
  if (!next) return false;
  if (!prev || !prev.accounts) return true;
  if (prev.day !== next.day) return true;
  const cfg = usageCfg(settings);
  if (now - (prev.ts || 0) < cfg.minWriteIntervalMinutes * 60000) return false;
  const pk = Object.keys(prev.accounts);
  const nk = Object.keys(next.accounts || {});
  if (pk.length !== nk.length) return true;
  // 已过最小写间隔：只要有任一账号有新的轮询结果（成功或失败）就写。
  // 旧逻辑要求"用量变化 ≥200 或 polledAt 前进 ≥15 分钟"，导致低用量账号的结果长期只留在内存里，
  // 其他 isolate 读到旧快照后反复轮询同一批账号 —— 这正是"很多账号轮询不到"的根因。
  for (const id of nk) {
    const a = prev.accounts[id];
    const b = next.accounts[id];
    if (!a) return true;
    if ((b.triedAt || 0) !== (a.triedAt || 0) || (b.polledAt || 0) !== (a.polledAt || 0)) return true;
    if ((a.accountId || '') !== (b.accountId || '')) return true;
  }
  return false;
}

/**
 * 无 Cron 时是否由当前请求触发后台刷新（调用方 ctx.waitUntil）。
 * 条件：usage.enabled && lazyRefresh，且（无快照/跨日/快照无数据/快照年龄 ≥ minWriteIntervalMinutes）。
 * 可选 state（isolate 内对象 {lastAt}）：同一 isolate 内 minWriteIntervalMinutes 内只触发一次；返回 true 时会写入 state.lastAt=now。
 * @param {{lastAt?:number}} [state]
 */
export function shouldLazyRefresh(snapshot, settings, now, state) {
  const cfg = usageCfg(settings);
  if (!cfg.enabled || !cfg.lazyRefresh) return false;
  const gap = cfg.minWriteIntervalMinutes * 60000;
  if (state && state.lastAt && now - state.lastAt < gap) return false;
  const due = !snapshot || !snapshot.accounts || snapshot.day !== utcDay(now) || !Object.keys(snapshot.accounts).length || now - (snapshot.ts || 0) >= gap;
  if (due && state) state.lastAt = now;
  return due;
}
