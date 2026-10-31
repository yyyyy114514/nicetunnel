// 确定性哈希与伪随机：用于"稳定的加权分配"（同一客户端在同一时间窗内得到相同结果）。
// 全部为纯函数，无全局状态，可在 Node 与 Workers 中一致运行。

/** FNV-1a 32 位哈希 */
export function hash32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 雪崩混合（murmur3 finalizer），弥补 FNV 低位分布差
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** 返回 (0,1) 开区间的确定性浮点数（两个 32 位哈希拼成 53 位精度，永不为 0 或 1） */
export function hashUnit(str) {
  const a = hash32(str, 0x811c9dc5) >>> 5; // 27 位
  const b = hash32(str, 0x9747b28c) >>> 6; // 26 位
  return (a * 67108864 + b + 0.5) / 9007199254740992;
}

/**
 * 两个已哈希整数的配对哈希 → (0,1)。O(1)，用于"每个 slot × 每个 host"的 rendezvous 打分：
 * 先对 slot 与 host 各算一次字符串哈希，之后每一对只需几次整数运算（比对每对重新哈希长字符串快一个数量级）。
 */
export function pairUnit(a, b) {
  let x = (a ^ Math.imul(b ^ 0x5bd1e995, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return ((x >>> 0) + 0.5) / 4294967296;
}

/** mulberry32 伪随机数生成器：seed 可为数字或字符串，返回 () => [0,1) */
export function mulberry32(seed) {
  let a = (typeof seed === 'string' ? hash32(seed) : seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 洗牌（返回新数组，不修改入参） */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
