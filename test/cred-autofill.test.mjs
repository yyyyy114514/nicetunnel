// 浏览器把后台密码自动填进 Token 框：保存时忽略、已存的给自检警告、输入框禁止自动填充
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { selfCheck } from '../src/control/selfcheck.js';
import { normalizeSettings } from '../src/control/settings.js';
import { adminHtml } from '../src/admin/ui.js';
import { memKV } from './helpers.mjs';

beforeEach(() => { resetStoreState(); resetPipelineState(); });

const TOKEN = 'Ab3_' + 'x'.repeat(36);
function setup() {
  const kv = memKV({ 'nt.settings': { schema: 4 }, 'nt.accounts': [{ id: 'n1', name: '节点1', hosts: ['vp2.example.com'], role: 'node', auth: { apiToken: TOKEN, accountId: '' } }] });
  return { kv, env: { KV: kv, ADMIN: 'pass123', KEY: 'mykey' }, ctx: { waitUntil() {} } };
}
const api = (path, method, body, env, ctx) => worker.fetch(new Request('https://vp.example.com/admin/api/' + path, { method, headers: { Authorization: 'Bearer ' + env.ADMIN, 'Content-Type': 'application/json', 'User-Agent': 'curl/8' }, body: body && JSON.stringify(body) }), env, ctx);

test('保存账号：Token 栏里是后台密码（浏览器自动填充）→ 当作未填，保留原 Token', async () => {
  const { kv, env, ctx } = setup();
  const r = await api('accounts', 'PUT', { mode: 'replace', accounts: [{ id: 'n1', name: '节点1', hosts: ['vp2.example.com'], role: 'node', auth: { apiToken: env.ADMIN, accountId: '0123456789abcdef0123456789abcdef' } }] }, env, ctx);
  assert.equal(r.status, 200);
  const saved = JSON.parse(await kv.get('nt.accounts'));
  assert.equal(saved[0].auth.apiToken, TOKEN, '原 Token 保留');
  assert.equal(saved[0].auth.accountId, '0123456789abcdef0123456789abcdef', '其他字段照常更新');
});

test('脚本 upsert / 批量导入同样忽略等于后台密码的凭据', async () => {
  const { kv, env, ctx } = setup();
  await api('accounts/upsert', 'POST', { accounts: [{ host: 'vp2.example.com', apiToken: env.ADMIN }] }, env, ctx);
  assert.equal(JSON.parse(await kv.get('nt.accounts'))[0].auth.apiToken, TOKEN);
  await api('accounts/import', 'POST', { text: 'vp2.example.com,0123456789abcdef0123456789abcdef,' + env.ADMIN, dryRun: false }, env, ctx);
  assert.equal(JSON.parse(await kv.get('nt.accounts'))[0].auth.apiToken, TOKEN);
});

test('自检：已保存的 Token 等于后台密码时警告', () => {
  const run = (tok) => selfCheck({ settings: normalizeSettings({}), accounts: [{ id: 'n1', name: '节点1', role: 'node', hosts: ['a.x'], auth: { apiToken: tok } }], usage: null, host: 'vp.x', now: Date.now(), kvBound: true, identity: { adminPassword: 'pass123' } });
  assert.ok(run('pass123').some((c) => c.id === 'cred-is-admin-pw' && c.level === 'warn'));
  assert.ok(!run(TOKEN).some((c) => c.id === 'cred-is-admin-pw'));
});

test('后台的 Token / 密钥输入框禁止浏览器与密码管理器自动填充', () => {
  const html = adminHtml({});
  assert.ok(html.includes('data-k="apiToken" type="password" autocomplete="new-password"'));
  assert.ok(html.includes('type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore data-p='));
});
