// 扫描/爆破防护：只用 isolate 内存，不读写 KV、不外拉、不额外消耗请求额度。
// 同一 IP 在 10 分钟内首包认证失败（UUID/密码不对或首包无法解析）达到 5 次，之后 30 分钟内
// 它的代理请求（WS 升级 / POST）直接拿伪装页，不再给 101 升级——扫描器第二次探测看不到任何代理特征，
// 爆破也无法继续试。正确 UUID 的客户端不会触发。多个 isolate 各自计数，属于有意的折衷。
const WINDOW_MS = 10 * 60e3;
const LIMIT = 5;
const BLOCK_MS = 30 * 60e3;
const MAX_ENTRIES = 4096;
const table = new Map(); // ip -> { n, first, until }

export function resetGuard() { table.clear(); }

/** 记录一次认证失败 */
export function reportAuthFail(ip, now = Date.now()) {
  if (!ip) return;
  let e = table.get(ip);
  if (!e || now - e.first > WINDOW_MS) {
    if (!e && table.size >= MAX_ENTRIES) table.delete(table.keys().next().value); // 最旧的先淘汰
    e = { n: 0, first: now, until: 0 };
    table.set(ip, e);
  }
  e.n++;
  if (e.n >= LIMIT) e.until = now + BLOCK_MS;
}

/** 该 IP 当前是否被封禁 */
export function isBlocked(ip, now = Date.now()) {
  const e = ip ? table.get(ip) : null;
  if (!e) return false;
  if (e.until && now < e.until) return true;
  if (e.until || now - e.first > WINDOW_MS) table.delete(ip);
  return false;
}
