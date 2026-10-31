// SSTP 降 CPU 的正确性：同步取包 / 跨块拼包 / 负载不拷贝 / 批量构帧 后数据仍逐字节正确，校验和仍正确
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sstpConnect } from '../src/dataplane/edt-core.js';
import { fakeServer, sstpData, ipTcp } from './sstp-fake.mjs';

const open = async (srv) => {
  const t = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  t.closed.catch(() => {});
  return t;
};

function csum(bytes) {
  let s = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) s += (bytes[i] << 8) | bytes[i + 1];
  if (bytes.length & 1) s += bytes[bytes.length - 1] << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return s;
}
// 一个 SSTP 写出里可能有多个帧（批量构帧），逐个切开
function splitFrames(buf) {
  const out = [];
  for (let o = 0; o + 4 <= buf.length;) { const len = ((buf[o + 2] & 0x0f) << 8) | buf[o + 3]; out.push(buf.subarray(o, o + len)); o += len; }
  return out;
}
function frameOk(f) {
  const ip = f.subarray(8, 28), tcp = f.subarray(28);
  const pseudo = new Uint8Array(12 + tcp.length);
  pseudo.set(ip.subarray(12, 20)); pseudo[9] = 6; pseudo[10] = tcp.length >> 8; pseudo[11] = tcp.length & 0xff; pseudo.set(tcp, 12);
  return csum(ip) === 0xffff && csum(pseudo) === 0xffff && ((f[10] << 8) | f[11]) === f.length - 8;
}

test('下行：多个包合并后在任意位置切块推送，数据逐字节正确', async () => {
  const srv = fakeServer();
  const tunnel = await open(srv);
  const expect = [];
  const frames = [];
  let seq = srv.state.serverSeq;
  for (let n = 0; n < 300; n++) {
    const len = 1 + ((n * 977) % 1400);
    const payload = Array.from({ length: len }, (_, i) => (n * 31 + i) & 0xff);
    expect.push(...payload);
    frames.push(sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq, flags: 0x18, payload })));
    seq += len;
  }
  const all = new Uint8Array(frames.reduce((s, f) => s + f.length, 0));
  let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
  // 切成长短不一的块：有的只有 1~3 字节（切断包头），有的跨多个包
  const cuts = [1, 2, 3, 5000, 7, 16384, 1, 999, 40000];
  for (let at = 0, k = 0; at < all.length; k++) { const n = cuts[k % cuts.length]; srv.push(all.slice(at, at + n)); at += n; }
  const reader = tunnel.readable.getReader();
  const got = [];
  while (got.length < expect.length) { const { value } = await reader.read(); got.push(...value); }
  assert.equal(got.length, expect.length);
  assert.ok(got.every((b, i) => b === expect[i]), '数据错位');
  tunnel.close();
});

test('上行：一次写入被切成多段写进同一缓冲区，每段校验和、序号、内容都正确', async () => {
  const srv = fakeServer();
  const tunnel = await open(srv);
  const before = srv.writes.length;
  const data = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff);
  const w = tunnel.writable.getWriter();
  await w.write(data);
  const frames = srv.writes.slice(before).flatMap(splitFrames).filter((f) => f[6] === 0x00 && f[7] === 0x21 && f.length > 48);
  assert.ok(frames.length >= 4, '5000 字节应切成至少 4 段：' + frames.length);
  const seqOf = (f) => ((f[32] << 24) | (f[33] << 16) | (f[34] << 8) | f[35]) >>> 0;
  const ids = new Set();
  const joined = [];
  for (let i = 0; i < frames.length; i++) {
    assert.ok(frameOk(frames[i]), '第 ' + i + ' 段校验和错误');
    if (i) assert.equal(seqOf(frames[i]), (seqOf(frames[i - 1]) + frames[i - 1].length - 48) >>> 0, '序号不连续');
    ids.add((frames[i][12] << 8) | frames[i][13]);
    joined.push(...frames[i].subarray(48));
  }
  assert.equal(ids.size, frames.length, 'IP 标识应各不相同');
  assert.deepEqual(joined, [...data]);
  tunnel.close();
});
