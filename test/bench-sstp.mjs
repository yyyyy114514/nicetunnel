// 基准（不是测试，不进 npm test）：SSTP 链路每 MB 下行 / 上行在 JS 里花多少 CPU。
// 用法：node test/bench-sstp.mjs
const { sstpConnect } = await import(process.env.CORE ? new URL('file:///' + process.env.CORE.split(String.fromCharCode(92)).join('/')).href : '../src/dataplane/edt-core.js');
import { fakeServer, sstpData, ipTcp } from './sstp-fake.mjs';

const cpuMs = (f) => { const a = process.cpuUsage(); return f().then(() => { const b = process.cpuUsage(a); return (b.user + b.system) / 1000; }); };

async function download(mb) {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  const seg = 1360; // 与真实 MSS 相近
  const total = Math.ceil((mb * 1048576) / seg);
  // 预先构好帧，再按 16KB 左右（TLS 记录大小）合并推送，排除构帧本身的开销
  const frames = [];
  let seq = srv.state.serverSeq;
  const payload = new Array(seg).fill(0x61);
  for (let n = 0; n < total; n++) { frames.push(sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq, flags: 0x18, payload }))); seq += seg; }
  const chunks = [];
  for (let i = 0; i < frames.length; i += 11) { const part = frames.slice(i, i + 11); const len = part.reduce((s, f) => s + f.length, 0); const c = new Uint8Array(len); let o = 0; for (const f of part) { c.set(f, o); o += f.length; } chunks.push(c); }
  const reader = tunnel.readable.getReader();
  const ms = await cpuMs(async () => {
    if (globalThis.__profStart && mb > 1) await globalThis.__profStart();
    let got = 0;
    const want = total * seg;
    for (const c of chunks) srv.push(c);
    while (got < want) { const { value } = await reader.read(); got += value.byteLength; }
    if (globalThis.__profStop && mb > 1) await globalThis.__profStop();
  });
  tunnel.close();
  return ms;
}

async function upload(mb) {
  const srv = fakeServer();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, '1.2.3.4', 80, srv.connector);
  tunnel.closed.catch(() => {});
  // 假服务端不回 ACK：把对端窗口当无限（直接确认所有已发数据）
  const w = tunnel.writable.getWriter();
  const block = new Uint8Array(16384).fill(0x62);
  const n = Math.ceil((mb * 1048576) / block.length);
  const ms = await cpuMs(async () => {
    for (let i = 0; i < n; i++) {
      const p = w.write(block);
      // 每写一块就模拟对端确认到当前序号（让发送窗口不卡）
      const last = srv.writes[srv.writes.length - 1];
      await Promise.race([p, new Promise((r) => setTimeout(r, 0))]);
      ackAll(srv);
      await p;
    }
  });
  tunnel.close();
  return ms;
}
function ackAll(srv) {
  // 找到客户端最后一个数据段，按其序号 + 长度回 ACK（窗口 65535）
  for (let i = srv.writes.length - 1; i >= 0; i--) {
    const b = srv.writes[i];
    if (b[6] === 0x00 && b[7] === 0x21 && b.length > 48) {
      const seq = ((b[32] << 24) | (b[33] << 16) | (b[34] << 8) | b[35]) >>> 0;
      const ack = (seq + (b.length - 48)) >>> 0;
      srv.push(sstpData(ipTcp({ sport: 80, dport: srv.state.clientPort, seq: srv.state.serverSeq, ack, flags: 0x10 })));
      return;
    }
  }
}

await download(1); // 预热
const DM = Number(process.env.DMB || 8), UM = Number(process.env.UMB || 4);
const d = await download(DM);
console.log(`下行：${(d / DM).toFixed(1)} ms CPU / MB`);
await upload(1);
const u = await upload(UM);
console.log(`上行：${(u / UM).toFixed(1)} ms CPU / MB`);
process.exit(0);
