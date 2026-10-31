// 基准（不进 npm test）：模拟到 VPN 服务器的往返延迟，测 SSTP 链路从拨号到隧道可用要多久（几个往返）。
// 用法：node test/bench-sstp-latency.mjs [往返毫秒=150]
const { sstpConnect } = await import(process.env.CORE ? new URL('file:///' + process.env.CORE.split(String.fromCharCode(92)).join('/')).href : '../src/dataplane/edt-core.js');
import { fakeServer } from './sstp-fake.mjs';

const RTT = Number(process.argv[2] || 150);
const DOH_MS = 40;

// 服务端的每次回包都晚一个往返才到客户端
function delayed(srv) {
  const inner = srv.connector();
  // 每个回包各自延迟一个往返（同时发出的包同时到达，不排队）
  let pending = Promise.resolve();
  const readable = inner.readable.pipeThrough(new TransformStream({ transform: (c, ctl) => { const due = new Promise((r) => setTimeout(r, RTT)); pending = Promise.all([pending, due]).then(() => ctl.enqueue(c)); }, flush: () => pending }));
  return () => ({ ...inner, readable, opened: new Promise((r) => setTimeout(r, RTT)) }); // TCP 建连也算一个往返
}

globalThis.fetch = async () => { // DoH：固定延迟后返回一条 A 记录
  await new Promise((r) => setTimeout(r, DOH_MS));
  const ans = new Uint8Array([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, 3, 119, 119, 119, 0, 0, 1, 0, 1, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4]);
  return new Response(ans, { headers: { 'content-type': 'application/dns-message' } });
};

async function once(target) {
  const srv = fakeServer();
  const t0 = performance.now();
  const tunnel = await sstpConnect({ hostname: 'vpn.example', port: 443, username: 'vpn', password: 'vpn' }, target, 80, delayed(srv));
  const ms = performance.now() - t0;
  tunnel.closed.catch(() => {});
  tunnel.close();
  return ms;
}

const ip = await once('1.2.3.4');
const host = await once('www.gstatic' + Math.random().toString(36).slice(2) + '.com'); // 每次换域名，避免命中 DoH 缓存
console.log(`往返 ${RTT}ms：目标是 IP ${Math.round(ip)}ms（≈${(ip / RTT).toFixed(1)} 个往返），目标是域名 ${Math.round(host)}ms`);
process.exit(0);
