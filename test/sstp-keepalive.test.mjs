// SSTP 链路：用脚本化的假 SSTP 服务端验证保活应答、重复段丢弃、RST 立即结束（对应 vendor 的 sstp-patches.json）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sstpConnect } from '../src/dataplane/edt-core.js';

import { u16, u32, sstpData, sstpCtrl, pppCtl, ipTcp, fakeServer } from './sstp-fake.mjs';

test('SSTP：应答 SSTP ECHO 与 PPP LCP Echo（否则 VPN Gate 十几秒就断开会话）', async () => {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  srv.push(sstpCtrl(0x0008));
  await srv.waitWrite((b) => b[0] === 0x10 && b[1] === 0x01 && b[4] === 0x00 && b[5] === 0x09);
  srv.push(sstpData(pppCtl(0xc021, 9, 7, [0xde, 0xad, 0xbe, 0xef])));
  const reply = await srv.waitWrite((b) => b[1] === 0x00 && b[6] === 0xc0 && b[7] === 0x21 && b[8] === 10);
  assert.equal(reply[9], 7, 'Echo-Reply 沿用请求的 id');
  assert.deepEqual([...reply.subarray(12, 16)], [0, 0, 0, 0], '未协商魔数时回 0');
  tunnel.close();
});

test('SSTP：重复的 TCP 段被丢弃（不拼进数据流），RST 立即结束读取', async () => {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  const reader = tunnel.readable.getReader();
  const seg = (seq, text, flags = 0x18) => sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq, flags, payload: [...new TextEncoder().encode(text)] }));
  const base = srv.state.serverSeq;
  srv.push(seg(base, 'hello'));
  srv.push(seg(base, 'hello')); // 重传的重复段
  srv.push(seg(base + 5, 'world'));
  let got = '';
  while (got.length < 10) {
    const { value, done } = await reader.read();
    if (done) break;
    got += new TextDecoder().decode(value);
  }
  assert.equal(got, 'helloworld');
  srv.push(sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq: base + 10, flags: 0x04 })));
  await assert.rejects(Promise.race([reader.read(), new Promise((_, r) => setTimeout(() => r(new Error('RST 后仍挂起')), 1500))]), /reset by peer/);
});

test('SSTP：服务端 CALL_DISCONNECT 时回 DISCONNECT_ACK 并结束', async () => {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  const reader = tunnel.readable.getReader();
  srv.push(sstpCtrl(0x0006));
  await srv.waitWrite((b) => b[1] === 0x01 && b[5] === 0x07);
  await assert.rejects(reader.read(), /closed by server/);
});

test('SSTP：下游不读时通告窗口收缩（不再无限缓冲），读走后发送窗口更新', async () => {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  const win = (b) => (b[42] << 8) | b[43];
  const isAck = (b) => b[1] === 0x00 && b[6] === 0x00 && b[7] === 0x21 && b[41] === 0x10;
  const chunk = new Array(4000).fill(0x61);
  let seq = srv.state.serverSeq;
  const total = 1100; // 约 4.4MB，超过 4MB 缓冲
  for (let n = 0; n < total; n++) { srv.push(sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq, flags: 0x18, payload: chunk }))); seq += chunk.length; }
  await srv.waitWrite((b) => isAck(b) && win(b) < 65535, 5000);
  const before = srv.writes.length;
  const reader = tunnel.readable.getReader();
  let got = 0;
  while (got < total * chunk.length) { const { value } = await reader.read(); got += value.byteLength; }
  const update = srv.writes.slice(before).find((b) => isAck(b) && win(b) === 65535);
  assert.ok(update, '读走后应发窗口更新');
  tunnel.close();
});

function csum(bytes) {
  let s = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) s += (bytes[i] << 8) | bytes[i + 1];
  if (bytes.length & 1) s += bytes[bytes.length - 1] << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return s; // 校验和正确时为 0xffff
}
function checksumsOk(frame) {
  const ip = frame.subarray(8, 28), tcp = frame.subarray(28);
  const pseudo = new Uint8Array(12 + tcp.length);
  pseudo.set(ip.subarray(12, 20)); pseudo[9] = 6; pseudo[10] = tcp.length >> 8; pseudo[11] = tcp.length & 0xff; pseudo.set(tcp, 12);
  return csum(ip) === 0xffff && csum(pseudo) === 0xffff && ((frame[10] << 8) | frame[11]) === frame.length - 8 && (((frame[2] & 0x0f) << 8) | frame[3]) === frame.length;
}

test('SSTP：SYN 带 MSS=1400 选项且 IP/TCP 校验和、长度字段正确（普通 ACK 同样校验）', async () => {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  const syn = srv.writes.find((b) => b[6] === 0x00 && b[7] === 0x21 && b[41] === 0x02);
  assert.equal(syn[40] >> 4, 6, 'TCP 头 24 字节（含选项）');
  assert.deepEqual([...syn.subarray(48, 52)], [2, 4, 0x05, 0x78]);
  assert.ok(checksumsOk(syn), 'SYN 校验和');
  const ack = srv.writes.find((b) => b[6] === 0x00 && b[7] === 0x21 && b[41] === 0x10);
  assert.ok(checksumsOk(ack), '上游 ACK 校验和（验证校验函数本身）');
  tunnel.close();
});

test('SSTP：上传遵守对端通告窗口，窗口满时等待，对端确认后继续（不再超窗被丢）', async () => {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  const syn = srv.writes.find((b) => b[6] === 0x00 && b[7] === 0x21 && b[41] === 0x02);
  const isn = ((syn[32] << 24) | (syn[33] << 16) | (syn[34] << 8) | syn[35]) >>> 0;
  const ackFrame = (ack, win) => sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq: srv.state.serverSeq, ack, flags: 0x10, win }));
  srv.push(ackFrame((isn + 1) >>> 0, 2800)); // 对端窗口只有 2800
  await new Promise((r) => setTimeout(r, 20));
  const sent = () => srv.writes.filter((b) => b[6] === 0x00 && b[7] === 0x21 && b[41] === 0x18).reduce((n, b) => {
    // 一次 write 可能拼了多个 SSTP 帧：逐帧累加 TCP 负载长度
    for (let at = 0; at < b.length;) { const len = ((b[at + 2] & 0x0f) << 8) | b[at + 3]; n += len - 48; at += len; }
    return n;
  }, 0);
  const w = tunnel.writable.getWriter();
  const done = w.write(new Uint8Array(10000).fill(0x62));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent(), 2800, '只发对端窗口允许的量');
  srv.push(ackFrame((isn + 1 + 2800) >>> 0, 65535));
  await done;
  assert.equal(sent(), 10000, '确认后发完剩余数据');
  tunnel.close();
});
