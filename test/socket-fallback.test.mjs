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

afterEach(() => { configure({ socketConnect: () => { throw new Error('unset'); }, preferSocketConnect: false }); resetSocketsConnect(); });

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
