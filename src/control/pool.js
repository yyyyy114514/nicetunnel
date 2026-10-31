// "兜底(随机优选)"节点池：无状态、确定性、渐进轮换。
// 上游 生成随机IP()（5878–5909 行）每次请求都 Math.random 全量重抽，客户端测速结果每次作废；
// 这里改为：同一 (isp, 窗口, slot) 在任何 isolate 得到相同 IP；每个窗口只有约 rotatePercent% 的 slot 换新。

import { hashUnit, hash32 } from '../lib/rand.js';
import { ISP_LABEL } from '../lib/isp.js';
import { splitList, parseCidr, intToIpv4, isIPv4, cidrContains } from '../lib/text.js';
import { buildNodePath, nodeId } from './nodes.js';

/** 上游默认 CIDR 仓库：raw.githubusercontent.com/<特征码字典[1]>/<特征码字典[1]>/main */
export const DEFAULT_CIDR_BASE = 'https://raw.githubusercontent.com/cmliu/cmliu/main';
/** 上游 CIDR 拉取失败时的回退 */
export const FALLBACK_CIDRS = Object.freeze(['104.16.0.0/13']);
/** 最多向前回溯的窗口数 */
export const MAX_LOOKBACK = 48;
const ISPS = ['ct', 'cu', 'cmcc', 'cf'];
const MAX_SALT_TRIES = 16;

/**
 * 解析最终使用的运营商：设置非 auto 时以设置为准，否则用请求识别结果（缺省 cf）。
 * @param {string} settingIsp settings.preferred.random.isp
 * @param {string} [detected] detectIsp(request.cf) 的结果
 * @returns {'ct'|'cu'|'cmcc'|'cf'}
 */
export function resolveIsp(settingIsp, detected) {
  if (ISPS.includes(settingIsp)) return /** @type {any} */ (settingIsp);
  return ISPS.includes(detected) ? /** @type {any} */ (detected) : 'cf';
}

/**
 * CIDR 来源 URL。与上游一致：cf → `${base}/CF-CIDR.txt`，其余 → `${base}/CF-CIDR/${isp}.txt`。
 * 自定义 base：含 `{isp}` 占位则替换；以 .txt 结尾视为单一文件（所有运营商共用）；否则视为同布局的目录。
 * @param {string} isp
 * @param {string} [base]
 */
export function cidrSourceUrl(isp, base) {
  const code = ISPS.includes(isp) ? isp : 'cf';
  const b = String(base || '').trim();
  if (b.includes('{isp}')) return b.replace(/\{isp\}/g, code);
  if (/\.txt(\?.*)?$/i.test(b)) return b;
  const dir = (b || DEFAULT_CIDR_BASE).replace(/\/+$/, '');
  return code === 'cf' ? `${dir}/CF-CIDR.txt` : `${dir}/CF-CIDR/${code}.txt`;
}

/**
 * 解析 CIDR 文本（上游用 整理成数组；这里额外按空白切分、只保留合法 IPv4 CIDR、规范化为网络地址并去重）。
 * 裸 IPv4 视为 /32；IPv6 忽略（上游的生成算法只支持 IPv4）。
 * @param {string} text
 * @returns {string[]}
 */
export function parseCidrList(text) {
  const out = [], seen = new Set();
  for (const item of splitList(String(text || '').replace(/[ ;；]+/g, '\n'))) {
    if (item.startsWith('#')) continue;
    const c = parseCidr(item);
    if (!c || seen.has(c.text)) continue;
    seen.add(c.text);
    out.push(c.text);
  }
  return out;
}

/**
 * 拉取某运营商的 CIDR 列表（给 Cron / 后台 test-source 用；订阅热路径应读 KV 缓存 nt.cidr.<isp>）。
 * 失败回退 104.16.0.0/13（与上游一致）。
 * @returns {Promise<{cidrs:string[], ok:boolean, url:string, error?:string}>}
 */
export async function fetchCidrList({ isp, settings, fetchFn = globalThis.fetch, timeoutMs = 5000 }) {
  const url = cidrSourceUrl(isp, settings?.preferred?.random?.cidrBase);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cidrs = parseCidrList(await res.text());
    if (!cidrs.length) throw new Error('CIDR 列表为空');
    return { cidrs, ok: true, url };
  } catch (err) {
    return { cidrs: FALLBACK_CIDRS.slice(), ok: false, url, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 黑名单匹配：含 '/' 按 CIDR；合法 IPv4 精确匹配；其他按字符串前缀（如 '104.16.'） */
function makeBlacklist(list) {
  const items = (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean);
  if (!items.length) return () => false;
  return (ip) => items.some((b) => (b.includes('/') ? cidrContains(b, ip) : isIPv4(b) ? b === ip : ip.startsWith(b)));
}

/** 在 CIDR 内按哈希均匀取一个地址；/24 及更大的段跳过末位 .0/.255，/30 及更大的小段跳过网络/广播地址 */
function pickInCidr(c, key) {
  const hostBits = 32 - c.prefix;
  for (let t = 0; t < 8; t++) {
    const off = Math.floor(hashUnit(`${key}|o${t}`) * c.size);
    const n = (c.base + off) >>> 0;
    const last = n & 255;
    if (hostBits >= 8 && (last === 0 || last === 255)) continue;
    if (hostBits >= 2 && hostBits < 8 && (off === 0 || off === c.size - 1)) continue;
    return intToIpv4(n);
  }
  return intToIpv4((c.base + (c.size > 2 ? 1 : 0)) >>> 0);
}

/**
 * slot 在窗口 w 时所处的"代"：向前最多回溯 MAX_LOOKBACK 个窗口，找最近一次 hashUnit(`rot|i|k`) < p 的 k；
 * 找不到为初代 -1。p 为 0 时永不轮换，p 为 1 时每窗口都换。
 */
export function slotGeneration(slot, windowIndex, rotateFraction) {
  if (rotateFraction <= 0) return -1;
  for (let k = windowIndex; k > windowIndex - MAX_LOOKBACK; k--) {
    if (rotateFraction >= 1 || hashUnit(`rot|${slot}|${k}`) < rotateFraction) return k;
  }
  return -1;
}

/**
 * 无状态确定性随机池。
 * @param {{cidrs:string[], settings:object, isp:string, now:number, count?:number}} o
 * @returns {{ip:string, port:number, slot:number, gen:number}[]}
 */
export function evolveRandomPool({ cidrs, settings, isp, now, count, good }) {
  const r = settings?.preferred?.random || {};
  const n = Math.max(0, Math.floor(count ?? r.count ?? 16));
  if (!n) return [];
  let parsed = (Array.isArray(cidrs) ? cidrs : []).map(parseCidr).filter(Boolean);
  if (!parsed.length) parsed = FALLBACK_CIDRS.map(parseCidr);
  const ports = Array.isArray(r.ports) && r.ports.length ? r.ports : [443, 2053, 2083, 2087, 2096, 8443];
  // 质量策略：
  //  1) good（优选订阅/测速结果里的"已知可用"地址）占比 goodRatio 的 slot，按 slot 确定性取用，不够再回落 CIDR；
  //  2) 同一订阅内任意两个节点不落在同一 /24（避免一个坏段拖垮多个节点，也让客户端测速更有区分度）；
  //  3) 端口按 portBias 倾向 443（TLS 端口里 443 的可达性最好）。
  const goodList = (Array.isArray(good) ? good : []).filter((g) => g && isIPv4(g.ip));
  const goodSlots = goodList.length ? Math.min(n, Math.round(n * Math.min(1, Math.max(0, Number(r.goodRatio ?? 0.5))))) : 0;
  const portBias = Math.min(0.95, Math.max(0, Number(r.portBias ?? 0.5)));
  const seg24 = new Set();
  const stable = r.stable || {};
  const windowMs = Math.max(1, Number(stable.windowMinutes) || 60) * 60000;
  const w = Math.floor(now / windowMs);
  // 关闭稳定池 = 每个窗口全部换新（仍保持同窗口内各 isolate 一致）
  const rp = Number(stable.rotatePercent);
  const p = stable.enabled === false ? 1 : Math.min(1, Math.max(0, (Number.isFinite(rp) ? rp : 25) / 100));
  const blocked = makeBlacklist(r.blacklist);
  const used = new Set();
  const out = [];
  const net24 = (ip) => ip.slice(0, ip.lastIndexOf('.'));
  for (let slot = 0; slot < n; slot++) {
    const gen = slotGeneration(slot, w, p);
    let ip = null, fixedPort = 0;
    if (slot < goodSlots) {
      // 已知可用地址：按 (slot, 代) 确定性取，轮换时才会换
      for (let salt = 0; salt < 8 && !ip; salt++) {
        const g = goodList[hash32(`good|${isp}|${slot}|${gen}|${salt}`) % goodList.length];
        if (blocked(g.ip) || used.has(g.ip) || seg24.has(net24(g.ip))) continue;
        ip = g.ip; fixedPort = Number(g.port) || 0;
      }
    }
    for (let salt = 0; salt < MAX_SALT_TRIES && !ip; salt++) {
      const key = `ip|${isp}|${slot}|${gen}|${salt}`;
      // 与上游一致：先等概率选 CIDR，再在段内均匀取址
      const c = parsed[hash32(key) % parsed.length];
      const cand = pickInCidr(c, key);
      // 前 MAX_SALT_TRIES-4 次要求不同 /24；最后几次放宽（CIDR 很小时仍能出点）
      if (blocked(cand) || used.has(cand) || (salt < MAX_SALT_TRIES - 4 && seg24.has(net24(cand)))) continue;
      ip = cand;
    }
    if (!ip) continue; // 黑名单覆盖了几乎所有候选：跳过该 slot（有界）
    used.add(ip);
    seg24.add(net24(ip));
    let port = fixedPort;
    if (!port) {
      const pu = hashUnit(`pb|${isp}|${slot}|${gen}`);
      port = ports.includes(443) && pu < portBias ? 443 : Number(ports[hash32(`port|${isp}|${slot}|${gen}`) % ports.length]);
    }
    out.push({ ip, port, slot, gen });
  }
  return out;
}

/**
 * 兜底节点：名字 `${namePrefix}-${官方|电信|联通|移动}-NN`（NN = slot+1，两位），刷新后同一 slot 名字不变。
 * @param {{settings:object, cidrs:string[], isp:string, uuid?:string, now:number}} o  isp 为识别结果，内部会按设置 resolveIsp
 * @returns {import('../types.js').NodeSpec[]}
 */
export function buildRandomNodes({ settings, cidrs, isp, uuid, now, good }) { // eslint-disable-line no-unused-vars
  const r = settings?.preferred?.random || {};
  if (r.enabled === false) return [];
  const code = resolveIsp(r.isp, isp);
  const { path } = buildNodePath(settings);
  const prefix = r.namePrefix || 'CF';
  const label = ISP_LABEL[code] || '官方';
  return evolveRandomPool({ cidrs, settings, isp: code, now, good }).map(({ ip, port, slot }) => ({
    id: nodeId({ address: ip, port, path }),
    name: `${prefix}-${label}-${String(slot + 1).padStart(2, '0')}`,
    origin: 'random',
    address: ip,
    port,
    path,
    tags: ['random', code],
  }));
}
