// 节点站点与主站行为一致：防护只封凭据错误的 IP；主站的 PROXYIP 下发给所有节点
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { isCredentialFailure } from '../src/dataplane/adapter.js';
import { reportAuthFail, isBlocked, resetGuard } from '../src/dataplane/guard.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { deriveIdentity } from '../src/control/identity.js';
import { memKV, fakeFetch } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetGuard(); });
afterEach(() => { globalThis.fetch = realFetch; });

test('只有 UUID / Trojan 密码不符算认证失败；Mux(XUDP) 的 Invalid command、短首包等正常客户端会出现的错误不计数', () => {
  for (const m of ['Invalid uuid', 'invalid password']) assert.equal(isCredentialFailure(m), true, m);
  for (const m of ['Invalid command', 'Invalid data', 'invalid data', 'invalid header format', 'Invalid address type: 9', 'unsupported command, only TCP/UDP is allowed', '', undefined]) assert.equal(isCredentialFailure(m), false, String(m));
});

test('防护：凭据错误 5 次才封；中间夹多少次非凭据错误都不影响', () => {
  const hook = (ip, msg) => { if (isCredentialFailure(msg)) reportAuthFail(ip); };
  for (let i = 0; i < 50; i++) hook('1.1.1.1', 'Invalid command'); // 正常用户的 UDP(XUDP) 流量
  assert.equal(isBlocked('1.1.1.1'), false, '正常客户端不会被封');
  for (let i = 0; i < 5; i++) hook('2.2.2.2', 'Invalid uuid');
  assert.equal(isBlocked('2.2.2.2'), true, '扫描/爆破照样被封');
});

function setup(envExtra = {}, proxy = {}) {
  const settings = {
    schema: 4,
    preferred: { custom: { enabled: true, text: '104.16.1.1:443#测试' }, random: { enabled: false } },
    hosts: { unmanaged: ['vp2.example.com'] },
    proxy,
    rules: { configText: '', configUrl: '' },
  };
  const kv = memKV({ 'nt.settings': settings, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pass123', KEY: 'mykey', ...envExtra };
  return { env, id: deriveIdentity(env, 'vp.example.com'), ctx: { waitUntil() {} } };
}
const sub = async ({ env, id, ctx }) => {
  const r = await worker.fetch(new Request('https://vp.example.com/sub?b64&token=' + id.subToken, { headers: { 'User-Agent': 'v2rayN/6', 'CF-Connecting-IP': '9.9.9.9' } }), env, ctx);
  return decodeURIComponent(Buffer.from(await r.text(), 'base64').toString('utf8'));
};

test('主站设了 PROXYIP、订阅反代为 auto：节点路径带上主站的 PROXYIP（节点不再退回公共默认反代）', async () => {
  globalThis.fetch = fakeFetch({});
  assert.match(await sub(setup({ PROXYIP: 'proxy.example.net:443,1.2.3.4' })), /\/proxyip=proxy\.example\.net:443,1\.2\.3\.4/);
});

test('主站没设 PROXYIP / 后台明确填了反代 IP：行为不变', async () => {
  globalThis.fetch = fakeFetch({});
  assert.ok(!(await sub(setup())).includes('proxyip='), '没设：仍由各站点自己决定');
  resetStoreState(); resetPipelineState();
  const t = await sub(setup({ PROXYIP: 'main.example.net' }, { proxyip: 'mine.example.net' }));
  assert.match(t, /proxyip=mine\.example\.net/);
  assert.ok(!t.includes('main.example.net'), '后台填的优先');
});
