// 多用户凭据：主站和节点共用的算法与常量（不读写任何存储）。
//
// 每个用户一条永久链接。节点路径前缀 /_u<用户ID>，该用户的 UUID / Trojan 密码 / SS 密钥都由
// HMAC(密钥, 用户ID) 算出——节点拿到路径里的用户 ID 自己算一遍就能验证，不需要用户名单、不发请求。
// 密钥只存在主站 KV 和各节点账号的 KV（主站推送），不写进任何链接。
//
// 在线统计与并行限制：节点把"用户 + IP 标记"写进本账号的 Analytics Engine（NT_AE），主站定时汇总所有账号，
// 算出封禁名单和超限用户允许的 IP，写进各节点账号的 KV（NT_MU）。节点每分钟读一次，在内存里判断。

export const MU_ID_RE = /^[a-z0-9]{8}$/;
/** 节点路径前缀：/_u<8 位用户 ID>，后面是原来的路径 */
export const MU_PATH_RE = /^\/_u([a-z0-9]{8})(?=\/|$)/;
export const muPathPrefix = (id) => '/_u' + id;
/** 节点账号 KV 与主站 KV 里存放下发状态的键 */
export const MU_STATE_KEY = 'nt.mu.state';
/** 节点 Pages 的绑定名（不能叫 KV：入口按"有没有 KV 绑定"区分主站和节点） */
export const MU_KV_BINDING = 'NT_MU';
export const MU_AE_BINDING = 'NT_AE';
/** 主站自动创建的 KV 命名空间标题、AE 数据集名 */
export const MU_KV_TITLE = 'nicetunnel-mu';
export const MU_DATASET = 'nicetunnel_mu';
/** 节点上报间隔：同一用户同一 IP 在同一实例里每 2 分钟最多写一条 */
export const MU_REPORT_MS = 2 * 60e3;
/** 在线窗口：最近 5 分钟有上报算在线 */
export const MU_ONLINE_WINDOW_MIN = 5;

const enc = new TextEncoder();
const keyCache = new Map();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256（十六进制） */
export async function hmacHex(secret, msg) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, key);
  }
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(String(msg))));
}

const memo = new Map();
async function memoHmac(secret, msg) {
  const k = secret + '\n' + msg;
  let v = memo.get(k);
  if (v) return v;
  v = await hmacHex(secret, msg);
  if (memo.size > 4096) memo.clear();
  memo.set(k, v);
  return v;
}

/** 用户的 UUID（同时作为 Trojan 密码、SS 密钥的来源）。保持 UUID v4 格式，客户端都认 */
export async function userUuid(secret, id) {
  const h = await memoHmac(secret, 'uuid:' + id);
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 20), h.slice(20, 32)].join('-');
}

/** 订阅令牌里的签名部分 */
export const userSubSig = async (secret, id) => (await memoHmac(secret, 'sub:' + id)).slice(0, 20);

/** 订阅令牌：<用户ID>.<签名> */
export async function userSubToken(secret, id) { return id + '.' + await userSubSig(secret, id); }

/** 解析订阅令牌（只检查格式） */
export function parseSubToken(t) {
  const m = /^([a-z0-9]{8})\.([0-9a-f]{20})$/.exec(String(t || ''));
  return m ? { id: m[1], sig: m[2] } : null;
}

/** IP 归一：IPv4 原样；IPv6 取 /64（同一台设备的临时地址会变，前缀不变） */
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s.includes(':')) return s;
  let parts = s.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const full = parts.length > 1 ? head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail) : head;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** IP 标记：不把原始 IP 写进统计，只写带密钥的短哈希；节点和主站算出来一样 */
export const ipTag = async (secret, ip) => (await memoHmac(secret, 'ip:' + ipKey(ip))).slice(0, 12);

/** 随机用户 ID（8 位小写字母数字） */
export function newUserId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => abc[x % abc.length]).join('');
}

/** 随机 64 位十六进制密钥 */
export function newSecret() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
