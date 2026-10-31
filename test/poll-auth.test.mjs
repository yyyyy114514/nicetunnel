// 轮询鉴权：按凭据格式选鉴权方式、400/401/403 时换方式重试、错误信息带上 CF 的错误码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollAccount, authAttempts } from '../src/control/usage.js';

const GLOBAL_KEY = 'a'.repeat(37);
const TOKEN = 'Ab3_' + 'x'.repeat(36);
const ACC = '0123456789abcdef0123456789abcdef';
const gqlOk = { data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 5 } }], workersInvocationsAdaptive: [{ sum: { requests: 100 } }] }] } } };
const cfErr = (code, msg, chain) => ({ success: false, errors: [{ code, message: msg, ...(chain ? { error_chain: [chain] } : {}) }] });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 模拟 CF：Bearer 必须是 40 位 token；X-Auth-Key 必须是 37 位十六进制 */
function cfApi(log) {
  return async (url, init) => {
    const h = init.headers;
    log.push(h.Authorization ? 'bearer' : 'xkey');
    if (h.Authorization) {
      const v = h.Authorization.slice(7);
      if (!/^[A-Za-z0-9_-]{40}$/.test(v)) return json(400, cfErr(6003, 'Invalid request headers', { code: 6111, message: 'Invalid format for Authorization header' }));
      if (v !== TOKEN) return json(403, cfErr(10000, 'Authentication error'));
    } else {
      if (!/^[0-9a-f]{37}$/.test(h['X-AUTH-KEY'])) return json(400, cfErr(6003, 'Invalid request headers', { code: 6103, message: 'Invalid format for X-Auth-Key header' }));
      if (h['X-AUTH-KEY'] !== GLOBAL_KEY) return json(403, cfErr(9103, 'Unknown X-Auth-Key or X-Auth-Email'));
    }
    if (url.endsWith('/accounts')) return json(200, { result: [{ id: ACC, name: 'me@x.com' }] });
    const body = JSON.parse(init.body);
    assert.ok(!/\.\d{3}Z$/.test(body.variables.filter.datetime_leq), '时间不带毫秒');
    return json(200, gqlOk);
  };
}

test('authAttempts：Global Key 填进 API Token 栏（有邮箱）→ 先按 X-Auth-Key；Token 填进 Global Key 栏 → 先按 Bearer', () => {
  assert.deepEqual(authAttempts({ apiToken: GLOBAL_KEY, email: 'me@x.com' }).map((a) => a.label), ['API Token 栏里的 Global Key', 'API Token']);
  assert.deepEqual(authAttempts({ globalKey: TOKEN, email: 'me@x.com' }).map((a) => a.label), ['Global API Key 栏里的 API Token'.replace('Global API Key', 'Global Key'), 'Global Key']);
  assert.deepEqual(authAttempts({ apiToken: TOKEN }).map((a) => a.label), ['API Token']);
  assert.deepEqual(authAttempts({}), []);
});

test('Global Key 误填在 API Token 栏：自动按 X-Auth-Key 查询成功', async () => {
  const log = [];
  const r = await pollAccount({ auth: { apiToken: GLOBAL_KEY, email: 'me@x.com', accountId: ACC } }, { fetchFn: cfApi(log) });
  assert.equal(r.ok, true);
  assert.equal(r.used, 105);
  assert.deepEqual(log, ['xkey']);
});

test('API Token 误填在 Global Key 栏：自动按 Bearer 查询成功', async () => {
  const log = [];
  const r = await pollAccount({ auth: { globalKey: TOKEN, email: 'me@x.com', accountId: ACC } }, { fetchFn: cfApi(log) });
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['bearer']);
});

test('凭据里夹带空格/换行/引号/零宽字符：清理后照常使用', async () => {
  const r = await pollAccount({ auth: { apiToken: ' "' + TOKEN.slice(0, 20) + '​ \n' + TOKEN.slice(20) + '" ', accountId: ACC } }, { fetchFn: cfApi([]) });
  assert.equal(r.ok, true);
});

test('400：错误信息带 CF 错误码与说明，并提示原因；只有一种凭据时不重试', async () => {
  const log = [];
  const r = await pollAccount({ auth: { apiToken: 'not-a-valid-token', accountId: ACC } }, { fetchFn: cfApi(log) });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth');
  assert.match(r.error, /查询失败: 400 6003 Invalid request headers \/ 6111 Invalid format for Authorization header/);
  assert.match(r.error, /API Token 格式不对/);
  assert.deepEqual(log, ['bearer']);
});

test('Bearer 被拒（400）且同时填了邮箱+Global Key：自动换 X-Auth-Key 成功；两种都失败时说明试过哪些', async () => {
  const log = [];
  const r = await pollAccount({ auth: { apiToken: 'bad', email: 'me@x.com', globalKey: GLOBAL_KEY, accountId: ACC } }, { fetchFn: cfApi(log) });
  assert.equal(r.ok, true);
  assert.deepEqual(log, ['bearer', 'xkey']);
  const r2 = await pollAccount({ auth: { apiToken: 'bad', email: 'me@x.com', globalKey: 'b'.repeat(37), accountId: ACC } }, { fetchFn: cfApi([]) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /已尝试 API Token、Global Key/);
});

test('没填 Account ID：/accounts 的 400 同样带详细原因', async () => {
  const r = await pollAccount({ auth: { apiToken: 'short' } }, { fetchFn: cfApi([]) });
  assert.match(r.error, /^账户获取失败: 400 6003/);
});
