// 账号管理：清洗/去重、脱敏视图、批量文本导入、旧用量面板(usage_config.json)导入、合并。
// 全部为纯函数，不碰 KV/网络。存储见 store.js（通过注入 normalizeAccounts 使用本模块）。
import { normalizeHost } from './settings.js';
import { hash32 } from '../lib/rand.js';

/** @typedef {import('../types.js').Account} Account */

const ROLES = ['node', 'main', 'off'];
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{1,63}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
/** 打码过的凭据（旧面板示例里常见 ****）视为无效 */
const isMasked = (v) => /\*{3,}/.test(v);

/** 主机名是否合法（小写域名或 IPv4） */
export function isValidHost(h) {
  return typeof h === 'string' && (HOST_RE.test(h) || IPV4_RE.test(h));
}

/** 规整 hosts：支持数组或逗号/空白分隔字符串；去协议/路径/端口、小写、去重、丢弃非法 */
function normalizeHosts(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,，;；|]+/);
  const out = [];
  for (const x of list) {
    const h = normalizeHost(String(x ?? ''));
    if (h && isValidHost(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/** 由账号特征推导稳定 id（首个 host > accountId > email），不可推导时返回 '' */
export function deriveAccountId(a) {
  const key = a?.hosts?.[0] || a?.auth?.accountId || (a?.auth?.email ? 'mail:' + a.auth.email : '');
  return key ? 'a' + hash32(key).toString(36) : '';
}

/** 清洗单个账号（不处理 id 唯一性） */
function normalizeOne(raw) {
  const r = isPlain(raw) ? raw : {};
  const au = isPlain(r.auth) ? r.auth : {};
  // auth 字段允许出现在顶层（便于手工 JSON 导入），auth 内的优先
  const pick = (k) => str(au[k] ?? r[k]);
  let accountId = pick('accountId').toLowerCase();
  if (!ACCOUNT_ID_RE.test(accountId)) accountId = '';
  let apiToken = pick('apiToken');
  let globalKey = pick('globalKey');
  if (isMasked(apiToken)) apiToken = '';
  if (isMasked(globalKey)) globalKey = '';
  const weight = Number(r.weight);
  const limit = r.limit === null || r.limit === undefined || r.limit === '' ? null : Math.round(Number(r.limit));
  return {
    id: str(r.id).replace(/[^\w.-]/g, '').slice(0, 64),
    name: str(r.name).slice(0, 64),
    hosts: normalizeHosts(r.hosts),
    role: ROLES.includes(r.role) ? r.role : 'node',
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    paid: r.paid === true, // 该账号开通了 Workers Paid（地区条目只分配给付费账号，见 settings.paid）
    weight: Number.isFinite(weight) ? Math.min(100, Math.max(0, weight)) : 1,
    limit: Number.isFinite(limit) && limit >= 1000 ? Math.min(limit, 1e8) : null,
    auth: { accountId, apiToken, email: pick('email').toLowerCase(), globalKey },
    note: str(r.note).slice(0, 500),
  };
}

/**
 * 校验/去重/补 id/规整 hosts，未知键丢弃。
 * - id 缺失：按 host/accountId/email 推导（稳定），否则 a1、a2…；重复 id 自动加后缀。
 * - 同一 host 只能属于一个账号：后出现的账号里重复的 host 被移除。
 * @param {any} raw Account[]（或 {accounts:[…]}）
 * @returns {Account[]}
 */
export function normalizeAccounts(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
  const ids = new Set();
  const hostsSeen = new Set();
  const out = [];
  for (const item of list) {
    if (!isPlain(item)) continue;
    const a = normalizeOne(item);
    a.hosts = a.hosts.filter((h) => (hostsSeen.has(h) ? false : (hostsSeen.add(h), true)));
    a.id = uniqueId(a.id || deriveAccountId(a) || 'a' + (out.length + 1), ids);
    ids.add(a.id);
    out.push(a);
  }
  return out;
}

function uniqueId(base, ids) {
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * 公开视图（后台列表用）：去掉 apiToken/globalKey 明文，只给 has* 标记；保留 email 与 accountId。
 * @param {Account[]} accounts
 */
export function publicAccounts(accounts) {
  return normalizeAccounts(accounts).map((a) => ({
    id: a.id, name: a.name, hosts: a.hosts, role: a.role, enabled: a.enabled, paid: a.paid, weight: a.weight, limit: a.limit, note: a.note,
    auth: { accountId: a.auth.accountId, hasToken: !!a.auth.apiToken, hasKey: !!a.auth.globalKey, email: a.auth.email },
  }));
}

/** 账号是否带有可用凭据（apiToken，或 email+globalKey） */
export function hasCredentials(a) {
  return !!(a?.auth?.apiToken || (a?.auth?.email && a?.auth?.globalKey));
}

/**
 * 批量导入文本。每行：
 *   host,accountId,apiToken[,name]   |  host|accountId|apiToken  |  host,email,globalKey[,name]
 * 分隔符 `, | Tab 空白`，`#` 开头为注释；第二列含 `@` 视为 email；accountId 必须 32 位十六进制。
 * 名称可含空格（第 4 列及之后整体作为名称）。
 * @param {string} text
 * @returns {{accounts: Account[], errors: string[]}}
 */
export function parseAccountsText(text) {
  const errors = [];
  const items = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(/[,，|\t ]+/).filter(Boolean);
    const at = `第 ${i + 1} 行`;
    if (cols.length < 3) { errors.push(`${at}：列数不足（需要 host,accountId,apiToken 或 host,email,globalKey）`); continue; }
    const host = normalizeHost(cols[0]);
    if (!isValidHost(host)) { errors.push(`${at}：域名无效 "${cols[0]}"`); continue; }
    const second = cols[1].trim();
    const secret = cols[2].trim();
    const name = cols.slice(3).join(' ');
    if (isMasked(secret)) { errors.push(`${at}：凭据已打码，无法使用`); continue; }
    let auth;
    if (second.includes('@')) {
      auth = { email: second.toLowerCase(), globalKey: secret, accountId: '', apiToken: '' };
    } else {
      const id = second.toLowerCase();
      if (!ACCOUNT_ID_RE.test(id)) { errors.push(`${at}：accountId 应为 32 位十六进制 "${second}"`); continue; }
      auth = { accountId: id, apiToken: secret, email: '', globalKey: '' };
    }
    items.push({ hosts: [host], name, role: 'node', enabled: true, auth });
  }
  const accounts = normalizeAccounts(items);
  // 文本内重复 host：normalizeAccounts 会把后者 hosts 清空，这里改为报错并丢弃
  const ok = accounts.filter((a, k) => {
    if (a.hosts.length) return true;
    errors.push(`重复域名 "${items[k].hosts[0]}"，已忽略后一条`);
    return false;
  });
  return { accounts: ok, errors };
}

/**
 * 导入旧用量面板（cmliu/CF-Workers-UsagePanel）的 usage_config.json：
 * `[{ID, Name, Email, GlobalAPIKey, AccountID, APIToken, Usage, …}]`。
 * 旧面板没有 host 概念：若 Name 本身是域名则作为 host，否则 hosts 为空（需在后台补填后才参与分配）。
 * @param {string|object[]} json
 * @returns {{accounts: Account[], errors: string[]}}
 */
export function importUsagePanelConfig(json) {
  const errors = [];
  let arr = json;
  if (typeof json === 'string') {
    try { arr = JSON.parse(json); } catch { return { accounts: [], errors: ['JSON 解析失败'] }; }
  }
  if (isPlain(arr) && Array.isArray(arr.accounts)) arr = arr.accounts;
  if (!Array.isArray(arr)) return { accounts: [], errors: ['格式错误：应为数组'] };
  const items = [];
  arr.forEach((it, k) => {
    const at = `第 ${k + 1} 项${it?.Name ? `（${it.Name}）` : ''}`;
    if (!isPlain(it)) { errors.push(`${at}：不是对象`); return; }
    const email = str(it.Email).toLowerCase();
    const globalKey = str(it.GlobalAPIKey);
    const accountId = str(it.AccountID).toLowerCase();
    const apiToken = str(it.APIToken);
    if ([globalKey, apiToken, accountId].some(isMasked)) { errors.push(`${at}：凭据已打码，无法使用`); return; }
    if (accountId && !ACCOUNT_ID_RE.test(accountId)) { errors.push(`${at}：AccountID 格式错误`); return; }
    const tokenMode = !!(accountId && apiToken);
    const keyMode = !!(email && globalKey);
    if (!tokenMode && !keyMode) { errors.push(`${at}：缺少凭据（需 AccountID+APIToken 或 Email+GlobalAPIKey）`); return; }
    const name = str(it.Name);
    const asHost = normalizeHost(name);
    items.push({
      name,
      hosts: isValidHost(asHost) && asHost.includes('.') ? [asHost] : [],
      role: 'node',
      enabled: true,
      note: '从用量面板导入',
      auth: { accountId, apiToken: tokenMode ? apiToken : '', email, globalKey: keyMode ? globalKey : '' },
    });
  });
  return { accounts: normalizeAccounts(items), errors };
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------
const META_KEYS = ['role', 'enabled', 'paid', 'weight', 'limit', 'note'];

/** 在 list 中找与 a 对应的账号：id → 任一 host 相同 → accountId 相同 → email 相同（仅当 a 无 host） */
function findMatch(list, a, used) {
  const free = (b) => !used.has(b);
  return (
    list.find((b) => free(b) && a.id && b.id === a.id) ||
    list.find((b) => free(b) && a.hosts.some((h) => b.hosts.includes(h))) ||
    list.find((b) => free(b) && a.auth.accountId && b.auth.accountId === a.auth.accountId) ||
    (!a.hosts.length && list.find((b) => free(b) && a.auth.email && b.auth.email === a.auth.email)) ||
    null
  );
}

/**
 * auth 字段级合并：incoming 为空串的字段保留旧值。
 * 例外：incoming 给了 email+globalKey 而没给 apiToken → 视为切换到 Global Key 模式，清掉旧 apiToken（否则 token 优先，切换无效）。
 */
function mergeAuth(oldAuth, newAuth) {
  const out = { ...oldAuth };
  for (const k of ['accountId', 'apiToken', 'email', 'globalKey']) if (newAuth[k]) out[k] = newAuth[k];
  if (newAuth.globalKey && !newAuth.apiToken) out.apiToken = '';
  return out;
}

/**
 * 合并账号列表，返回统计。
 * - replace：结果 = incoming；但与旧账号匹配上的，空的 auth 字段保留旧值。
 * - merge：以 current 为基础；匹配上的账号更新 name(非空时)、hosts(并集)、auth(字段级)；
 *   role/enabled/weight/limit/note 默认保持旧值（批量导入不应覆盖手工设置），opts.overwriteMeta=true 时用 incoming 覆盖；
 *   未匹配的追加。
 * @param {Account[]} current
 * @param {any[]} incoming
 * @param {{mode?:'merge'|'replace', overwriteMeta?:boolean}} [opts]
 * @returns {{accounts: Account[], added: number, updated: number}}
 */
export function mergeAccountsWithStats(current, incoming, opts = {}) {
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  const cur = normalizeAccounts(current);
  // 先不做 host 去重，以便和 current 匹配；最终再整体 normalize
  const inc = (Array.isArray(incoming) ? incoming : []).filter(isPlain).map((x) => normalizeOne(x));
  const used = new Set();
  let added = 0;
  let updated = 0;
  if (mode === 'replace') {
    const out = inc.map((a) => {
      const m = findMatch(cur, a, used);
      if (!m) { added++; return a; }
      used.add(m);
      updated++;
      return { ...a, id: a.id || m.id, auth: mergeAuth(m.auth, a.auth) };
    });
    return { accounts: normalizeAccounts(out), added, updated };
  }
  const out = cur.map((a) => ({ ...a, hosts: a.hosts.slice(), auth: { ...a.auth } }));
  const ids = new Set(out.map((a) => a.id));
  for (const a of inc) {
    const m = findMatch(out, a, used);
    if (m) {
      used.add(m);
      updated++;
      if (a.name) m.name = a.name;
      for (const h of a.hosts) if (!m.hosts.includes(h)) m.hosts.push(h);
      m.auth = mergeAuth(m.auth, a.auth);
      if (opts.overwriteMeta) for (const k of META_KEYS) m[k] = a[k];
    } else {
      added++;
      const id = uniqueId(a.id || deriveAccountId(a) || 'a' + (out.length + 1), ids);
      ids.add(id);
      const b = { ...a, id };
      used.add(b);
      out.push(b);
    }
  }
  return { accounts: normalizeAccounts(out), added, updated };
}

/**
 * 契约签名：合并账号列表（语义见 mergeAccountsWithStats）。
 * @returns {Account[]}
 */
export function mergeAccounts(current, incoming, opts = {}) {
  return mergeAccountsWithStats(current, incoming, opts).accounts;
}

/**
 * 把轮询时自动发现的 Cloudflare accountId（存于 UsageSnapshot.accounts[id].accountId）回填到账号配置。
 * @param {Account[]} accounts
 * @param {import('../types.js').UsageSnapshot} snapshot
 * @returns {{accounts: Account[], changed: boolean}}
 */
export function backfillAccountIds(accounts, snapshot) {
  let changed = false;
  const out = (accounts || []).map((a) => {
    const found = snapshot?.accounts?.[a.id]?.accountId;
    if (a.auth?.accountId || !found || !ACCOUNT_ID_RE.test(found)) return a;
    changed = true;
    return { ...a, auth: { ...a.auth, accountId: found } };
  });
  return { accounts: out, changed };
}
