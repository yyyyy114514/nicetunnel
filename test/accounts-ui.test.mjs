// 账号页：不再有角色下拉 / Account ID 列；多选批量操作与轮询按钮；设置项归到对应页面；节点统计起始时间
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminHtml } from '../src/admin/ui.js';
import { pollBatch } from '../src/control/usage.js';
import { resetStats, snapshotStats, bump } from '../src/dataplane/stats.js';

const js = adminHtml({}).match(/<script>([\s\S]*)<\/script>/)[1];

test('后台脚本可解析；账号页没有角色下拉与 Account ID 列', () => {
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes('data-k="role"'), '不再让用户选角色');
  assert.ok(!js.includes('<th>Account ID</th>'), 'Account ID 不单独占列');
  assert.ok(!js.includes('<th>角色</th>'));
});

test('多选：批量启用 / 禁用 / 删除 / 轮询所选；账号页有轮询按钮', () => {
  for (const id of ['multiAcc', 'pollAcc', 'bEnable', 'bDisable', 'bDel', 'bPoll', 'pickAll']) assert.ok(js.includes(`id="${id}"`), id);
  assert.ok(js.includes('data-pick='));
});

test('设置项归位：额度相关全在「额度」页，伪装页在节点参数，账号页不再混放设置', () => {
  const sec = (k) => js.slice(js.indexOf('    ' + k + ': ['), js.indexOf('\n    ],', js.indexOf('    ' + k + ': [')));
  for (const p of ['paid.main', 'usage.enabled', 'allocation.enabled', 'hosts.unmanaged']) assert.ok(sec('quota').includes("'" + p + "'"), p);
  assert.ok(sec('node').includes("'camouflage.url'"));
  assert.ok(sec('sub').includes('"客户端测速"') && sec('sub').includes("'sub.testIntervalMin'"));
  assert.ok(!js.includes("sectionHtml('accounts')"), '账号页只有账号表、检测、导入');
  assert.ok(js.includes("const OLD_TABS = { pref: 'sources', net: 'tools', adv: 'system' }"), '旧页名自动跳到新页');
});

test('节点统计：起始时间不取脚本加载时（Workers 全局作用域 Date.now()=0）', () => {
  resetStats();
  const t = 1_800_000_000_000;
  bump('ws');
  const st = snapshotStats(t);
  assert.ok(st.upMin < 60 * 24 * 365, '不应出现几千万分钟：' + st.upMin);
  resetStats();
  assert.equal(snapshotStats(t).upMin, 0, '首次查询即开始计时');
});

test('缓存的 Account ID 失效（换了 Token）：自动重新发现一次', async () => {
  const OLD = 'a'.repeat(32), NEW = 'b'.repeat(32);
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/accounts')) return new Response(JSON.stringify({ result: [{ id: NEW, name: 'x' }] }), { status: 200 });
    const id = JSON.parse(init.body).variables.AccountID;
    const accounts = id === NEW ? [{ pagesFunctionsInvocationsAdaptiveGroups: [], workersInvocationsAdaptive: [{ sum: { requests: 7 } }] }] : [];
    return new Response(JSON.stringify({ data: { viewer: { accounts } } }), { status: 200 });
  };
  const now = Date.UTC(2026, 9, 31, 6);
  const accounts = [{ id: 'n1', hosts: ['a.com'], role: 'node', enabled: true, auth: { apiToken: 'x'.repeat(40) } }];
  const snapshot = { v: 1, ts: now - 1e6, day: new Date(now).toISOString().slice(0, 10), accounts: { n1: { accountId: OLD, used: 0, polledAt: 0 } } };
  const r = await pollBatch({ accounts, snapshot, settings: {}, now, fetchFn, force: true, ids: ['n1'] });
  assert.equal(r.snapshot.accounts.n1.ok, true, JSON.stringify(r.snapshot.accounts.n1));
  assert.equal(r.snapshot.accounts.n1.accountId, NEW);
  assert.equal(r.snapshot.accounts.n1.used, 7);
  assert.ok(calls.some((u) => u.endsWith('/accounts')));
});

test('页内索引：卡片 ≥3 张时生成，吸顶（手机上贴在顶部导航下），滚动高亮，不用 nav 标签', () => {
  assert.ok(js.includes('function buildToc(main)'));
  assert.ok(js.includes('if (cards.length < 3) return;'));
  assert.ok(js.includes("document.createElement('div')") && js.includes("toc.setAttribute('role', 'navigation')"), '全局 nav 样式是纵向的，索引必须用 div');
  const html = adminHtml({});
  assert.ok(html.includes('.toc{position:sticky;top:var(--stick,0px)'));
  assert.ok(js.includes("setProperty('--stick'"), '手机上按顶部导航高度设置吸顶位置');
});

test('主号额度：额度页有主号卡片（与本页设置共用保存栏），账号表与全选不含主号，自检提示未填主号 Token', async () => {
  assert.ok(js.includes('function pgQuota() { return mainCard() + sectionHtml(\'quota\'); }'));
  assert.ok(js.includes('data-main="apiToken"') && js.includes('id="mainPoll"'));
  assert.ok(js.includes("collectMain(root) ? 1 : 0"), '主号输入也计入改动、显示保存栏');
  assert.ok(js.includes("if (a.role === 'main') return '';"), '账号表不显示主号');
  assert.ok(js.includes("if (a.role !== 'main') accPicked.add(i);"), '全选不选中主号（批量删除不会删掉它）');
  const { selfCheck } = await import('../src/control/selfcheck.js');
  const { settingsWith } = await import('./helpers.mjs');
  const ids = (accounts) => selfCheck({ settings: settingsWith({}), accounts, usage: null, host: 'm.com', now: 0, kvBound: true }).map((c) => c.id);
  assert.ok(ids([]).includes('main-quota'));
  assert.ok(!ids([{ id: 'main', role: 'main', enabled: true, hosts: [], auth: { apiToken: 'x'.repeat(40) } }]).includes('main-quota'));
});
