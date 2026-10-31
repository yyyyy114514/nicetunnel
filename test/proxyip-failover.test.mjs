// 反代（PROXYIP）兜底：反代连上却不回话 → 换下一个候选；近期失败的候选下次排到最后（Cloudflare 托管的网站走这条路）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __forwardTcpForTest as forward } from '../src/dataplane/edt-core.js';

const UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const TLS_HELLO = new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x02, 0x01, 0x00]); // 一条完整的 TLS 记录
const PARTIAL = new Uint8Array([0x16, 0x03, 0x01, 0x02, 0x00, 0x01]); // 记录头说 512 字节，只到了 1 字节

// 假连接：目标站点直连失败（像 Worker 连 Cloudflare IP 被拒）；反代按 behave[ip] 行为
function makeRequest(behave, order) {
  const sock = (kind) => {
    let push;
    const readable = new ReadableStream({ start(c) { push = (b) => c.enqueue(b); } });
    const writable = new WritableStream({ write() { if (kind === 'good') setTimeout(() => push(new Uint8Array([0x16, 0x03, 0x03])), 20); } });
    const opened = kind === 'refuse' ? Promise.reject(new Error('refused')) : Promise.resolve();
    opened.catch(() => {});
    return { opened, readable, writable, closed: new Promise(() => {}), close() {} };
  };
  return { fetcher: { connect: ({ hostname }) => { order.push(hostname); return sock(behave[hostname] || 'refuse'); } } };
}
async function dial(behave, data = TLS_HELLO) {
  const order = [];
  const t0 = Date.now();
  const socket = await forward('login.cdk.example', 443, data, { readyState: WebSocket.OPEN }, null, {}, UUID, makeRequest(behave, order), { 反代IP: '9.9.9.9:443,8.8.8.8:443', 代理类型: null, 反代兜底: false }, false, null, true);
  return { socket, order: order.filter((h) => h !== 'login.cdk.example'), ms: Date.now() - t0 };
}

test('反代连上却不回话：约 4 秒后换下一个候选；下一次连接直接跳过坏的', async () => {
  // 先看这个站点的候选顺序（两个都正常时第一个就成功）
  const probe = await dial({ '9.9.9.9': 'good', '8.8.8.8': 'good' });
  const [first, second] = [probe.order[0], probe.order[0] === '9.9.9.9' ? '8.8.8.8' : '9.9.9.9'];
  // 排第一的变成"连上不回话"
  const behave = { [first]: 'silent', [second]: 'good' };
  const a = await dial(behave);
  assert.deepEqual(a.order, [first, second], '先试第一个，超时后换第二个');
  assert.ok(a.ms >= 3900 && a.ms < 6000, '约 4 秒：' + a.ms);
  const r = await a.socket.readable.getReader().read();
  assert.deepEqual([...r.value], [0x16, 0x03, 0x03], '回应数据完整交给客户端');
  const b = await dial(behave);
  assert.deepEqual(b.order, [second], '5 分钟内不再先试坏的那个');
  assert.ok(b.ms < 1000, '下一次很快：' + b.ms);
});

test('首包不完整时不等回应（避免需要更多客户端数据的连接被卡住）', async () => {
  const c = await dial({ '9.9.9.9': 'silent', '8.8.8.8': 'silent' }, PARTIAL);
  assert.ok(c.ms < 1000 && c.order.length === 1, '直接用第一个连上的：' + JSON.stringify(c));
});
