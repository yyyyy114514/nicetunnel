// 订阅转换 INI 解析（语义对齐 subconverter 的 [custom] 段）。纯函数，无 I/O。
// 支持：ruleset= / surge_ruleset=（同义）、custom_proxy_group=、enable_rule_generator=、overwrite_original_rules=。
// 其他键（clash_rule_base 等）静默忽略；注释行以 ; 或 # 开头。

import { md5 } from '../../lib/md5.js';

/**
 * @typedef {{type:'url', value:string, format:'classical'|'domain'|'ipcidr', interval?:number}
 *   | {type:'inline', value:string}} RulesetSource
 * @typedef {{group:string, source:RulesetSource}} IniRuleset
 * @typedef {{kind:'ref'|'regex', value:string, re?:RegExp|null}} IniMember
 * @typedef {{url:string, interval:number, timeout?:number, tolerance?:number}} IniTest
 * @typedef {{name:string, type:'select'|'url-test'|'fallback'|'load-balance', members:IniMember[], test?:IniTest}} IniGroup
 * @typedef {{hash:string, rulesets:IniRuleset[], groups:IniGroup[],
 *   flags:{enableRuleGenerator:boolean, overwriteOriginalRules:boolean}, errors:string[]}} IniModel
 */

export const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance'];
const TEST_TYPES = new Set(['url-test', 'fallback', 'load-balance']);

// subconverter 的规则源前缀 → 规则文件格式
const SOURCE_PREFIXES = [
  ['clash-domain:', 'domain'],
  ['clash-ipcidr:', 'ipcidr'],
  ['clash-classic:', 'classical'],
  ['surge:', 'classical'],
  ['quanx:', 'classical'],
];

/** 内置兜底 INI：未配置/拉取失败时使用（两组节点 + 国内直连 + 漏网之鱼） */
export const DEFAULT_INI_TEXT = [
  '[custom]',
  'ruleset=🎯 全球直连,[]GEOIP,LAN,no-resolve',
  'ruleset=🎯 全球直连,[]GEOIP,CN',
  'ruleset=🐟 漏网之鱼,[]FINAL',
  'custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]🚀 机房优选`[]🏠 家宽优选`[]DIRECT`.*',
  'custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50',
  'custom_proxy_group=🚀 机房优选`url-test`CF`http://www.gstatic.com/generate_204`300,,50',
  'custom_proxy_group=🏠 家宽优选`url-test`住宅`http://www.gstatic.com/generate_204`300,,50',
  'custom_proxy_group=🎯 全球直连`select`[]DIRECT`[]🚀 节点选择',
  'custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]🎯 全球直连`.*',
  'enable_rule_generator=true',
  'overwrite_original_rules=true',
].join('\n');

/** INI 文本的稳定短哈希（用于 KV 键 nt.rules.<fmt>.<iniHash>） */
export function iniHash(text) {
  return md5(String(text ?? '')).slice(0, 12);
}

/**
 * 把 subconverter 风格的正则编译成 JS RegExp（支持开头的 (?i) 内联标志）。失败返回 null。
 * 语义为"搜索"（部分匹配），与 subconverter regFind 一致。
 * @param {string} src
 * @returns {RegExp|null}
 */
export function compileMemberRegex(src) {
  let pattern = String(src);
  let flags = 'u';
  if (pattern.startsWith('(?i)')) { pattern = pattern.slice(4); flags += 'i'; }
  try { return new RegExp(pattern, flags); } catch { /* 非 unicode 模式再试一次（兼容 \- 之类转义） */ }
  try { return new RegExp(pattern, flags.replace('u', '')); } catch { return null; }
}

/** 解析 "interval[,timeout][,tolerance]"（subconverter parseGroupTimes） */
function parseTimes(text) {
  const [iv, to, tol] = String(text ?? '').split(',').map((s) => s.trim());
  const out = { interval: Number(iv) > 0 ? Math.round(Number(iv)) : 300 };
  if (Number(to) > 0) out.timeout = Math.round(Number(to));
  if (Number(tol) >= 0 && tol !== '' && tol !== undefined) out.tolerance = Math.round(Number(tol));
  return out;
}

/** @returns {IniRuleset|null} */
function parseRulesetValue(value, errors, lineNo) {
  const comma = value.indexOf(',');
  if (comma <= 0) { errors.push(`第 ${lineNo} 行 ruleset 缺少组名或规则源`); return null; }
  const group = value.slice(0, comma).trim();
  let rest = value.slice(comma + 1).trim();
  if (!group || !rest) { errors.push(`第 ${lineNo} 行 ruleset 为空`); return null; }
  if (rest.startsWith('[]')) return { group, source: { type: 'inline', value: rest.slice(2).trim() } };
  // 可选的第三段：更新间隔（秒）
  let interval;
  const m = rest.match(/^(.*),\s*(\d+)\s*$/);
  if (m) { rest = m[1].trim(); interval = Number(m[2]); }
  let format = 'classical';
  for (const [prefix, fmt] of SOURCE_PREFIXES) {
    if (rest.toLowerCase().startsWith(prefix)) { rest = rest.slice(prefix.length).trim(); format = fmt; break; }
  }
  if (!/^https?:\/\//i.test(rest)) { errors.push(`第 ${lineNo} 行 ruleset 规则源不是 http(s) URL（不支持本地文件）：${rest}`); return null; }
  /** @type {RulesetSource} */
  const source = { type: 'url', value: rest, format };
  if (interval) source.interval = interval;
  return { group, source };
}

/** @returns {IniGroup|null} */
function parseGroupValue(value, errors, lineNo) {
  const parts = value.split('`');
  const name = (parts[0] || '').trim();
  const type = (parts[1] || '').trim().toLowerCase();
  if (!name) { errors.push(`第 ${lineNo} 行 custom_proxy_group 缺少组名`); return null; }
  if (!GROUP_TYPES.includes(type)) { errors.push(`第 ${lineNo} 行组「${name}」类型不支持：${type || '(空)'}`); return null; }
  let upper = parts.length;
  /** @type {IniTest|undefined} */
  let test;
  if (TEST_TYPES.has(type)) {
    if (parts.length < 5) { errors.push(`第 ${lineNo} 行组「${name}」(${type}) 需要 测速URL 与 间隔`); return null; }
    upper -= 2;
    test = { url: parts[upper].trim(), ...parseTimes(parts[upper + 1]) };
  }
  /** @type {IniMember[]} */
  const members = [];
  for (let i = 2; i < upper; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;
    if (raw.startsWith('[]')) { members.push({ kind: 'ref', value: raw.slice(2).trim() }); continue; }
    if (raw.startsWith('!!')) {
      errors.push(`组「${name}」成员「${raw}」使用了暂不支持的 subconverter 过滤语法，已忽略`);
      continue;
    }
    const re = compileMemberRegex(raw);
    if (!re) errors.push(`组「${name}」成员正则无效：${raw}`);
    members.push({ kind: 'regex', value: raw, re });
  }
  /** @type {IniGroup} */
  const g = { name, type: /** @type {any} */ (type), members };
  if (test) g.test = test;
  return g;
}

const truthy = (v) => /^(true|1|yes|on)$/i.test(String(v).trim());

/**
 * 解析 INI 文本。
 * @param {string} text
 * @returns {IniModel}
 */
export function parseIni(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  /** @type {IniModel} */
  const model = {
    hash: iniHash(src),
    rulesets: [],
    groups: [],
    flags: { enableRuleGenerator: true, overwriteOriginalRules: true },
    errors: [],
  };
  const seen = new Set();
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'ruleset' || key === 'surge_ruleset') {
      const r = parseRulesetValue(value, model.errors, i + 1);
      if (r) model.rulesets.push(r);
    } else if (key === 'custom_proxy_group') {
      const g = parseGroupValue(value, model.errors, i + 1);
      if (!g) continue;
      if (seen.has(g.name)) { model.errors.push(`组名重复，后者已忽略：${g.name}`); continue; }
      seen.add(g.name);
      model.groups.push(g);
    } else if (key === 'enable_rule_generator') {
      model.flags.enableRuleGenerator = truthy(value);
    } else if (key === 'overwrite_original_rules') {
      model.flags.overwriteOriginalRules = truthy(value);
    }
  }
  return model;
}

/** 所有 URL 型规则源（去重，保持首次出现顺序） */
export function rulesetUrls(ini) {
  const out = [];
  const seen = new Set();
  for (const r of ini?.rulesets || []) {
    if (r.source.type !== 'url') continue;
    const k = r.source.format + '|' + r.source.value;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: r.source.value, format: r.source.format });
  }
  return out;
}
