// "优质(自定义)"节点来源：自定义文本（等价上游 ADD.txt / 本地订阅）+ 远程优选 API + sub:// 汇聚订阅。
// 逐项对齐上游 _worker.js：本地订阅分支（356–394 行）、请求优选API()、获取优选订阅生成器数据()。
// 缓存：注入的 Map 型 cache {get,set}；TTL = settings.preferred.custom.refreshSeconds，过期后 SWR（先返回旧值，
// 刷新 promise 交给调用方 ctx.waitUntil），失败保留旧值最多 24h。网络/时间全部注入，便于单测。

import { splitList, parseAddressLine, safeDecode, looksLikeBase64, decodeBase64Utf8 } from '../lib/text.js';

/** 上游 汇聚订阅_UA（特征码字典[1] = 'cmliu'） */
export const SOURCE_UA = 'v2rayN/edgetunnel (https://github.com/cmliu/edgetunnel)';
/** 上游 EDT_版本号（与 vendored edt-core 的上游版本 2026-10-08 22:23:27 一致） */
export const UPSTREAM_VERSION_NUM = 20261008222327;
export const FETCH_TIMEOUT_MS = 3000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_STALE_MS = 24 * 3600 * 1000;
/** 失败来源的最短重试间隔 */
export const FAILURE_RETRY_MS = 60 * 1000;
/** 上游 汇聚订阅占位：优选订阅生成器返回的节点用它们标记"这是优选 IP 行" */
const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
const PLACEHOLDER_HOST = 'example.com';
const LINK_LINE_RE = /^[a-z][a-z0-9+\-.]*:\/\//i;

/**
 * 一条自定义来源条目。
 * @typedef {Object} CustomEntry
 * @property {'addr'|'link'} kind
 * @property {string} [address]   优选入口（IPv6 不带方括号；wildcard=true 时含 '*'，渲染前由 nodes.js 用 replaceStars 展开）
 * @property {number} [port]
 * @property {string|null} [remark] 原始备注（可能含 `$sstp://…` 链式指令与 ` [API备注]` 后缀）
 * @property {boolean} [wildcard] 地址含 '*' 通配（仅本地行，与上游一致）
 * @property {boolean} [proxyIp]  来自 proxyip=true 的来源：该 addr:port 同时进入"反代IP池"（上游 请求优选API 第 4 项）
 * @property {string} [link]      kind='link' 时的完整节点链接
 * @property {string} source      'local' 或来源 URL 原文
 */

// ---------------------------------------------------------------------------
// 本地文本分类（上游 363–388 行）
// ---------------------------------------------------------------------------
/**
 * 把自定义文本拆成：本地地址条目、本地完整链接、需要远程拉取的来源（https/http/sub://）。
 * @param {string} text
 * @returns {{addrs: CustomEntry[], links: CustomEntry[], remotes: string[], invalid: string[]}}
 */
export function classifyCustomText(text) {
  const addrs = [], links = [], remotes = [], invalid = [];
  for (const el of splitList(text)) {
    const lower = el.toLowerCase();
    if (lower.startsWith('sub://')) { remotes.push(el); continue; }
    const hashPos = el.indexOf('#');
    const addrPart = hashPos > -1 ? el.slice(0, hashPos) : el;
    const remarkPart = hashPos > -1 ? el.slice(hashPos) : '';
    const subMatch = el.match(/sub\s*=\s*([^\s&#]+)/i);
    if (subMatch && subMatch[1].trim().includes('.')) {
      // `xxx?sub=host` 简写 → sub://host[?proxyip=true][#备注]（上游只取第一个 # 之后到下一个 # 之前）
      const asProxy = lower.includes('proxyip=true');
      remotes.push('sub://' + subMatch[1].trim() + (asProxy ? '?proxyip=true' : '') + (el.includes('#') ? '#' + el.split('#')[1] : ''));
    } else if (/^https?:\/\//i.test(addrPart)) {
      // 上游只把 https:// 视为优选 API；这里 http:// 也当作 API（DESIGN 要求 http(s)），见报告
      remotes.push(el);
    } else if (addrPart.includes('://')) {
      // 其他协议链接（vless:// trojan:// …）原样作为"其他节点"，备注做一次 URI 规范化
      const link = el.includes('#') ? el.split('#')[0] + '#' + encodeURIComponent(safeDecode(el.split('#')[1])) : el;
      links.push({ kind: 'link', link, source: 'local' });
    } else {
      const entry = parseLocalAddress(addrPart, remarkPart);
      if (entry) addrs.push(entry); else invalid.push(el);
    }
  }
  return { addrs, links, remotes, invalid };
}

/** 本地地址行（支持 '*' 通配：用占位字母校验格式，保留原始 '*' 以便确定性 id 与按请求展开） */
function parseLocalAddress(addrPart, remarkPart) {
  const raw = addrPart.trim();
  const wildcard = raw.includes('*');
  const parsed = parseAddressLine((wildcard ? raw.replace(/\*/g, 'x') : raw) + remarkPart);
  if (!parsed) return null;
  let address = parsed.address;
  if (wildcard) {
    address = parsed.port !== null ? raw.slice(0, raw.lastIndexOf(':')) : raw;
    if (address.startsWith('[')) address = address.slice(1, -1);
  }
  const e = { kind: 'addr', address, port: parsed.port ?? 443, remark: parsed.remark, source: 'local' };
  if (wildcard) e.wildcard = true;
  return e;
}

// ---------------------------------------------------------------------------
// 远程内容解析（上游 请求优选API 6065–6166 行；纯函数，供 admin/getADDAPI 与 test-source 复用）
// ---------------------------------------------------------------------------
/**
 * 解析优选 API 返回的文本。
 * @param {string} text
 * @param {{url:string, defaultPort?:string|number, apiRemark?:string|null, asProxyIp?:boolean}} opt
 *        url 为去掉 #备注 的 API 地址（读取其中的 ?port=）
 * @returns {{kind:'links'|'lines'|'csv'|'unsupported'|'empty', items:string[], links:string[], proxyPool:string[]}}
 *          items 为 `addr:port#备注` 形式（与上游 results 一致）
 */
export function parsePreferredApiText(text, { url, defaultPort = '443', apiRemark = null, asProxyIp = false }) {
  const items = [], links = [], proxyPool = [];
  if (!text || !text.trim()) return { kind: 'empty', items, links, proxyPool };
  let content = text;
  if (looksLikeBase64(text)) {
    const decoded = decodeBase64Utf8(text.replace(/\s/g, ''));
    if (decoded !== null) content = decoded;
  }
  // 上游已注释掉 Clash/sing-box 配置的识别；这里显式拒绝，避免把 YAML 行当成节点链接
  if (/^\s*proxies\s*:/m.test(content) || (content.includes('"outbounds"') && content.includes('"inbounds"'))) {
    return { kind: 'unsupported', items, links, proxyPool };
  }
  if (content.split('#')[0].includes('://')) {
    for (const line of content.split(/\r?\n/)) {
      const l = line.trim();
      if (!LINK_LINE_RE.test(l)) continue;
      links.push(apiRemark ? appendLinkRemark(l, apiRemark) : l);
    }
    return { kind: 'links', items, links, proxyPool };
  }
  // 注：上游这里用的是未解码的 text；对 base64 编码的纯地址列表我们用解码后的内容（见报告）
  const lines = content.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const isCSV = lines.length > 1 && lines[0].includes(',');
  const IPV6_PATTERN = /^[^\[\]]*:[^\[\]]*:[^\[\]]/;
  let qsPort = null;
  try { qsPort = new URL(url).searchParams.get('port'); } catch { /* 非法 URL：用默认端口 */ }
  const port = qsPort || String(defaultPort);
  const tagged = (item, csv) => (apiRemark ? (csv || item.includes('#') ? `${item} [${apiRemark}]` : `${item}#[${apiRemark}]`) : item);
  if (!isCSV) {
    for (const line of lines) {
      const hi = line.indexOf('#');
      const hostPart = hi > -1 ? line.slice(0, hi) : line;
      const remark = hi > -1 ? line.slice(hi) : '';
      let hasPort;
      if (hostPart.startsWith('[')) hasPort = /\]:(\d+)$/.test(hostPart);
      else {
        const ci = hostPart.lastIndexOf(':');
        hasPort = ci > -1 && /^\d+$/.test(hostPart.slice(ci + 1));
      }
      const ipItem = hasPort ? line : `${hostPart}:${port}${remark}`;
      items.push(tagged(ipItem, false));
      if (asProxyIp) proxyPool.push(ipItem.split('#')[0]);
    }
    return { kind: 'lines', items, links, proxyPool };
  }
  const headers = lines[0].split(',').map((h) => h.trim());
  const data = lines.slice(1);
  if (headers.includes('IP地址') && headers.includes('端口') && headers.includes('数据中心')) {
    const ipIdx = headers.indexOf('IP地址'), portIdx = headers.indexOf('端口');
    const remarkIdx = headers.indexOf('国家') > -1 ? headers.indexOf('国家') : headers.indexOf('城市') > -1 ? headers.indexOf('城市') : headers.indexOf('数据中心');
    const tlsIdx = headers.indexOf('TLS');
    for (const line of data) {
      const cols = line.split(',').map((c) => c.trim());
      if (tlsIdx !== -1 && cols[tlsIdx]?.toLowerCase() !== 'true') continue;
      const ip = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
      items.push(tagged(`${ip}:${cols[portIdx]}#${cols[remarkIdx]}`, true));
      if (asProxyIp) proxyPool.push(`${ip}:${cols[portIdx]}`);
    }
  } else if (headers.some((h) => h.includes('IP')) && headers.some((h) => h.includes('延迟')) && headers.some((h) => h.includes('下载速度'))) {
    const ipIdx = headers.findIndex((h) => h.includes('IP'));
    const delayIdx = headers.findIndex((h) => h.includes('延迟'));
    const speedIdx = headers.findIndex((h) => h.includes('下载速度'));
    for (const line of data) {
      const cols = line.split(',').map((c) => c.trim());
      const ip = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
      items.push(tagged(`${ip}:${port}#CF优选 ${cols[delayIdx]}ms ${cols[speedIdx]}MB/s`, true));
      if (asProxyIp) proxyPool.push(`${ip}:${port}`);
    }
  }
  return { kind: 'csv', items, links, proxyPool };
}

/** 给链接追加 API 备注（上游：已有 # 则追加编码后的 " [备注]"，否则追加编码后的 "#[备注]"） */
function appendLinkRemark(link, remark) {
  return link.includes('#') ? link + encodeURIComponent(` [${remark}]`) : link + encodeURIComponent(`#[${remark}]`);
}

/**
 * 解析优选订阅生成器（sub://）返回的 base64 订阅（上游 获取优选订阅生成器数据 5943–5962 行）。
 * 同时含占位 UUID 与 example.com 的行 → 优选地址 `addr:port#备注`；其余行 → 其他节点链接。
 * @param {string} body 响应原文（base64）
 * @returns {{items:string[], links:string[]}}
 */
export function parseSubGeneratorBody(body) {
  const items = [], links = [];
  const text = decodeBase64Utf8(String(body || '').replace(/\s/g, ''));
  if (text === null) throw new Error('返回内容不是 base64 订阅');
  for (const line of text.includes('\r\n') ? text.split('\r\n') : text.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes(PLACEHOLDER_UUID) && line.includes(PLACEHOLDER_HOST)) {
      const m = line.match(/:\/\/[^@]+@([^?]+)/);
      if (m) {
        const r = line.match(/#(.+)$/);
        items.push(m[1] + (r ? '#' + safeDecode(r[1]) : ''));
      }
    } else if (LINK_LINE_RE.test(line.trim())) {
      links.push(line.trim());
    }
  }
  return { items, links };
}

/** sub://host → 生成器请求 URL（上游：https 化、去 #/?、取 origin、拼 /sub?host=example.com&uuid=占位） */
export function subGeneratorUrl(el) {
  let h = el.replace(/^sub:\/\//i, 'https://').split('#')[0].split('?')[0];
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  return `${new URL(h).origin}/sub?host=${PLACEHOLDER_HOST}&uuid=${PLACEHOLDER_UUID}`;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------
/**
 * 带超时（覆盖整个读取过程）与体积上限的 GET。
 * @returns {Promise<string>} 已解码文本
 */
export async function fetchTextLimited(url, { fetchFn, headers = {}, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES }) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error(`超时(${timeoutMs}ms)`)); }, timeoutMs);
  });
  const work = (async () => {
    const res = await fetchFn(url, { signal: ctrl.signal, headers });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '无响应'}`);
    const buf = await readCapped(res, maxBytes, ctrl);
    return decodeBody(buf, res.headers?.get?.('content-type') || '');
  })();
  work.catch(() => {}); // 超时后 work 的迟到异常不能成为未处理拒绝
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, maxBytes, ctrl) {
  const len = Number(res.headers?.get?.('content-length'));
  if (len > maxBytes) { ctrl.abort(); throw new Error(`内容过大(${len}B)`); }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* 忽略 */ } throw new Error(`内容超过 ${maxBytes}B`); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`内容超过 ${maxBytes}B`);
  return buf;
}

/** 上游：按 Content-Type 的 charset 决定先试 utf-8 还是 gb2312，解码失败换下一个 */
function decodeBody(buf, contentType) {
  const charset = (contentType.toLowerCase().match(/charset=([^\s;]+)/i)?.[1] || '').toLowerCase();
  const order = charset.includes('gb') ? ['gb2312', 'utf-8'] : ['utf-8', 'gb2312'];
  for (const enc of order) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { /* 下一个 */ }
  }
  return new TextDecoder('utf-8').decode(buf);
}

/**
 * 拉取并解析一个远程来源（https/http 优选 API 或 sub:// 汇聚订阅）。
 * @param {string} el 来源原文（可含 #备注 与 proxyip=true）
 * @returns {Promise<{entries: CustomEntry[], links: CustomEntry[], kind: string}>} 失败抛异常
 */
export async function fetchRemoteSource(el, { fetchFn, uuid = '', timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES, defaultPort = '443' }) {
  const hi = el.indexOf('#');
  const urlNoHash = hi > -1 ? el.slice(0, hi) : el;
  const apiRemark = hi > -1 ? safeDecode(el.slice(hi + 1)) : null;
  const asProxyIp = el.toLowerCase().includes('proxyip=true');
  const headers = { 'User-Agent': `${SOURCE_UA} Uid/0x${String(uuid).slice(1, 7)} Version/${UPSTREAM_VERSION_NUM}` };
  let items, links, kind;
  if (urlNoHash.toLowerCase().startsWith('sub://')) {
    const body = await fetchTextLimited(subGeneratorUrl(urlNoHash), { fetchFn, headers, timeoutMs, maxBytes });
    const r = parseSubGeneratorBody(body);
    kind = 'sub';
    items = apiRemark ? r.items.map((ip) => (ip.includes('#') ? `${ip} [${apiRemark}]` : `${ip}#[${apiRemark}]`)) : r.items;
    links = apiRemark ? r.links.map((l) => appendLinkRemark(l, apiRemark)) : r.links;
  } else {
    const body = await fetchTextLimited(urlNoHash, { fetchFn, headers, timeoutMs, maxBytes });
    const r = parsePreferredApiText(body, { url: urlNoHash, defaultPort, apiRemark, asProxyIp });
    if (r.kind === 'unsupported') throw new Error('不支持 Clash/sing-box 配置格式');
    ({ items, links, kind } = r);
  }
  const entries = [];
  for (const it of items) {
    const p = parseAddressLine(it);
    if (!p) continue; // 上游渲染时同样丢弃不规范行
    const e = { kind: 'addr', address: p.address, port: p.port ?? 443, remark: p.remark, source: el };
    if (asProxyIp) e.proxyIp = true;
    entries.push(e);
  }
  return { entries, links: links.map((link) => ({ kind: 'link', link, source: el })), kind };
}

// ---------------------------------------------------------------------------
// 缓存 + SWR
// ---------------------------------------------------------------------------
const inflightByCache = new WeakMap();
const cacheKey = (el) => 'nt.src|' + el;
// 缓存条数上限：超过时淘汰最早写入的（Map 按插入顺序；写入前先删再插，保持"最近写入在后"）
export const SOURCE_CACHE_MAX = 64;
function cachePut(cache, key, val) {
  cache.delete(key);
  cache.set(key, val);
  while (cache.size > SOURCE_CACHE_MAX) cache.delete(cache.keys().next().value);
}

function inflightMap(cache) {
  let m = inflightByCache.get(cache);
  if (!m) { m = new Map(); inflightByCache.set(cache, m); }
  return m;
}

/** 刷新一个来源并写缓存；同一 cache 内对同一来源去重。失败保留旧值（只更新 checkedAt/error）。永不 reject。 */
function refreshSource(el, { cache, fetchFn, now, uuid }) {
  const inflight = inflightMap(cache);
  const key = cacheKey(el);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const prev = cache.get(key);
    try {
      const r = await fetchRemoteSource(el, { fetchFn, uuid });
      if (!r.entries.length && !r.links.length) throw new Error('来源返回 0 条可用节点');
      const val = { entries: r.entries, links: r.links, fetchedAt: now, checkedAt: now, error: null };
      cachePut(cache, key, val);
      return val;
    } catch (err) {
      const msg = String(err?.message || err);
      // 有旧值则保留（是否仍可用由 loadCustomEntries 按 24h 判断）；无旧值则写一条负缓存
      cachePut(cache, key, prev ? { ...prev, checkedAt: now, error: msg } : { entries: [], links: [], fetchedAt: 0, checkedAt: now, error: msg });
      return { error: msg };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * 加载"优质(自定义)"条目。
 * @param {{text?:string, settings:object, fetchFn?:Function, now:number, cache?:{get:Function,set:Function}, uuid?:string}} o
 * @returns {Promise<{entries: CustomEntry[], warnings: string[], fetchedAt: number, stale: boolean, refreshPromise?: Promise<void>}>}
 *   entries 顺序：本地地址 → 远程地址（按来源顺序）→ 本地链接 → 远程链接。
 *   stale=true 表示至少一个来源返回的是过期旧值，此时 refreshPromise 交给 ctx.waitUntil。
 */
export async function loadCustomEntries({ text, settings, fetchFn = globalThis.fetch, now, cache, uuid = '' }) {
  const cfg = settings?.preferred?.custom || {};
  const warnings = [];
  if (cfg.enabled === false) return { entries: [], warnings, fetchedAt: now, stale: false };
  const src = typeof text === 'string' ? text : cfg.text || '';
  const store = cache || new Map();
  const ttlMs = Math.max(1, Number(cfg.refreshSeconds) || 300) * 1000;

  const local = classifyCustomText(src);
  if (local.invalid.length) warnings.push(`忽略 ${local.invalid.length} 行不规范地址：${local.invalid.slice(0, 3).join(' | ')}`);

  const remotes = [...new Set(local.remotes)];
  let stale = false, oldest = now;
  const background = [];
  const results = await Promise.all(remotes.map(async (el) => {
    const cached = store.get(cacheKey(el));
    const usable = !!cached && cached.fetchedAt > 0 && now - cached.fetchedAt <= MAX_STALE_MS;
    // 最近失败过的来源 1 分钟（或更短的 TTL）后再试，避免每个请求都等 3s 超时
    const recheckMs = cached?.error ? Math.min(ttlMs, FAILURE_RETRY_MS) : ttlMs;
    if (cached && now - cached.checkedAt < recheckMs) {
      if (usable) return cached;
      warnings.push(`来源失败 ${el}：${cached.error || '无可用缓存'}`);
      return null;
    }
    if (usable) {
      stale = true;
      background.push(refreshSource(el, { cache: store, fetchFn, now, uuid }));
      return cached;
    }
    const fresh = await refreshSource(el, { cache: store, fetchFn, now, uuid });
    if (fresh.entries) return fresh;
    warnings.push(`来源失败 ${el}：${fresh.error}`);
    return null;
  }));

  const addrs = local.addrs.slice(), links = local.links.slice();
  results.forEach((r, i) => {
    if (!r) return;
    if (r.error) warnings.push(`来源 ${remotes[i]} 最近刷新失败（使用 ${Math.round((now - r.fetchedAt) / 60000)} 分钟前的缓存）：${r.error}`);
    if (r.fetchedAt < oldest) oldest = r.fetchedAt;
    for (const e of r.entries) addrs.push(e);
    for (const l of r.links) links.push(l);
  });

  const out = { entries: addrs.concat(links), warnings, fetchedAt: oldest, stale };
  if (background.length) out.refreshPromise = Promise.all(background).then(() => undefined);
  return out;
}
