// 出站连接器：上游只用 request.fetcher.connect（未写进文档）。没有它的环境改用 cloudflare:sockets connect()
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from '../src/dataplane/edt-core.js';
import { loadSocketsConnect, resetSocketsConnect, socketInfo } from '../src/dataplane/adapter.js';
import worker from '../src/node.js';
import { UUID } from './helpers.mjs';

const fakeSocket = (log, tag) => (opts) => {
  log.push(tag + ':' + opts.hostname + ':' + opts.port);
  const opened = Promise.reject(new Error('refused')); opened.catch(() => {});
  return { opened, readable: new ReadableStream(), writable: new WritableStream(), closed: new Promise(() => {}), close() {} };
};

afterEach(() => { configure({ socketConnect: () => { throw new Error('unset'); }, preferSocketConnect: false, connectGuardHook: null }); resetSocketsConnect(); });

async function dial(request) {
  const { __forwardTcpForTest: forward } = await import('../src/dataplane/edt-core.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('测试中禁止外网'));
  try {
    await forward('1.2.3.4', 80, new Uint8Array(0), { readyState: WebSocket.OPEN }, null, {}, UUID, request, { 反代IP: '9.9.9.9:443', 代理类型: null, 反代兜底: false }, false, null, true).catch(() => {});
  } finally { globalThis.fetch = realFetch; }
}

test('没有 request.fetcher：改用注入的 cloudflare:sockets connect()', async () => {
  const log = [];
  configure({ socketConnect: fakeSocket(log, 'sockets') });
  await dial({});
  assert.ok(log.length > 0 && log.every((l) => l.startsWith('sockets:')), JSON.stringify(log));
});

test('有 request.fetcher：默认仍用它（与上游一致）；SOCKET_API=sockets 时强制用 sockets', async () => {
  const log = [];
  configure({ socketConnect: fakeSocket(log, 'sockets') });
  await dial({ fetcher: { connect: fakeSocket(log, 'fetcher') } });
  assert.ok(log.length > 0 && log.every((l) => l.startsWith('fetcher:')), JSON.stringify(log));
  log.length = 0;
  configure({ preferSocketConnect: true });
  await dial({ fetcher: { connect: fakeSocket(log, 'fetcher') } });
  assert.ok(log.length > 0 && log.every((l) => l.startsWith('sockets:')), JSON.stringify(log));
});

test('loadSocketsConnect：加载失败返回 null 并缓存；成功取 connect', async () => {
  assert.equal(await loadSocketsConnect(() => Promise.reject(new Error('no module'))), null);
  resetSocketsConnect();
  const fn = () => {};
  assert.equal(await loadSocketsConnect(async () => ({ connect: fn })), fn);
});

test('socketInfo：两种都没有时 using=none', async () => {
  assert.deepEqual(await socketInfo({}, {}), { fetcher: false, sockets: false, using: 'none' });
  assert.equal((await socketInfo({ fetcher: { connect() {} } }, {})).using, 'fetcher');
});

test('/version?stats=1 带上出站连接器信息', async () => {
  const r = await worker.fetch(new Request('https://vp2.example.com/version?uuid=' + UUID + '&stats=1'), { UUID }, { waitUntil() {} });
  const j = await r.json();
  assert.equal(j.Socket.using, 'none', 'Node 测试环境里两种都没有');
});

// ---- 出站端口守卫（滥用防护：拦截 SMTP 等易触发举报的出站端口）----
import { outboundPortGuard, isBlockedOutboundPort } from '../src/dataplane/adapter.js';
import { resetStats, snapshotStats } from '../src/dataplane/stats.js';

async function dialProxyIp(proxyIp, request) {
  const { __forwardTcpForTest: forward } = await import('../src/dataplane/edt-core.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('测试中禁止外网'));
  try {
    await forward('1.2.3.4', 80, new Uint8Array(0), { readyState: WebSocket.OPEN }, null, {}, UUID, request, { 反代IP: proxyIp, 代理类型: null, 反代兜底: false }, false, null, true).catch(() => {});
  } finally { globalThis.fetch = realFetch; }
}

test('isBlockedOutboundPort：SMTP 端口被拦，常规端口放行', () => {
  for (const p of [25, 465, 587, 2525]) assert.ok(isBlockedOutboundPort(p), 'port ' + p);
  for (const p of [443, 80, 8080, 2053, '443']) assert.ok(!isBlockedOutboundPort(p), 'port ' + p);
});

test('出站端口守卫：被拦端口在连接器之前拒绝（两条路径都拦），放行端口正常建连', async () => {
  resetStats();
  const log = [];
  configure({ socketConnect: fakeSocket(log, 'sockets'), connectGuardHook: outboundPortGuard });
  // 目标 25 端口：连接器（备用路径）根本不被调用，只有 portBlocked 计数
  // （先试直连目标 1.2.3.4:80 是正常的；关键是反代的 25 端口一次都没连）
  const to25 = () => log.filter((l) => l.endsWith(':25'));
  await dialProxyIp('9.9.9.9:25', {});
  assert.equal(to25().length, 0, '25 端口不应触达连接器');
  assert.equal(snapshotStats().portBlocked, 1, '计数 +1');
  // 目标 25 端口 + fetcher 路径：同样被拦
  await dialProxyIp('9.9.9.9:25', { fetcher: { connect: fakeSocket(log, 'fetcher') } });
  assert.equal(to25().length, 0, 'fetcher 路径同样拦截');
  log.length = 0;
  assert.equal(snapshotStats().portBlocked, 2);
  // 放行端口（443）：连接正常建立（fakeSocket 返回 refused 只是模拟远端拒绝）
  await dialProxyIp('9.9.9.9:443', { fetcher: { connect: fakeSocket(log, 'fetcher') } });
  assert.ok(log.some((l) => l === 'fetcher:9.9.9.9:443') && log.every((l) => l.startsWith('fetcher:')), JSON.stringify(log));
  assert.equal(snapshotStats().portBlocked, 2, '放行端口不增加拦截计数');
});
