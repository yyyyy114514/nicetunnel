// 代理组展开：[]引用 + 正则匹配节点名（并集，按 INI 成员顺序、节点顺序），空组回退 DIRECT，检测环引用。

/** 客户端内置策略名（可被 [] 引用） */
export const BUILTIN_POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'REJECT-TINYGIF', 'PASS', 'COMPATIBLE']);

/**
 * @typedef {Object} ResolvedGroup
 * @property {string} name
 * @property {'select'|'url-test'|'fallback'|'load-balance'} type
 * @property {string[]} proxies     非空；元素为 节点名 / 组名 / 内置策略
 * @property {string} [url]
 * @property {number} [interval]
 * @property {number} [timeout]
 * @property {number} [tolerance]
 */

/**
 * 展开 INI 中的代理组。
 * @param {import('./ini.js').IniModel} ini
 * @param {string[]} proxyNames  最终（已唯一化）的节点名，顺序即输出顺序
 * @param {string[]} [errors]    可选：收集警告
 * @returns {ResolvedGroup[]}
 */
export function resolveGroups(ini, proxyNames, errors = [], opts = {}) {
  const groups = ini?.groups || [];
  const groupNames = new Set(groups.map((g) => g.name));
  const nameSet = new Set(proxyNames);
  /** @type {ResolvedGroup[]} */
  const out = [];
  for (const g of groups) {
    const list = [];
    const added = new Set();
    const push = (n) => { if (!added.has(n)) { added.add(n); list.push(n); } };
    for (const m of g.members) {
      if (m.kind === 'ref') {
        if (m.value === g.name) { errors.push(`组「${g.name}」引用了自身，已忽略`); continue; }
        if (BUILTIN_POLICIES.has(m.value) || groupNames.has(m.value) || nameSet.has(m.value)) push(m.value);
        else errors.push(`组「${g.name}」引用的「${m.value}」不存在，已忽略`);
      } else if (m.re) {
        const re = m.re;
        for (const n of proxyNames) if (re.test(n)) push(n);
      }
    }
    /** @type {ResolvedGroup} */
    const r = { name: g.name, type: g.type, proxies: list };
    if (g.test) {
      r.url = g.test.url;
      r.interval = g.test.interval;
      if (g.test.timeout !== undefined) r.timeout = g.test.timeout;
      if (g.test.tolerance !== undefined) r.tolerance = g.test.tolerance;
    }
    out.push(r);
  }
  breakCycles(out, groupNames, errors);
  if (opts.hide?.size) hideInSelectGroups(out, opts.hide);
  for (const r of out) if (!r.proxies.length) r.proxies.push('DIRECT');
  return out;
}

/**
 * 聚合显示：hide 里的节点（CF 随机/优选 IP）不再出现在 select 组的成员里，只留在 url-test / fallback / load-balance 组里。
 * 安全保护：只有"至少被一个测速类组引用"的节点才会被隐藏（否则隐藏后就没法选到了）；
 * 一个 select 组如果被隐藏后会变空，则保持原样。
 * @param {ResolvedGroup[]} groups
 * @param {Set<string>} hide
 */
function hideInSelectGroups(groups, hide) {
  const reachable = new Set();
  for (const g of groups) if (g.type !== 'select') for (const p of g.proxies) reachable.add(p);
  for (const g of groups) {
    if (g.type !== 'select') continue;
    const kept = g.proxies.filter((p) => !(hide.has(p) && reachable.has(p)));
    if (kept.length) g.proxies = kept;
  }
}

/**
 * DFS 检测组之间的环引用；遇到回边时把该引用从父组移除（客户端会拒绝含环配置）。
 * @param {ResolvedGroup[]} groups
 * @param {Set<string>} groupNames
 * @param {string[]} errors
 */
function breakCycles(groups, groupNames, errors) {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const state = new Map(); // 0/undefined=未访问 1=访问中 2=完成
  const visit = (g) => {
    state.set(g.name, 1);
    for (let i = 0; i < g.proxies.length; i++) {
      const ref = g.proxies[i];
      if (!groupNames.has(ref)) continue;
      const st = state.get(ref);
      if (st === 1) {
        errors.push(`检测到组环引用：「${g.name}」→「${ref}」，已移除该引用`);
        g.proxies.splice(i, 1);
        i--;
      } else if (st !== 2) {
        visit(byName.get(ref));
      }
    }
    state.set(g.name, 2);
  };
  for (const g of groups) if (!state.get(g.name)) visit(g);
}

/**
 * 让节点名在"节点 + 组 + 内置策略"范围内唯一（Clash 要求代理名与组名不冲突）。
 * 冲突时追加 " 2"、" 3"…；返回新数组，不修改入参。
 * @param {string[]} names
 * @param {Iterable<string>} reserved
 * @param {(s:string)=>string} [sanitize]
 */
export function uniqueNames(names, reserved, sanitize = (s) => s) {
  const used = new Set(reserved);
  for (const b of BUILTIN_POLICIES) used.add(b);
  const out = [];
  for (const raw of names) {
    const base = sanitize(String(raw ?? '').trim()) || 'node';
    let n = base;
    for (let k = 2; used.has(n); k++) n = `${base} ${k}`;
    used.add(n);
    out.push(n);
  }
  return out;
}
