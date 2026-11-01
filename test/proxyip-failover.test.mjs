// 反代（PROXYIP）兜底：连不上的候选 5 分钟内排到最后；连上后立即交给客户端，不等回应
// （曾经尝试"等反代回第一段数据，超时换下一个"，实际会让走反代的 Cloudflare 网站大面积 ERR_CONNECTION_CLOSED，已去掉）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __forwardTcpForTest as forward } from '../src/dataplane/edt-core.js';

const UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const TLS_HELLO = new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x02, 0x01, 0x00]);

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

test('连上即交给客户端：不等回应', async () => {
  const a = await dial({ '9.9.9.9': 'silent', '8.8.8.8': 'silent' });
  assert.equal(a.order.length, 1, '第一个连上就用');
  assert.ok(a.ms < 1000, '不等待：' + a.ms);
});

test('连不上的候选：下一次连接排到最后', async () => {
  const probe = await dial({ '9.9.9.9': 'good', '8.8.8.8': 'good' });
  const first = probe.order[0], second = first === '9.9.9.9' ? '8.8.8.8' : '9.9.9.9';
  const behave = { [first]: 'refuse', [second]: 'good' };
  const a = await dial(behave);
  assert.deepEqual(a.order, [first, second], '先试第一个，失败换第二个');
  const b = await dial(behave);
  assert.deepEqual(b.order, [second], '5 分钟内不再先试坏的那个');
});

test('补丁里不再有首包等待', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/dataplane/edt-core.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('等待反代首包') && !src.includes('首包可等待'));
});


test('走过反代的目标：下一条连接跳过直连，直接走反代（CF 网站每条连接省一次失败的直连）', async () => {
  const raw = [];
  const req = makeRequest({ '9.9.9.9': 'good', '8.8.8.8': 'good' }, raw);
  const go = () => forward('shop.cf-hosted.example', 443, TLS_HELLO, { readyState: WebSocket.OPEN }, null, {}, UUID, req, { 反代IP: '9.9.9.9:443,8.8.8.8:443', 代理类型: null, 反代兜底: false }, false, null, true);
  await go();
  const first = raw.splice(0);
  assert.ok(first.includes('shop.cf-hosted.example'), '第一次先试直连：' + JSON.stringify(first));
  await go();
  assert.ok(!raw.includes('shop.cf-hosted.example'), '第二次不再直连：' + JSON.stringify(raw));
  assert.equal(raw.length, 1);
});
