// 节点特征收敛：伪装页像真实 nginx（非 / 路径 404）；多次认证失败的 IP 不再拿到 WS 升级
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reportAuthFail, isBlocked, resetGuard } from '../src/dataplane/guard.js';
import { handleDataPlane, camouflage } from '../src/dataplane/adapter.js';
import nodeWorker from '../src/node.js';
import { UUID } from './helpers.mjs';

beforeEach(() => resetGuard());

test('伪装页：/ 是 nginx 欢迎页（200），其它路径是 nginx 404 页', async () => {
  const get = (p) => camouflage(new Request('https://vp2.example.com' + p), new URL('https://vp2.example.com' + p), 'nginx');
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /Welcome to nginx/);
  for (const p of ['/admin', '/sub', '/version', '/x/y.php', '/.env']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(await r.text(), /<center>nginx<\/center>/);
  }
  // 节点版入口同样如此
  const r = await nodeWorker.fetch(new Request('https://vp2.example.com/wp-login.php'), { UUID });
  assert.equal(r.status, 404);
});

test('认证失败计数：10 分钟内 5 次 → 封 30 分钟；窗口过期重新计数', () => {
  const t = 1e12;
  for (let i = 0; i < 4; i++) reportAuthFail('1.2.3.4', t + i);
  assert.equal(isBlocked('1.2.3.4', t + 10), false, '4 次不封');
  reportAuthFail('1.2.3.4', t + 20);
  assert.equal(isBlocked('1.2.3.4', t + 30), true);
  assert.equal(isBlocked('1.2.3.4', t + 29 * 60e3), true);
  assert.equal(isBlocked('1.2.3.4', t + 31 * 60e3), false, '30 分钟后解封');
  for (let i = 0; i < 4; i++) reportAuthFail('5.6.7.8', t + i * 4 * 60e3); // 间隔太大：跨窗口
  assert.equal(isBlocked('5.6.7.8', t + 13 * 60e3), false);
  assert.equal(isBlocked('9.9.9.9', t), false, '无记录不封');
});

test('被封 IP 的 WS 升级直接拿伪装页（不升级），其他 IP 不受影响；GUARD=0 关闭', async () => {
  for (let i = 0; i < 5; i++) reportAuthFail('6.6.6.6');
  const ws = (ip, env = { UUID }) => {
    const url = new URL('https://vp2.example.com/');
    const req = new Request(url, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip } });
    return handleDataPlane(req, env, url, { uuid: UUID, adminPassword: UUID });
  };
  const blocked = await ws('6.6.6.6');
  assert.equal(blocked.status, 200);
  assert.match(await blocked.text(), /Welcome to nginx/);
  // 未被封的 IP 会进入真正的 WS 处理（Node 里没有 WebSocketPair，会在那里抛错——说明已越过拦截）
  await assert.rejects(ws('7.7.7.7'), /WebSocketPair/);
  await assert.rejects(ws('6.6.6.6', { UUID, GUARD: '0' }), /WebSocketPair/);
});
