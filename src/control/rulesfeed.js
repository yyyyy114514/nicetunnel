// 规则供给：INI（订阅转换配置）+ 规则列表的拉取、规范化与拼装。
//  - Cron / 后台手动：refreshRulesStep 每次只刷少量列表（CPU 10ms 约束），内容变化时才写 KV。
//  - 订阅热路径：loadRules 只读缓存好的拼装块（isolate 内存 10 分钟），不写 KV；块缺失时回退 provider 模式。
// KV 键：nt.rules.ini（INI 文本）、nt.rules.index（各列表状态）、nt.rules.list.<h>（规范化列表）、nt.rules.<fmt>.<iniHash>（拼装块）
import { parseIni, rulesetUrls, iniHash, DEFAULT_INI_TEXT } from './sub/ini.js';
import { BUILTIN_POLICIES } from './sub/groups.js';
import { surgeName } from './sub/surge.js';
import { normalizeFormat } from './sub/index.js';
import { hash32 } from '../lib/rand.js';

export const RULES_KEYS = {
  ini: 'nt.rules.ini',
  index: 'nt.rules.index',
  list: (h) => `nt.rules.list.${h}`,
  block: (fmt, ih) => `nt.rules.${fmt}.${ih}`,
};
export const RULE_FORMATS = ['clash', 'surge', 'singbox'];
/** 规则块的存储格式版本：改变块里的字段（如 clash 的预缩进 yaml）时递增，旧块会在下一次刷新时自动重建 */
export const BLOCK_FMT = 2;
const G = '__NT_G__'; // 组名占位符：拼装时用原生 replaceAll 替换
const BLOCK_TTL = 10 * 60e3;
const MAX_LIST_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 8000;
const SINGBOX_GEOIP_CN = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs';

const CLASH_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'GEOSITE', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'GEOIP',
  'SRC-GEOIP', 'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT', 'IN-PORT', 'PROCESS-NAME', 'PROCESS-PATH', 'NETWORK']);
const SURGE_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN', 'USER-AGENT', 'URL-REGEX',
  'PROCESS-NAME', 'DEST-PORT', 'SRC-IP', 'IN-PORT', 'PROTOCOL']);
const RENAME = { surge: { 'DST-PORT': 'DEST-PORT', 'SRC-IP-CIDR': 'SRC-IP' }, clash: { 'DEST-PORT': 'DST-PORT', 'SRC-IP': 'SRC-IP-CIDR' } };
// 会破坏 YAML 普通标量的字符（这类规则本身也基本非法，直接丢弃）
const YAML_RISKY = /: |\s#|["'{}[\]`]|^[-?:,&*!|>%@]/;

export const listHash = (url) => iniHash('list|' + url);

// ---------------- isolate 级缓存 ----------------
const iso = { iniText: new Map(), iniModel: new Map(), provider: new Map(), inflight: null };
export function resetRulesState() { iso.iniText.clear(); iso.iniModel.clear(); iso.provider.clear(); iso.inflight = null; }

function modelOf(text) {
  const h = iniHash(text);
  let m = iso.iniModel.get(h);
  if (!m) {
    m = parseIni(text);
    if (iso.iniModel.size > 4) iso.iniModel.clear();
    iso.iniModel.set(h, m);
  }
  return m;
}

async function fetchText(fetchFn, url, limit) {
  const opt = { headers: { 'User-Agent': 'nicetunnel-rules' } };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(FETCH_TIMEOUT);
  const res = await fetchFn(url, opt);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > limit) throw new Error('内容过大');
  return text;
}

// ---------------- 规范化（Cron 侧，每个列表只做一次） ----------------

/**
 * 把一个规则列表文本规范化为三种格式的"带组名占位符"文本。
 * @param {string} text
 * @param {'classical'|'domain'|'ipcidr'} srcFormat
 * @returns {{clash:string, surge:string, singbox:string, n:number}}
 */
export function normalizeList(text, srcFormat = 'classical') {
  const clash = [], surge = [];
  const sb = { domain: [], domain_suffix: [], domain_keyword: [], domain_regex: [], ip_cidr: [], port: [], process_name: [] };
  let n = 0;
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';' || line.startsWith('//') || line === 'payload:') continue;
    if (line.startsWith('- ')) line = line.slice(2).trim().replace(/^['"]|['"]$/g, '');
    let type, value, nr = false;
    if (srcFormat === 'domain') {
      if (line.startsWith('+.') || line.startsWith('.')) { type = 'DOMAIN-SUFFIX'; value = line.replace(/^\+?\./, ''); } else { type = 'DOMAIN'; value = line; }
    } else if (srcFormat === 'ipcidr') {
      type = line.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'; value = line; nr = true;
    } else {
      const parts = line.split(',').map((s) => s.trim());
      type = parts[0].toUpperCase(); value = parts[1];
      nr = parts.slice(2).some((p) => p.toLowerCase() === 'no-resolve');
      if (type === 'IP6-CIDR') type = 'IP-CIDR6';
    }
    if (!value || type === 'AND' || type === 'OR' || type === 'NOT') continue;
    if (YAML_RISKY.test(value)) continue;
    n++;
    const ct = RENAME.clash[type] || type;
    if (CLASH_TYPES.has(ct)) clash.push(`${ct},${value},${G}${nr ? ',no-resolve' : ''}`);
    const st = RENAME.surge[type] || type;
    if (SURGE_TYPES.has(st)) surge.push(`${st},${value},${G}${nr ? ',no-resolve' : ''}`);
    if (type === 'DOMAIN') sb.domain.push(value);
    else if (type === 'DOMAIN-SUFFIX') sb.domain_suffix.push(value);
    else if (type === 'DOMAIN-KEYWORD') sb.domain_keyword.push(value);
    else if (type === 'DOMAIN-REGEX') sb.domain_regex.push(value);
    else if (type === 'IP-CIDR' || type === 'IP-CIDR6') sb.ip_cidr.push(value);
    else if ((type === 'DST-PORT' || type === 'DEST-PORT') && /^\d+$/.test(value)) sb.port.push(Number(value));
    else if (type === 'PROCESS-NAME') sb.process_name.push(value);
  }
  // sing-box：一个列表 = 1~2 条 headless rule（域名类与 IP 类分开，避免 AND 语义误判：同一条规则内不同字段是 OR 关系，安全起见仍拆开）
  const objs = [];
  const dom = {}, ip = {};
  for (const k of ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'process_name']) if (sb[k].length) dom[k] = sb[k];
  if (sb.port.length) dom.port = sb.port;
  if (sb.ip_cidr.length) ip.ip_cidr = sb.ip_cidr;
  if (Object.keys(dom).length) objs.push(JSON.stringify({ ...dom, outbound: G }));
  if (Object.keys(ip).length) objs.push(JSON.stringify({ ...ip, outbound: G }));
  return { clash: clash.join('\n'), surge: surge.join('\n'), singbox: objs.join(','), n };
}

// ---------------- 组名 / 内联规则 / provider ----------------

function groupName(fmt, g) {
  if (fmt === 'surge') return surgeName(g);
  return g;
}

/** 内联规则（[]GEOIP,CN / []FINAL …）→ 单条规则文本或 sing-box 规则 JSON；不适用返回 '' */
export function inlineRule(fmt, value, group, ctx) {
  const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const type = (parts[0] || '').toUpperCase();
  const nr = parts.slice(2).some((p) => p.toLowerCase() === 'no-resolve');
  const g = groupName(fmt, group);
  if (type === 'FINAL' || type === 'MATCH') {
    if (fmt === 'singbox') { ctx.final = g === 'DIRECT' ? 'direct' : g; return ''; }
    return `${fmt === 'clash' ? 'MATCH' : 'FINAL'},${g}`;
  }
  if (!parts[1]) return '';
  if (fmt === 'singbox') {
    if (type === 'GEOIP' && parts[1].toUpperCase() === 'LAN') return ''; // 已由 ip_is_private 覆盖
    let rule;
    if (type === 'GEOIP' && parts[1].toUpperCase() === 'CN') {
      ctx.ruleSets.set('geoip-cn', { type: 'remote', tag: 'geoip-cn', format: 'binary', url: SINGBOX_GEOIP_CN, download_detour: 'direct' });
      rule = { rule_set: 'geoip-cn' };
    } else {
      const n = normalizeList(`${type},${parts[1]}`);
      return n.singbox ? sbOutbound(n.singbox, group) : '';
    }
    return sbOutbound(JSON.stringify({ ...rule, outbound: G }), group);
  }
  if (fmt === 'surge' && type === 'GEOIP' && parts[1].toUpperCase() === 'LAN') return '';
  return `${type},${parts[1]},${g}${nr ? ',no-resolve' : ''}`;
}

/** sing-box 规则里的组名替换：DIRECT→direct，REJECT→action:reject */
function sbOutbound(text, group) {
  if (!text) return '';
  if (group === 'REJECT' || group.startsWith('REJECT-')) return text.replaceAll(`"outbound":"${G}"`, '"action":"reject"');
  return text.replaceAll(G, group === 'DIRECT' ? 'direct' : JSON.stringify(group).slice(1, -1));
}

function providerFormat(url) {
  const p = url.split('?')[0].toLowerCase();
  if (p.endsWith('.yaml') || p.endsWith('.yml')) return 'yaml';
  if (p.endsWith('.mrs')) return 'mrs';
  return 'text';
}
const mirrored = (url, mirror) => (mirror ? mirror.replace(/\/?$/, '/') + url : url);

/** 单个 URL 规则集的 provider 写法（规则块缺失 / provider 模式 / 部分列表未就绪时使用） */
function providerRule(fmt, rs, idx, settings, acc) {
  const url = mirrored(rs.source.value, settings?.rules?.providerMirror);
  const g = groupName(fmt, rs.group);
  if (fmt === 'clash') {
    const name = `r${idx}-${listHash(rs.source.value).slice(0, 6)}`;
    acc.providers.push({ name, url, behavior: rs.source.format, format: providerFormat(url), interval: rs.source.interval || 86400 });
    return `RULE-SET,${name},${g}`;
  }
  if (fmt === 'surge') return `${rs.source.format === 'domain' ? 'DOMAIN-SET' : 'RULE-SET'},${url},${g}`;
  // sing-box 只能引用 .srs / .json 规则集；普通 .list 无法使用
  const p = url.split('?')[0].toLowerCase();
  if (!p.endsWith('.srs') && !p.endsWith('.json')) { acc.skipped++; return ''; }
  const tag = `r${idx}-${listHash(rs.source.value).slice(0, 6)}`;
  acc.ruleSets.set(tag, { type: 'remote', tag, format: p.endsWith('.srs') ? 'binary' : 'source', url, download_detour: 'direct' });
  return sbOutbound(JSON.stringify({ rule_set: tag, outbound: G }), rs.group);
}

/** 规则集的目标组是否存在（INI 组或内置策略） */
function groupExists(ini, g) {
  return BUILTIN_POLICIES.has(g) || ini.groups.some((x) => x.name === g);
}

/**
 * 拼装某格式的规则块。
 * @param {import('./sub/ini.js').IniModel} ini
 * @param {'clash'|'surge'|'singbox'} fmt
 * @param {Map<string, {clash:string, surge:string, singbox:string}>|null} lists  按 listHash 索引；null = 全部走 provider
 */
export function assembleBlock(ini, fmt, lists, settings) {
  const acc = { providers: [], ruleSets: new Map(), final: '', skipped: 0 };
  const out = [];
  let complete = true;
  const quoteAll = fmt === 'clash' && ini.groups.some((g) => YAML_RISKY.test(g.name));
  ini.rulesets.forEach((rs, idx) => {
    if (!groupExists(ini, rs.group)) return;
    let piece = '';
    if (rs.source.type === 'inline') piece = inlineRule(fmt, rs.source.value, rs.group, acc);
    else {
      const doc = lists?.get(listHash(rs.source.value));
      if (doc && typeof doc[fmt] === 'string') {
        piece = fmt === 'singbox' ? sbOutbound(doc.singbox, rs.group) : doc[fmt].replaceAll(G, groupName(fmt, rs.group));
      } else {
        if (lists) complete = false;
        piece = providerRule(fmt, rs, idx, settings, acc);
      }
    }
    if (piece) out.push(piece);
  });
  if (fmt === 'singbox') return { rules: out.join(','), ruleSets: [...acc.ruleSets.values()], final: acc.final || ini.groups[0]?.name || 'direct', complete };
  let rules = out.join('\n');
  if (quoteAll) rules = rules.split('\n').map((l) => JSON.stringify(l)).join('\n');
  // 没有 FINAL/MATCH 时补一条兜底
  if (!/^(MATCH|FINAL),/m.test(rules) && ini.groups[0]) rules += (rules ? '\n' : '') + `${fmt === 'clash' ? 'MATCH' : 'FINAL'},${groupName(fmt, ini.groups[0].name)}`;
  // clash：额外存一份已缩进成 YAML 列表的文本（在 Cron 里一次做好，订阅热路径不再逐行处理）
  return fmt === 'clash' ? { rules, yaml: rules ? '  - ' + rules.split('\n').join('\n  - ') : '', providers: acc.providers, complete } : { rules, complete };
}

// ---------------- 订阅热路径 ----------------

/** 取 INI 文本：configText > KV 缓存 > isolate 内存（后台拉取） > 内置默认 */
async function resolveIniText({ store, settings, fetchFn, now, waitUntil }) {
  const r = settings.rules;
  if (r.configText && r.configText.trim()) return { text: r.configText, source: 'text' };
  if (!r.configUrl) return { text: DEFAULT_INI_TEXT, source: 'default' };
  const doc = await store.getJson(RULES_KEYS.ini, BLOCK_TTL);
  if (doc && doc.url === r.configUrl && doc.text) return { text: doc.text, source: 'kv' };
  const mem = iso.iniText.get(r.configUrl);
  if (mem) return { text: mem.text, source: 'memory' };
  if (!iso.inflight && fetchFn) {
    iso.inflight = fetchText(fetchFn, r.configUrl, 512 * 1024)
      .then((text) => { iso.iniText.set(r.configUrl, { text, at: now }); })
      .catch(() => {}).finally(() => { iso.inflight = null; });
    waitUntil?.(iso.inflight);
  }
  return { text: DEFAULT_INI_TEXT, source: 'default' };
}

/**
 * @param {{store:any, settings:any, fetchFn?:typeof fetch, now?:number, waitUntil?:(p:Promise<any>)=>void, format:string}} o
 * @returns {Promise<{ini: import('./sub/ini.js').IniModel, block: any, status: string}>}
 */
export async function loadRules({ store, settings, fetchFn, now = Date.now(), waitUntil, format }) {
  const { text, source } = await resolveIniText({ store, settings, fetchFn, now, waitUntil });
  const ini = modelOf(text);
  const fmt = normalizeFormat(format);
  if (!RULE_FORMATS.includes(fmt)) return { ini, block: null, status: source === 'default' ? 'default-ini' : 'none' };
  const providerBlock = () => {
    const k = `${fmt}|${ini.hash}|${settings.rules.providerMirror || ''}`;
    let b = iso.provider.get(k);
    if (!b) {
      b = assembleBlock(ini, fmt, null, settings);
      if (iso.provider.size > 12) iso.provider.clear();
      iso.provider.set(k, b);
    }
    return b;
  };
  if (settings.rules.mode === 'provider') return { ini, block: providerBlock(), status: 'provider' };
  const block = await store.getJson(RULES_KEYS.block(fmt, ini.hash), BLOCK_TTL);
  if (!block) return { ini, block: providerBlock(), status: 'provider-fallback' };
  return { ini, block, status: block.complete ? 'expand' : 'partial' };
}

// ---------------- Cron / 后台：小块刷新 ----------------

/**
 * 从远程 URL 获取转换配置（INI）并保存到 KV。之后订阅只读 KV（实例内存再缓存 10 分钟），不再访问远程。
 * 只在内容变化时才写 KV（节省每天 1000 次的写入预算）。拉取远程是子请求，不计入 Workers 请求数。
 * @param {{store:any, settings:any, fetchFn?:typeof fetch, now?:number, url?:string}} o
 * @returns {Promise<{ok:boolean, url:string, changed:boolean, bytes:number, groups:number, rulesets:number, errors:string[], hash:string, error?:string}>}
 */
export async function fetchAndSaveIni({ store, settings, fetchFn = globalThis.fetch, now = Date.now(), url }) {
  const target = String(url || settings?.rules?.configUrl || '').trim();
  const fail = (error) => ({ ok: false, url: target, changed: false, bytes: 0, groups: 0, rulesets: 0, errors: [], hash: '', error });
  if (!/^https?:\/\//i.test(target)) return fail('请先填写 INI 地址（http/https）');
  if (!store?.kvBound) return fail('未绑定 KV，无法保存');
  let text;
  try { text = await fetchText(fetchFn, target, 512 * 1024); } catch (e) { return fail('获取失败：' + (e?.message || e)); }
  const ini = parseIni(text);
  if (!ini.groups.length && !ini.rulesets.length) return fail('内容里没有 ruleset= / custom_proxy_group=，不像是转换配置，已放弃保存');
  const old = await store.getJson(RULES_KEYS.ini, 0);
  const changed = !old || old.url !== target || old.text !== text;
  if (changed) await store.putJson(RULES_KEYS.ini, { url: target, text, fetchedAt: now }, BLOCK_TTL);
  iso.iniText.set(target, { text, at: now });
  return { ok: true, url: target, changed, bytes: text.length, groups: ini.groups.length, rulesets: ini.rulesets.length, errors: ini.errors, hash: ini.hash };
}

/**
 * @param {{store:any, settings:any, fetchFn?:typeof fetch, now?:number, maxLists?:number}} o
 * @returns {Promise<{updated:string[], pending:number, errors:string[], built:boolean}>}
 */
export async function refreshRulesStep({ store, settings, fetchFn = globalThis.fetch, now = Date.now(), maxLists = 1 }) {
  const res = { updated: [], pending: 0, errors: [], built: false };
  if (!store?.kvBound) { res.errors.push('未绑定 KV，无法缓存规则'); return res; }
  const r = settings.rules;
  const maxAge = Math.max(1, Number(r.refreshHours) || 24) * 3600e3;
  let budget = Math.max(1, maxLists | 0);

  // 1) INI
  let text = r.configText && r.configText.trim() ? r.configText : '';
  if (!text) {
    const doc = await store.getJson(RULES_KEYS.ini, 0);
    text = doc && doc.url === r.configUrl ? doc.text : '';
    // iniAutoRefresh=false：已有缓存时不再自动拉取（只通过后台"获取并保存"更新）；没有缓存时仍会拉一次
    const autoRefresh = r.iniAutoRefresh !== false;
    if (r.configUrl && (!text || (autoRefresh && now - (doc?.fetchedAt || 0) > maxAge))) {
      budget--;
      try {
        const t = await fetchText(fetchFn, r.configUrl, 512 * 1024);
        if (t !== text || !doc || doc.url !== r.configUrl) { text = t; res.updated.push(r.configUrl); }
        await store.putJson(RULES_KEYS.ini, { url: r.configUrl, text: t, fetchedAt: now }, BLOCK_TTL);
      } catch (e) { res.errors.push(`INI 拉取失败：${e.message}`); }
    }
    if (!text) text = DEFAULT_INI_TEXT;
  }
  const ini = modelOf(text);

  // 2) 列表
  const urls = rulesetUrls(ini);
  const index = (await store.getJson(RULES_KEYS.index, 0)) || { lists: {}, built: {} };
  index.lists ||= {}; index.built ||= {};
  let indexDirty = false, listsChanged = false;
  const isStale = (e) => !e || (e.ok === false ? now - e.fetchedAt > 30 * 60e3 : now - e.fetchedAt > maxAge);
  const stale = urls.filter((u) => isStale(index.lists[listHash(u.url)]))
    .sort((a, b) => (index.lists[listHash(a.url)]?.fetchedAt || 0) - (index.lists[listHash(b.url)]?.fetchedAt || 0));
  for (const u of stale) {
    if (budget <= 0) break;
    budget--;
    const h = listHash(u.url);
    const prev = index.lists[h];
    try {
      const raw = await fetchText(fetchFn, u.url, MAX_LIST_BYTES);
      const doc = normalizeList(raw, u.format);
      const sig = hash32(doc.clash + doc.surge + doc.singbox).toString(16) + ':' + doc.n;
      if (!prev || prev.sig !== sig) {
        await store.putJson(RULES_KEYS.list(h), { url: u.url, ...doc }, BLOCK_TTL);
        listsChanged = true;
        res.updated.push(u.url);
      }
      index.lists[h] = { url: u.url, fetchedAt: now, ok: true, n: doc.n, sig };
    } catch (e) {
      res.errors.push(`${u.url}：${e.message}`);
      index.lists[h] = { ...(prev || { url: u.url, sig: '' }), fetchedAt: now, ok: false, err: String(e.message).slice(0, 120) };
    }
    indexDirty = true;
  }
  res.pending = urls.filter((u) => isStale(index.lists[listHash(u.url)])).length;

  // 3) 拼装（列表或 INI 变化时）
  // 签名里带上"块格式版本"：升级程序后（块里多了 yaml 等字段）第一次刷新会自动重建所有规则块，不用手动清缓存
  const listsSig = hash32(urls.map((u) => index.lists[listHash(u.url)]?.sig || '-').join('|')).toString(16) + 'f' + BLOCK_FMT;
  if (listsChanged || index.built[ini.hash] !== listsSig) {
    const lists = new Map();
    const docs = await Promise.all(urls.map((u) => (index.lists[listHash(u.url)]?.sig ? store.getJson(RULES_KEYS.list(listHash(u.url)), BLOCK_TTL) : null)));
    urls.forEach((u, i) => { if (docs[i]) lists.set(listHash(u.url), docs[i]); });
    for (const fmt of RULE_FORMATS) {
      const b = assembleBlock(ini, fmt, lists, settings);
      await store.putJson(RULES_KEYS.block(fmt, ini.hash), { ...b, builtAt: now }, BLOCK_TTL);
    }
    index.built = { [ini.hash]: listsSig };
    indexDirty = true;
    res.built = true;
  }
  // 清理已不在 INI 里的列表索引（KV 里的列表文档留着无害）
  const keep = new Set(urls.map((u) => listHash(u.url)));
  for (const h of Object.keys(index.lists)) if (!keep.has(h)) { delete index.lists[h]; indexDirty = true; }
  if (indexDirty) await store.putJson(RULES_KEYS.index, index, BLOCK_TTL);
  return res;
}

/** 后台状态（GET /admin/api/state 的 rules 字段） */
export async function getRulesStatus({ store }) {
  if (!store?.kvBound) return { lists: [], lastRefreshAt: 0 };
  const [index, iniDoc] = await Promise.all([store.getJson(RULES_KEYS.index, 30e3), store.getJson(RULES_KEYS.ini, 30e3)]);
  const lists = Object.values(index?.lists || {}).map((e) => ({ url: e.url, fetchedAt: e.fetchedAt, ok: e.ok, n: e.n || 0, err: e.err || '' }));
  let ini = null;
  if (iniDoc?.text) {
    const m = parseIni(iniDoc.text);
    ini = { url: iniDoc.url, fetchedAt: iniDoc.fetchedAt, bytes: iniDoc.text.length, groups: m.groups.length, rulesets: m.rulesets.length, errors: m.errors };
  }
  return { lists, ini, lastRefreshAt: lists.reduce((m, e) => Math.max(m, e.fetchedAt || 0), 0) };
}
