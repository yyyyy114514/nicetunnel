// 链式拨号：直接驱动数据面的拨号循环（仅建立连接模式），验证 SSTP 竞速、故障转移与健康上报
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure, __forwardTcpForTest as forward } from '../src/dataplane/edt-core.js';
import { fakeServer } from './sstp-fake.mjs';
import { UUID } from './helpers.mjs';

const acct = (hostname) => ({ username: 'vpn', password: 'vpn', hostname, port: 443 });
const cand = (hostname) => ({ type: 'sstp', ...acct(hostname) });

/** 按主机名决定行为：ok=正常 SSTP 服务端；dead=立即拒绝；hang=永不响应 */
function connector(plan) {
  return (opts) => {
    const mode = plan[opts.hostname];
    if (mode === 'ok') return fakeServer().connector();
    const opened = mode === 'dead' ? Promise.reject(new Error('connection refused')) : new Promise(() => {});
    opened.catch(() => {});
    return { opened, readable: new ReadableStream(), writable: new WritableStream(), closed: new Promise(() => {}), close() {} };
  };
}

async function dial(plan, { race = 2, failover = 1 } = {}) {
  const events = [];
  configure({ chainConnectTimeoutMs: 1000, chainFailover: failover, chainRace: race, chainResultHook: (ok, h) => events.push((ok ? '+' : '-') + h) });
  const request = { fetcher: { connect: connector(plan) } };
  const ctx = { 代理类型: 'sstp', 代理参数: acct('a.test'), 代理候选: [cand('a.test'), cand('b.test')], 反代IP: '', 代理全局: true, 反代兜底: false };
  const t0 = Date.now();
  const p = forward('1.2.3.4', 80, new Uint8Array(0), { readyState: WebSocket.OPEN }, null, {}, UUID, request, ctx, false, null, true);
  return { p, events, t0 };
}

afterEach(() => configure({ chainConnectTimeoutMs: 5999, chainFailover: 1, chainRace: 2, chainResultHook: () => {} }));

test('SSTP 竞速：当前候选卡住时，下一台先握手成功就直接用它（不等超时），卡住的那台超时后记为失败', async () => {
  const { p, events, t0 } = await dial({ 'a.test': 'hang', 'b.test': 'ok' });
  const tunnel = await p;
  assert.ok(tunnel?.readable, '拿到隧道');
  assert.ok(Date.now() - t0 < 800, '没有等当前候选超时');
  assert.deepEqual(events, ['+b.test']);
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(events, ['+b.test', '-a.test']);
  tunnel.close?.();
});

test('关闭竞速时走故障转移：第一台拒绝后换第二台', async () => {
  const { p, events } = await dial({ 'a.test': 'dead', 'b.test': 'ok' }, { race: 1 });
  const tunnel = await p;
  assert.ok(tunnel?.readable);
  assert.deepEqual(events, ['-a.test', '+b.test']);
  tunnel.close?.();
});

test('两台都失败：拨号报错，两台都记为失败', async () => {
  const { p, events } = await dial({ 'a.test': 'dead', 'b.test': 'dead' });
  await assert.rejects(p);
  assert.deepEqual(events.slice().sort(), ['-a.test', '-b.test']);
});
