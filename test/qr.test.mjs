// 二维码：输出不能变（指纹来自优化前的实现），而且要快——Worker 免费版每请求只有 10ms CPU，
// 之前一次要 ~21ms，浏览器打开订阅页时会被 Cloudflare 掐断（ERR_CONNECTION_CLOSED）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qrSvg } from '../src/lib/qr.js';

const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

test('二维码输出与优化前一致', () => {
  assert.equal(fp(qrSvg('https://vp.example.com/sub?u=mthd355w.96e412f43a9e69ec5746', { px: 5 })), '59405b0204948bef');
  assert.equal(fp(qrSvg('https://a.b/sub?token=' + 'x'.repeat(150), { px: 5 })), 'c77565400e605244');
});

test('二维码生成够快（远低于 10ms）', () => {
  const u = 'https://vp.example.com/sub?u=mthd355w.96e412f43a9e69ec5746';
  qrSvg(u);
  // 全量测试并行跑时 CPU 会被别的测试抢：多跑几轮取最快的一轮（旧实现每次约 21ms，照样能抓出来）
  let avg = Infinity;
  for (let round = 0; round < 6; round++) {
    const t = performance.now();
    for (let i = 0; i < 5; i++) qrSvg(u, { px: 5 });
    avg = Math.min(avg, (performance.now() - t) / 5);
  }
  assert.ok(avg < 5, `平均 ${avg.toFixed(2)}ms`);
});
