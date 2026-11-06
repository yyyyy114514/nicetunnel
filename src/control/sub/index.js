// 订阅渲染入口：格式判定 + 分派到 mixed / base64 / clash / surge / singbox。
import { toProxyDescriptor, displayName } from './params.js';
import { renderMixedLinks, base64Utf8 } from './links.js';
import { parseNodeLink } from './linkparse.js';
import { resolveGroups, uniqueNames } from './groups.js';
import { parseIni, DEFAULT_INI_TEXT } from './ini.js';
import { clashProxy, clashProxyFromLink, renderClash } from './clash.js';
import { surgeName, surgeProxyLine, surgeLinkLine, renderSurge } from './surge.js';
import { singboxOutbound, singboxOutboundFromLink, renderSingbox, legacyDnsFor } from './singbox.js';
import { groupInterval } from '../allocator.js';
import { addHomeToClash } from '../homefeed.js';

export const FORMATS = ['mixed', 'base64', 'clash', 'singbox', 'surge'];
const ALIASES = { raw: 'mixed', b64: 'base64', sb: 'singbox', 'sing-box': 'singbox', mihomo: 'clash', meta: 'clash' };

export function normalizeFormat(f) {
  const k = String(f || '').toLowerCase();
  return FORMATS.includes(k) ? k : ALIASES[k] || 'mixed';
}

/**
 * 订阅格式判定（对齐上游 332–347 + 486 行）。
 * 上游 quanx / loon / target=其他 依赖外部 SUBAPI，本项目原生不支持 → 回退 mixed(base64)。
 * @param {URL} url
 * @param {string} ua
 * @returns {{format:string, unsupported?:string}|string}
 */
export function detectFormatInfo(url, ua) {
  const sp = url.searchParams;
  const u = String(ua || '').toLowerCase();
  const browser = u.includes('mozilla');
  const mixed = () => (browser && !sp.has('b64') && !sp.has('base64') ? 'mixed' : 'base64');
  if (sp.has('b64') || sp.has('base64') || u.includes('subconverter') || u.includes('cf-workers-sub')) return { format: 'base64' };
  if (sp.has('target')) {
    const t = sp.get('target').toLowerCase();
    if (t === 'clash' || t === 'clashr' || t === 'meta') return { format: 'clash' };
    if (t === 'singbox' || t === 'sing-box') return { format: 'singbox' };
    if (t === 'surge') return { format: 'surge' };
    if (t === 'mixed' || t === 'v2ray') return { format: mixed() };
    return { format: mixed(), unsupported: t };
  }
  if (sp.has('clash') || u.includes('clash') || u.includes('meta') || u.includes('mihomo') || u.includes('stash') || u.includes('verge')) return { format: 'clash' };
  if (sp.has('sb') || sp.has('singbox') || /sing-?box|sfa|sfi|sfm|karing|hiddify/.test(u)) return { format: 'singbox' };
  if (sp.has('surge') || u.includes('surge')) return { format: 'surge' };
  if (sp.has('quanx') || u.includes('quantumult')) return { format: mixed(), unsupported: 'quanx' };
  if (sp.has('loon') || u.includes('loon')) return { format: mixed(), unsupported: 'loon' };
  return { format: mixed() };
}

export function detectFormat(url, ua) {
  return detectFormatInfo(url, ua).format;
}

const CONTENT_TYPES = {
  clash: 'application/x-yaml; charset=utf-8',
  singbox: 'application/json; charset=utf-8',
};

/**
 * @param {{format:string, nodes: import('../../types.js').ResolvedNode[], ctx: object,
 *          ini?: import('./ini.js').IniModel|null, rules?: {block?: any, status?: string}|null}} o
 * @returns {{body:string, contentType:string, extraHeaders:Record<string,string>, warnings:string[]}}
 */
export function renderSubscription({ format, nodes, ctx, ini, rules }) {
  const fmt = normalizeFormat(format);
  const settings = ctx.settings;
  const c = { ...ctx, format: fmt };
  const warnings = [];
  const extraHeaders = {};
  let list = nodes.slice();
  if (settings?.sub?.sort) list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const nameOf = (d) => displayName(d, settings);

  if (fmt === 'mixed' || fmt === 'base64') {
    const text = renderMixedLinks(list, c, nameOf);
    return { body: fmt === 'base64' ? base64Utf8(text) : text, contentType: 'text/plain; charset=utf-8', extraHeaders, warnings };
  }

  const model = ini || parseIni(DEFAULT_INI_TEXT);
  // 1) 节点 → 各格式的代理条目（不支持的跳过）
  const entries = [];
  for (const n of list) {
    if (n.origin === 'link') {
      const l = parseNodeLink(n.link);
      if (!l) { warnings.push(`无法解析的节点链接已跳过：${String(n.name)}`); continue; }
      entries.push({ name: settings?.sub?.appendType ? `[${l.type.toUpperCase()}] ${n.name}` : n.name, link: l });
    } else if (n.address) {
      const d = toProxyDescriptor(n, c);
      entries.push({ name: nameOf(d), desc: d, cf: n.origin === 'random' || n.origin === 'best', tags: n.tags || [] });
    }
  }
  // 2) 名字唯一化（与组名/内置策略不冲突）
  const sanitize = fmt === 'surge' ? surgeName : (s) => s;
  const names = uniqueNames(entries.map((e) => e.name), model.groups.map((g) => sanitize(g.name)), sanitize);
  // 每个测速组的实际间隔：INI 值，额度吃紧时按 testPolicy 放慢（见 allocator.testPolicy）
  const policy = settings?.sub?.testPolicy || { min: Number(settings?.sub?.testIntervalMin) || 0, tight: 0, ceil: 1800 };
  const intervalOf = (iv) => groupInterval(iv, policy);
  const block = rules?.block || null;
  // url-test 组 INI 没写容差时给默认值：新节点只有明显更快才切换，避免相近节点之间来回抖动导致连接断续
  const tol = Number(settings?.sub?.tolerance) || 0;
  const withTol = (gs) => (tol > 0 ? gs.map((g) => (g.type === 'url-test' && g.tolerance === undefined ? { ...g, tolerance: tol } : g)) : gs);
  // 随机优选聚合：CF 随机/优选 IP 节点只出现在测速组里，不在手动选择列表里逐个列出（客户端只看到一个"随机优选"组）
  const aggregate = settings?.preferred?.random?.aggregate !== false;
  const hideOf = (kept) => (aggregate ? new Set(kept.filter((k) => k.cf).map((k) => k.name)) : null);
  if (rules?.status && rules.status !== 'expand') extraHeaders['X-NT-Rules'] = rules.status;
  // 公告：排在最前面的一个分组，名字就是公告，只含直连（选中也不影响上网）。notice 标记让渲染器选默认分组时跳过它
  const notice = String(settings?.sub?.announcement || '').trim();
  const withNotice = (gs, clean = (s) => s) => {
    if (!notice) return gs;
    let name = clean(notice);
    while (gs.some((g) => g.name === name)) name += ' ';
    return [{ name, type: 'select', proxies: ['DIRECT'], notice: true }, ...gs];
  };

  let body;
  if (fmt === 'clash') {
    const proxies = [];
    entries.forEach((e, i) => {
      const obj = e.desc ? clashProxy(e.desc, names[i]) : clashProxyFromLink(e.link, names[i]);
      if (obj) proxies.push({ name: names[i], obj, desc: e.desc, cf: e.cf, tags: e.tags || [] });
      else warnings.push(`Clash 不支持的节点已跳过：${names[i]}`);
    });
    let groups = withTol(resolveGroups(model, proxies.map((p) => p.name), warnings, { hide: hideOf(proxies) }));
    let list = proxies;
    // 家宽订阅：加 OpenVPN 住宅节点（经"家宽前置"组的 TLS 节点连过去）和家宽组
    if (c.home) {
      const h = addHomeToClash(c.home, proxies, groups);
      if (!h.added) warnings.push('家宽：没有可做前置的 TLS 节点');
      list = h.proxies;
      groups = h.groups;
    }
    body = renderClash({ proxies: list, groups: withNotice(groups), rules: block, ctx: c, intervalOf });
  } else if (fmt === 'surge') {
    const lines = [];
    const kept = [];
    const keptInfo = [];
    entries.forEach((e, i) => {
      const line = e.desc ? surgeProxyLine(e.desc, names[i]) : surgeLinkLine(e.link, names[i]);
      if (line) { lines.push(line); kept.push(names[i]); keptInfo.push({ name: names[i], cf: e.cf }); } else warnings.push(`Surge 不支持的节点已跳过：${names[i]}`);
    });
    const groups = withTol(resolveGroups({ ...model, groups: model.groups.map((g) => ({ ...g, name: surgeName(g.name), members: g.members.map((m) => (m.kind === 'ref' ? { ...m, value: surgeName(m.value) } : m)) })) }, kept, warnings, { hide: hideOf(keptInfo) }));
    const managedUrl = ctx.requestUrl || '';
    body = renderSurge({ proxyLines: lines, groups: withNotice(groups, surgeName), rules: block, managedUrl, updateHours: settings?.sub?.updateHours, intervalOf });
  } else {
    const outbounds = [];
    const sbInfo = [];
    entries.forEach((e, i) => {
      const o = e.desc ? singboxOutbound(e.desc, names[i]) : singboxOutboundFromLink(e.link, names[i]);
      if (o) { outbounds.push(o); sbInfo.push({ name: names[i], cf: e.cf }); } else warnings.push(`sing-box 不支持的节点已跳过：${names[i]}`);
    });
    const groups = withTol(resolveGroups(model, outbounds.map((o) => o.tag), warnings, { hide: hideOf(sbInfo) }));
    body = renderSingbox({ outbounds, groups: withNotice(groups), rules: block, intervalOf, legacyDns: legacyDnsFor(ctx.userAgent) });
  }
  if (warnings.length) extraHeaders['X-NT-Render-Warnings'] = String(warnings.length);
  return { body, contentType: CONTENT_TYPES[fmt] || 'text/plain; charset=utf-8', extraHeaders, warnings };
}
