// 节点自报统计：零额度（只在 isolate 内存），/version?stats=1 带正确 UUID 才返回
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/node.js';
import { resetStats, snapshotStats, recordFail } from '../src/dataplane/stats.js';
import { resetGuard, reportAuthFail } from '../src/dataplane/guard.js';
import { configure } from '../src/dataplane/edt-core.js';
import { adminHtml } from '../src/admin/ui.js';
import { UUID } from './helpers.mjs';

beforeEach(() => { resetStats(); resetGuard(); });
const env = { UUID };
const ctx = { waitUntil() {} };
const get = (path, headers = {}) => worker.fetch(new Request('https://vp2.example.com' + path, { headers: { 'CF-Connecting-IP': '7.7.7.7', ...headers } }), env, ctx);

test('/version?stats=1：正确 UUID 才返回统计；不带 stats 时响应不变', async () => {
  const plain = await (await get('/version?uuid=' + UUID)).json();
  assert.equal(plain.Stats, undefined);
  const withStats = await (await get('/version?uuid=' + UUID + '&stats=1')).json();
  assert.equal(typeof withStats.Stats.upMin, 'number');
  assert.deepEqual(withStats.Stats.recent, []);
  const bad = await get('/version?uuid=00000000-0000-4000-8000-000000000000&stats=1');
  assert.ok(!(await bad.text()).includes('Stats'), 'UUID 不对不泄露');
});

test('被防护拦截、地区路由失败都会计数；最近错误保留且有上限', async () => {
  for (let i = 0; i < 5; i++) reportAuthFail('7.7.7.7');
  const ws = { Upgrade: 'websocket', Connection: 'Upgrade' };
  await get('/?ed=2560', ws);
  assert.equal(snapshotStats().guardBlocked, 1);
  resetGuard();
  await get('/video/not-a-real-pool-route', ws).catch(() => {});
  for (let i = 0; i < 30; i++) recordFail('[TCP转发] 直连 x 失败: ' + i);
  const st = snapshotStats();
  assert.equal(st.recent.length, 12, '最近错误最多 12 条');
  assert.match(st.recent.at(-1).m, /失败: 29$/);
});

test('上游 log() 里的「失败 / 超时」行经钩子计入（未注入钩子时不受影响）', async () => {
  const lines = [];
  configure({ failLogHook: (l) => lines.push(l) });
  const { __forwardTcpForTest: forward } = await import('../src/dataplane/edt-core.js');
  const request = { fetcher: { connect: () => { const opened = Promise.reject(new Error('refused')); opened.catch(() => {}); return { opened, readable: new ReadableStream(), writable: new WritableStream(), closed: new Promise(() => {}), close() {} }; } } };
  // 反代 IP 是字面 IP（不需要 DNS）+ 连接被拒：本地就失败，不访问网络
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('测试中禁止外网'));
  try {
    await assert.rejects(forward('1.2.3.4', 80, new Uint8Array(0), { readyState: WebSocket.OPEN }, null, {}, UUID, request, { 反代IP: '9.9.9.9:443', 代理类型: null, 反代兜底: false }, false, null, true));
  } finally { globalThis.fetch = realFetch; }
  assert.ok(lines.some((l) => /失败/.test(l)), '链路失败被记录：' + JSON.stringify(lines));
  configure({ failLogHook: recordFail });
});

test('后台检测节点：带 stats=1 请求并显示统计行', () => {
  const js = adminHtml({}).match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("'&stats=1'"));
  assert.ok(js.includes('const statLine = (st, sk) =>'));
});
