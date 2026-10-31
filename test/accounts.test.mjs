import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccounts, publicAccounts, parseAccountsText, importUsagePanelConfig, mergeAccounts, mergeAccountsWithStats,
  backfillAccountIds, deriveAccountId, hasCredentials,
} from '../src/control/accounts.js';

const AID = '0123456789abcdef0123456789abcdef';
const AID2 = 'fedcba9876543210fedcba9876543210';

test('normalizeAccounts：清洗、默认值、未知键丢弃', () => {
  const [a] = normalizeAccounts([{ hosts: ['HTTPS://VP2.Example.com:443/path', 'bad host', 'vp2.example.com'], role: 'x', weight: 'abc', limit: 5, evil: 1,
    auth: { accountId: AID.toUpperCase(), apiToken: ' tok ', email: 'A@B.COM', globalKey: '', junk: 1 } }]);
  assert.deepEqual(a.hosts, ['vp2.example.com']);
  assert.equal(a.role, 'node');
  assert.equal(a.enabled, true);
  assert.equal(a.weight, 1);
  assert.equal(a.limit, null);
  assert.equal(a.auth.accountId, AID);
  assert.equal(a.auth.apiToken, 'tok');
  assert.equal(a.auth.email, 'a@b.com');
  assert.equal(a.evil, undefined);
  assert.equal(a.auth.junk, undefined);
  assert.deepEqual(Object.keys(a).sort(), ['auth', 'enabled', 'hosts', 'id', 'limit', 'name', 'note', 'paid', 'role', 'weight']);
  assert.ok(a.id.startsWith('a'));
  assert.equal(a.id, deriveAccountId(a));
});

test('normalizeAccounts：id 去重、host 去重、非对象跳过、非法 accountId 置空、limit 合法值保留', () => {
  const list = normalizeAccounts([
    { id: 'x', hosts: 'a.com, b.com' },
    { id: 'x', hosts: ['b.com', 'c.com'], auth: { accountId: 'nothex' }, limit: 50000, role: 'main', enabled: false, weight: 2.5 },
    null, 'str',
    {},
  ]);
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'x');
  assert.equal(list[1].id, 'x-2');
  assert.deepEqual(list[0].hosts, ['a.com', 'b.com']);
  assert.deepEqual(list[1].hosts, ['c.com']);
  assert.equal(list[1].auth.accountId, '');
  assert.equal(list[1].limit, 50000);
  assert.equal(list[1].role, 'main');
  assert.equal(list[1].enabled, false);
  assert.equal(list[1].weight, 2.5);
  assert.equal(list[2].id, 'a3');
  assert.deepEqual(normalizeAccounts(null), []);
  assert.equal(normalizeAccounts({ accounts: [{ id: 'k' }] })[0].id, 'k');
  // 幂等
  assert.deepEqual(normalizeAccounts(list), list);
});

test('normalizeAccounts：打码的凭据视为空', () => {
  const [a] = normalizeAccounts([{ auth: { apiToken: 'abc*****xyz', globalKey: 'k****' } }]);
  assert.equal(a.auth.apiToken, '');
  assert.equal(a.auth.globalKey, '');
});

test('publicAccounts 脱敏但保留 email/accountId', () => {
  const [p] = publicAccounts([{ id: 'a', hosts: ['a.com'], auth: { accountId: AID, apiToken: 'secret-token', email: 'x@y.com', globalKey: 'gk' } }]);
  assert.deepEqual(p.auth, { accountId: AID, hasToken: true, hasKey: true, email: 'x@y.com' });
  assert.ok(!JSON.stringify(p).includes('secret-token'));
  assert.ok(!JSON.stringify(p).includes('"gk"'));
});

test('parseAccountsText：多种分隔符、email 识别、注释、错误收集、名称含空格', () => {
  const text = [
    '# 注释',
    '',
    `vp2.example.com,${AID},tokenA,二号 机`,
    `vp3.example.com|${AID2}|tokenB`,
    'vp4.example.com\tme@mail.com\tglobalkey',
    'vp5.example.com  bad-id  tok',
    'vp6.example.com,onlytwo',
    'not_a host!,x,y',
    `vp2.example.com,${AID},dup`,
    'vp7.example.com,me@mail.com,abc****xyz',
  ].join('\n');
  const { accounts, errors } = parseAccountsText(text);
  assert.equal(accounts.length, 3);
  assert.equal(accounts[0].hosts[0], 'vp2.example.com');
  assert.equal(accounts[0].name, '二号 机');
  assert.equal(accounts[0].auth.apiToken, 'tokenA');
  assert.equal(accounts[1].auth.accountId, AID2);
  assert.equal(accounts[2].auth.email, 'me@mail.com');
  assert.equal(accounts[2].auth.globalKey, 'globalkey');
  assert.equal(accounts[2].auth.accountId, '');
  assert.equal(errors.length, 5, errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('第 6 行') && e.includes('32 位')));
  assert.ok(errors.some((e) => e.includes('第 7 行') && e.includes('列数不足')));
  assert.ok(errors.some((e) => e.includes('重复域名')));
  assert.ok(errors.some((e) => e.includes('打码')));
  assert.ok(accounts.every(hasCredentials));
});

test('importUsagePanelConfig：旧面板格式', () => {
  const json = JSON.stringify([
    { ID: 0, Name: '示例账号1', Email: null, GlobalAPIKey: null, AccountID: AID, APIToken: 'tok1', Usage: { total: 5 } },
    { ID: 1, Name: 'vp9.example.com', Email: 'u@x.com', GlobalAPIKey: 'gk', AccountID: '', APIToken: null },
    { ID: 2, Name: '打码', Email: null, GlobalAPIKey: null, AccountID: AID2, APIToken: 'abcd*****wxyz' },
    { ID: 3, Name: '无凭据', Email: 'u@x.com' },
    { ID: 4, Name: '坏ID', AccountID: '123', APIToken: 't' },
  ]);
  const { accounts, errors } = importUsagePanelConfig(json);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].name, '示例账号1');
  assert.deepEqual(accounts[0].hosts, []);
  assert.equal(accounts[0].auth.accountId, AID);
  assert.equal(accounts[0].auth.apiToken, 'tok1');
  assert.deepEqual(accounts[1].hosts, ['vp9.example.com']);
  assert.equal(accounts[1].auth.globalKey, 'gk');
  assert.equal(errors.length, 3);
  assert.deepEqual(importUsagePanelConfig('{bad').errors, ['JSON 解析失败']);
  assert.equal(importUsagePanelConfig({ a: 1 }).errors.length, 1);
});

test('mergeAccounts merge：按 host/accountId 匹配，空凭据保留旧值，保留手工设置，未匹配追加', () => {
  const current = normalizeAccounts([
    { id: 'm', name: '主站', role: 'main', hosts: [], auth: { accountId: AID2, apiToken: 'mainTok' } },
    { id: 'n2', name: '二号', hosts: ['vp2.example.com'], weight: 3, auth: { accountId: AID, apiToken: 'old' } },
  ]);
  const incoming = parseAccountsText(`vp2.example.com,${AID},new\nvp3.example.com,${AID2.replace('f', '1')},t3`).accounts;
  const r = mergeAccountsWithStats(current, incoming, { mode: 'merge' });
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.accounts.length, 3);
  const n2 = r.accounts.find((a) => a.id === 'n2');
  assert.equal(n2.auth.apiToken, 'new');
  assert.equal(n2.weight, 3);
  assert.equal(n2.name, '二号'); // 导入未给名称 → 保留
  // 空凭据保留
  const r2 = mergeAccounts(current, [{ id: 'n2', hosts: ['vp2.example.com', 'vp2b.example.com'], auth: { apiToken: '' } }], { mode: 'merge' });
  const n2b = r2.find((a) => a.id === 'n2');
  assert.equal(n2b.auth.apiToken, 'old');
  assert.deepEqual(n2b.hosts, ['vp2.example.com', 'vp2b.example.com']);
  // overwriteMeta
  const r3 = mergeAccounts(current, [{ id: 'n2', weight: 0.5 }], { mode: 'merge', overwriteMeta: true });
  assert.equal(r3.find((a) => a.id === 'n2').weight, 0.5);
  // 按 accountId 匹配（无 host 的主站）
  const r4 = mergeAccountsWithStats(current, [{ auth: { accountId: AID2, apiToken: 'mainTok2' } }], { mode: 'merge' });
  assert.equal(r4.updated, 1);
  assert.equal(r4.accounts.find((a) => a.id === 'm').auth.apiToken, 'mainTok2');
});

test('mergeAccounts replace：结果为 incoming，匹配到的空 auth 字段保留，切换到 globalKey 时清 token', () => {
  const current = normalizeAccounts([
    { id: 'n2', hosts: ['vp2.example.com'], auth: { accountId: AID, apiToken: 'old' } },
    { id: 'n3', hosts: ['vp3.example.com'], auth: { accountId: AID2, apiToken: 'keep' } },
  ]);
  const out = mergeAccounts(current, [
    { id: 'n3', hosts: ['vp3.example.com'], name: '三', auth: { apiToken: '' } },
    { hosts: ['vp2.example.com'], auth: { email: 'a@b.com', globalKey: 'gk' } },
  ], { mode: 'replace' });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'n3');
  assert.equal(out[0].auth.apiToken, 'keep');
  assert.equal(out[0].auth.accountId, AID2);
  assert.equal(out[1].id, 'n2');
  assert.equal(out[1].auth.apiToken, '');
  assert.equal(out[1].auth.globalKey, 'gk');
  assert.equal(out[1].auth.accountId, AID);
});

test('backfillAccountIds：把轮询发现的 accountId 回填', () => {
  const accounts = normalizeAccounts([{ id: 'a', hosts: ['a.com'], auth: { email: 'x@y.com', globalKey: 'k' } }, { id: 'b', hosts: ['b.com'], auth: { accountId: AID } }]);
  const snap = { accounts: { a: { accountId: AID2 }, b: { accountId: AID2 } } };
  const r = backfillAccountIds(accounts, snap);
  assert.equal(r.changed, true);
  assert.equal(r.accounts[0].auth.accountId, AID2);
  assert.equal(r.accounts[1].auth.accountId, AID); // 已有的不覆盖
  assert.equal(backfillAccountIds(r.accounts, snap).changed, false);
});
