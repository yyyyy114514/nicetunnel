// 最小二维码生成器（零依赖）：字节模式、纠错等级 M、版本 1~10（最多 213 字节，订阅链接够用）。
// 输出模块矩阵（true = 黑），以及 SVG。浏览器端也能用：qrSvg 会被内联进页面脚本。

// 纠错等级 M：每个版本的 [每块纠错码字数, [块数, 每块数据码字数], ...]
const EC_M = [null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

// GF(256)，本原多项式 0x11D
const EXP = new Array(512), LOG = new Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function rsRemainder(data, n) {
  const gen = rsGenerator(n);
  const res = new Array(n).fill(0);
  for (const b of data) {
    const f = b ^ res[0];
    res.shift(); res.push(0);
    for (let i = 0; i < n; i++) res[i] ^= gmul(gen[i + 1], f);
  }
  return res;
}

const dataCapacity = (v) => EC_M[v].slice(1).reduce((s, [n, k]) => s + n * k, 0);

/** 文本 → 模块矩阵（二维布尔数组）。超过版本 10 的容量时抛错 */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let v = 1;
  while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(v) * 8) v++;
  if (v > 10) throw new Error('内容太长，二维码放不下');
  // 数据位流
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCapacity(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);
  // 分块 + 纠错 + 交织
  const ecLen = EC_M[v][0];
  const blocks = [];
  let at = 0;
  for (const [n, k] of EC_M[v].slice(1)) for (let i = 0; i < n; i++) { const d = data.slice(at, at + k); at += k; blocks.push({ d, e: rsRemainder(d, ecLen) }); }
  const out = [];
  const maxK = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxK; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);

  const size = v * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false)); // 功能区（不放数据、不加掩码）
  const set = (r, c, dark) => { m[r][c] = dark; fn[r][c] = true; };
  // 定位图形 + 分隔符
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
    }
  }
  // 时序图形
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // 校正图形
  const al = ALIGN[v];
  const last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    // 只跳过与三个定位图形重叠的角（压在时序线上的照画，覆盖时序线）
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    const r = al[i], c = al[j];
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // 预留格式信息区、暗模块、版本信息区
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
  // 放数据（右下角起，两列一组之字形）
  const allBits = [];
  for (const b of out) for (let i = 7; i >= 0; i--) allBits.push((b >>> i) & 1);
  for (let i = 0; i < REMAINDER[v]; i++) allBits.push(0);
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        m[r][c] = idx < allBits.length ? allBits[idx] === 1 : false;
        idx++;
      }
    }
  }
  // 选掩码（罚分最低）
  const masks = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const withMask = (k) => {
    const g = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && masks[k](r, c)) g[r][c] = !g[r][c];
    // 格式信息：纠错等级 M = 00
    let rem = k; // (00 << 3) | k
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((k << 10) | rem) ^ 0x5412;
    const bit = (i) => ((fbits >>> i) & 1) === 1;
    // 第一份：左上定位图形旁边（第 8 列自上而下，再第 8 行自右向左）
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
    g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
    // 第二份：右上（第 8 行）和左下（第 8 列）
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
    g[size - 8][8] = true;
    return g;
  };
  const penalty = (g) => {
    let p = 0;
    const line = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
        for (let b = 0; b + 10 < size; b++) {
          const s = Array.from({ length: 11 }, (_, i) => (get(a, b + i) ? 1 : 0)).join('');
          if (s === '10111010000' || s === '00001011101') p += 40;
        }
      }
    };
    line((a, b) => g[a][b]);
    line((a, b) => g[b][a]);
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const x = g[r][c]; if (x === g[r + 1][c] && x === g[r][c + 1] && x === g[r + 1][c + 1]) p += 3; }
    const dark = g.reduce((s, row) => s + row.filter(Boolean).length, 0);
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };
  let best = null, bestP = Infinity;
  for (let k = 0; k < 8; k++) { const g = withMask(k); const pp = penalty(g); if (pp < bestP) { bestP = pp; best = g; } }
  return best;
}

/** 文本 → SVG 字符串（带 4 模块静区） */
export function qrSvg(text, { px = 4, dark = '#000', light = '#fff' } = {}) {
  const g = qrMatrix(text);
  const n = g.length, q = 4, w = (n + q * 2) * px;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) d += `M${(c + q) * px} ${(r + q) * px}h${px}v${px}h-${px}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${w}" height="${w}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
