// 代码审查（Code review 会话）报告的问题：逐条回归
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createStore, resetStoreState } from '../src/control/store.js';
import { getUsers, MU_KEYS } from '../src/control/users.js';
import { camouflage } from '../src/dataplane/adapter.js';
import { readBodyLimited, clientIp as authIp } from '../src/control/auth.js';
import { clientIp as dpIp } from '../src/dataplane/adapter.js';
import { parseVpnGate } from '../src/control/homefeed.js';
import { escHtml } from '../src/lib/html.js';
import { memKV, settingsWith } from './helpers.mjs';

beforeEach(() => resetStoreState());

test('#1 cookie 校验失败时重读密钥：每个 isolate 30 秒最多一次（之前每个请求新建 store，节流不生效）', async () => {
  const kv = memKV({ 'nt.settings': settingsWith({}), 'nt.accounts': [] });
  let authReads = 0;
  const get = kv.get;
  kv.get = async (k, o) => { if (k === 'nt.authkey') authReads++; return get(k, o); };
  const env = { KV: kv, ADMIN: 'pw' };
  for (let i = 0; i < 5; i++) await worker.fetch(new Request('https://vp.example.com/admin', { headers: { Cookie: 'auth=x', 'User-Agent': 'Mozilla/5.0' } }), env, { waitUntil() {} });
  assert.ok(authReads <= 2, '5 次伪造 cookie 只多读了 ' + authReads + ' 次');
});

test('#2 伪装页反代第三方站点：不转发 Cookie / Authorization', async () => {
  let sent = null;
  const fetchFn = async (url, init) => { sent = init.headers; return new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } }); };
  const req = new Request('https://vp.example.com/x', { headers: { Cookie: 'auth=secret', Authorization: 'Bearer t', 'User-Agent': 'UA' } });
  await camouflage(req, new URL(req.url), 'https://example.org', fetchFn);
  assert.equal(sent.get('cookie'), null);
  assert.equal(sent.get('authorization'), null);
  assert.equal(sent.get('user-agent'), 'UA', '其它头照常');
});

test('#3 要求读最新（ttl=0）时 KV 出错就报错，不拿旧缓存顶替（否则整表写回会写回旧数据）', async () => {
  const kv = memKV({ k: { v: 1 } });
  const store = createStore({ kv });
  assert.deepEqual(await store.getJson('k'), { v: 1 });
  kv.get = async () => { throw new Error('KV 503'); };
  assert.deepEqual(await store.getJson('k', 30e3), { v: 1 }, '普通读：照旧用缓存');
  await assert.rejects(() => store.getJson('k', 0), /503/);
});

test('#4 用户名单：同一份缓存只规整一次；结果冻结', async () => {
  const kv = memKV({ [MU_KEYS.users]: Array.from({ length: 50 }, (_, i) => ({ id: String(i).padStart(8, 'a'), name: 'n' + i })) });
  const store = createStore({ kv });
  const a = await getUsers(store), b = await getUsers(store);
  assert.equal(a, b, '第二次直接复用');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0]));
  const c = await getUsers(store, 0);
  assert.notEqual(c, a, '读最新：重新读 KV、重新规整');
  assert.deepEqual(c, a);
});

test('#5 家宽：按运营商（Operator 列）排除官方服务器也生效', () => {
  const cfg = btoa('proto tcp\nremote 9.9.9.9 443\n<ca>\n-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n</ca>\n');
  const row = (host, op) => [host, '9.9.9.9', 100, 10, 1e8, 'X', 'JP', 5, 1000, 100, 1e9, '2weeks', op, '', cfg].join(',');
  const csv = ['*vpn_servers', '#HostName,...', row('vpn777', 'Daiyuu Nobori_ Japan. Academic Use Only.'), row('vpn888', 'home'), '*'].join('\n');
  assert.equal(parseVpnGate(csv).entries.length, 1, '主机名不像官方、但运营商是官方的也排除');
});

test('#6 登录请求体超过 8KB：流式读到上限就停，不整个读完', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(4096)); if (pulled > 1000) c.close(); } });
  const r = await readBodyLimited(new Request('https://x/', { method: 'POST', body, duplex: 'half' }), 8192);
  assert.equal(r, null);
  assert.ok(pulled < 10, '只读了 ' + pulled + ' 块');
  assert.equal(await readBodyLimited(new Request('https://x/', { method: 'POST', body: 'x', headers: { 'Content-Length': '99999' } })), null, '声明的长度超了直接拒绝');
  assert.equal(new TextDecoder().decode(await readBodyLimited(new Request('https://x/', { method: 'POST', body: 'password=pw' }))), 'password=pw');
});

test('#8 #9 公共函数只有一份', () => {
  assert.equal(authIp, dpIp);
  assert.equal(escHtml(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
});
