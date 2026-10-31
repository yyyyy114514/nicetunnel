// CF 优选节点走主站域名（preferred.random.onMain，与 edgetunnel 相同）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetStoreState } from '../src/control/store.js';
import { resetPipelineState } from '../src/control/pipeline.js';
import { resetRulesState } from '../src/control/rulesfeed.js';
import { deriveIdentity } from '../src/control/identity.js';
import { selfCheck } from '../src/control/selfcheck.js';
import { memKV, fakeFetch, settingsWith } from './helpers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { resetStoreState(); resetPipelineState(); resetRulesState(); });
afterEach(() => { globalThis.fetch = realFetch; });

async function lines(random) {
  const kv = memKV({ 'nt.settings': { schema: 5, rules: { configText: '', configUrl: '' }, preferred: { custom: { enabled: true, text: '1.2.3.4:443#日本-住宅-01' }, random: { enabled: true, count: 6, ...random } }, hosts: { unmanaged: ['vp2.example.com', 'vp3.example.com'] } }, 'nt.accounts': [] });
  const env = { KV: kv, ADMIN: 'pass123', KEY: 'mykey' };
  const id = deriveIdentity(env, 'vp.example.com');
  globalThis.fetch = fakeFetch({});
  const res = await worker.fetch(new Request('https://vp.example.com/sub?token=' + id.subToken, { headers: { 'User-Agent': 'v2rayN/6', 'CF-Connecting-IP': '1.2.3.4' } }), env, { waitUntil() {} });
  return new TextDecoder().decode(Uint8Array.from(atob(await res.text()), (c) => c.charCodeAt(0))).split('\n').filter(Boolean);
}
const hostOf = (l) => decodeURIComponent((l.match(/[?&]host=([^&#]+)/) || [])[1] || '');

test('打开后：随机优选节点全部用主站域名，优质节点照常按额度分到节点域名', async () => {
  const ls = await lines({ onMain: true });
  const random = ls.filter((l) => !l.includes('@1.2.3.4:'));
  const custom = ls.filter((l) => l.includes('@1.2.3.4:'));
  assert.equal(random.length, 6);
  assert.ok(random.every((l) => hostOf(l) === 'vp.example.com'), random.map(hostOf).join());
  assert.ok(custom.every((l) => /^vp[23]\.example\.com$/.test(hostOf(l))));
});

test('默认关闭：随机优选按额度分到节点域名（不占主站）', async () => {
  const ls = await lines({});
  assert.ok(ls.every((l) => /^vp[23]\.example\.com$/.test(hostOf(l))));
});

test('自检：打开时说明额度算在主站上', () => {
  const run = (paid) => selfCheck({ settings: settingsWith({ preferred: { random: { onMain: true } }, paid }), accounts: [], usage: null, host: 'm.com', now: 0, kvBound: true });
  const c = run({ main: false }).find((x) => x.id === 'cf-on-main');
  assert.ok(c && c.text.includes('Workers Paid'));
  assert.ok(!run({ main: true }).find((x) => x.id === 'cf-on-main').text.includes('可考虑'));
});
