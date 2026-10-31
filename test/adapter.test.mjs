import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequestUrl, versionResponse, handleDataPlane, camouflage } from '../src/dataplane/adapter.js';
import { deriveIdentity, authCookieValue } from '../src/control/identity.js';
import { md5md5 } from '../src/lib/md5.js';

const UUID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

test('identity：UUID 与订阅 token 与上游算法一致', () => {
  const id = deriveIdentity({ ADMIN: 'x', UUID }, 'vp.example.org');
  assert.equal(id.uuid, UUID);
  assert.equal(id.subToken, 'fa8a47f9c50e5aa620932c6e53fb3981');
  // HOST 环境变量优先于请求域名
  const id2 = deriveIdentity({ ADMIN: 'x', UUID, HOST: 'https://VP.example.org/abc, other.com' }, 'whatever.dev');
  assert.equal(id2.subToken, 'fa8a47f9c50e5aa620932c6e53fb3981');
  assert.match(authCookieValue("UA", id), /^[0-9]{10}[.][0-9a-f]{32}$/);
});

test('identity：无 UUID 时由 ADMIN+KEY 推导为合法 v4', () => {
  const id = deriveIdentity({ ADMIN: 'pass' }, 'a.com');
  assert.match(id.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id.hasCustomKey, false);
});

test('URL 规范化：%3f 修正与反斜杠清理', () => {
  assert.equal(normalizeRequestUrl('https://a.com/sub%3Ftoken=1').search, '?token=1');
  assert.equal(normalizeRequestUrl('https://a.com/a%5Cb').pathname, '/ab');
});

test('/version 只对近似匹配的 uuid 返回版本', async () => {
  const ok = versionResponse(new URL('https://a.com/version?uuid=' + UUID), UUID);
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).Version > 0);
  assert.equal(versionResponse(new URL('https://a.com/version?uuid=00000000-0000-4000-8000-000000000000'), UUID), null);
});

test('非代理请求不进入数据面；无管理员密码时 WS 也不处理', async () => {
  const id = deriveIdentity({ ADMIN: 'x', UUID }, 'a.com');
  const url = new URL('https://a.com/');
  assert.equal(await handleDataPlane(new Request(url), {}, url, id), null);
  const loginPost = new URL('https://a.com/login');
  assert.equal(await handleDataPlane(new Request(loginPost, { method: 'POST', body: 'x' }), {}, loginPost, id), null);
  const noAdmin = deriveIdentity({}, 'a.com');
  const ws = new Request(url, { headers: { Upgrade: 'websocket' } });
  assert.equal(await handleDataPlane(ws, {}, url, noAdmin), null);
});

test('伪装页：nginx 与 1101 不发外部请求', async () => {
  const url = new URL('https://a.com/');
  let called = 0;
  const f = async () => { called++; return new Response('x'); };
  const r1 = await camouflage(new Request(url), url, 'nginx', f);
  assert.match(await r1.text(), /nginx/i);
  const r2 = await camouflage(new Request(url), url, '1101', f);
  assert.equal(r2.status, 200);
  assert.equal(called, 0);
});
