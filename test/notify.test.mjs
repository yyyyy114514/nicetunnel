import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, applyPatch } from '../src/control/settings.js';
import {
  sendTelegram, createNotifyState, formatRequestMessage, formatAlertMessage, notifyUsageEvents, redactSecrets, escapeHtml,
} from '../src/control/notify.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const settingsOn = (tg = {}) => applyPatch(defaultSettings(), { notify: { telegram: { enabled: true, botToken: TOKEN, chatId: '-100123', minIntervalSeconds: 60, ...tg } } });

function fakeFetch(status = 200, body = { ok: true }) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status }); };
  fn.calls = calls;
  return fn;
}

test('请求地址与上游一致：GET /bot<token>/sendMessage?chat_id&parse_mode=HTML&text', async () => {
  const f = fakeFetch();
  const r = await sendTelegram({ settings: settingsOn(), text: '<b>hi</b> 你好', fetchFn: f, now: 0, state: createNotifyState() });
  assert.deepEqual(r, { sent: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=-100123&parse_mode=HTML&text=${encodeURIComponent('<b>hi</b> 你好')}`);
  assert.equal(f.calls[0].init.method, 'GET');
});

test('未配置/未启用/事件关闭时不发送', async () => {
  const f = fakeFetch();
  const st = createNotifyState();
  assert.equal((await sendTelegram({ settings: defaultSettings(), text: 'x', fetchFn: f, state: st })).reason, 'not_configured');
  assert.equal((await sendTelegram({ settings: settingsOn({ enabled: false }), text: 'x', fetchFn: f, state: st })).reason, 'disabled');
  assert.equal((await sendTelegram({ settings: settingsOn(), event: 'subFetch', text: 'x', fetchFn: f, state: st })).reason, 'event_off');
  assert.equal(f.calls.length, 0);
  // force（测试消息）忽略启用开关
  assert.equal((await sendTelegram({ settings: settingsOn({ enabled: false }), text: 'x', fetchFn: f, state: st, force: true })).sent, true);
});

test('同类事件按 minIntervalSeconds 限频；同 dedupeKey 30 分钟内去重', async () => {
  const f = fakeFetch();
  const st = createNotifyState();
  const s = settingsOn({ minIntervalSeconds: 60 });
  assert.equal((await sendTelegram({ settings: s, event: 'adminLogin', text: 'a', fetchFn: f, now: 0, state: st })).sent, true);
  assert.equal((await sendTelegram({ settings: s, event: 'adminLogin', text: 'b', fetchFn: f, now: 30_000, state: st })).reason, 'rate');
  // 不同事件类型互不影响
  assert.equal((await sendTelegram({ settings: s, event: 'configSave', text: 'c', fetchFn: f, now: 30_000, state: st })).sent, true);
  assert.equal((await sendTelegram({ settings: s, event: 'adminLogin', text: 'd', fetchFn: f, now: 61_000, state: st, dedupeKey: 'k' })).sent, true);
  assert.equal((await sendTelegram({ settings: s, event: 'adminLogin', text: 'e', fetchFn: f, now: 200_000, state: st, dedupeKey: 'k' })).reason, 'dup');
  assert.equal((await sendTelegram({ settings: s, event: 'adminLogin', text: 'f', fetchFn: f, now: 61_000 + 1_800_001, state: st, dedupeKey: 'k' })).sent, true);
  assert.equal(f.calls.length, 4);
});

test('失败吞掉异常，错误信息不含 token', async () => {
  const boom = async () => { throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`); };
  const r = await sendTelegram({ settings: settingsOn(), text: 'x', fetchFn: boom, state: createNotifyState() });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'error');
  assert.ok(!r.error.includes(TOKEN.split(':')[1]));
  const r2 = await sendTelegram({ settings: settingsOn(), text: 'x', fetchFn: fakeFetch(401, { ok: false, description: 'Unauthorized' }), state: createNotifyState() });
  assert.equal(r2.sent, false);
  assert.match(r2.error, /401 Unauthorized/);
});

test('请求日志消息格式与上游一致（逐行）', () => {
  const time = Date.UTC(2026, 0, 2, 3, 4, 5);
  const msg = formatRequestMessage({
    siteName: 'nicetunnel', type: 'Admin_Login', ip: '1.2.3.4', cc: 'CN Shanghai', asn: 'AS4134 Chinanet',
    url: 'https://vp.x/admin?a=1', ua: 'UA<x>', time, usage: { used: 500, total: 1000 },
  });
  const lines = msg.split('\n');
  assert.equal(lines[0], '<b>#nicetunnel 日志通知</b>');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '📌 <b>类型：</b>#Admin_Login');
  assert.equal(lines[3], '🌐 <b>IP：</b><code>1.2.3.4</code>');
  assert.equal(lines[4], '📍 <b>位置：</b>CN Shanghai');
  assert.equal(lines[5], '🏢 <b>ASN：</b>AS4134 Chinanet');
  assert.equal(lines[6], '🔗 <b>域名：</b><code>vp.x</code>');
  assert.equal(lines[7], '🔍 <b>路径：</b><code>/admin?a=1</code>');
  assert.equal(lines[8], '🤖 <b>UA：</b><code>UA&lt;x&gt;</code>');
  assert.ok(lines[9].startsWith('📅 <b>时间：</b>'));
  assert.equal(lines[10], '📊 <b>请求用量：</b>500/1000 <b>50.00%</b>');
  // 无用量时不输出用量行
  assert.ok(!formatRequestMessage({ siteName: 's', type: 't', ip: '', cc: '', asn: '', url: 'https://a/', ua: '', time }).includes('📊'));
});

test('路径里的订阅 token 被脱敏', () => {
  const msg = formatRequestMessage({ siteName: 's', type: 'Get_SUB', ip: '', cc: '', asn: '', url: 'https://vp.x/sub?token=abcdef0123&clash', ua: '', time: 0 });
  assert.ok(msg.includes('/sub?token=***&amp;clash') || msg.includes('/sub?token=***&clash'));
  assert.ok(!msg.includes('abcdef0123'));
  assert.equal(redactSecrets(`x bot${TOKEN} y`), 'x bot*** y');
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
});

test('额度事件：同类合并为一条消息，同日同组去重', async () => {
  const f = fakeFetch();
  const st = createNotifyState();
  const events = [
    { type: 'lowQuota', accountId: 'a1', remaining: 100 },
    { type: 'lowQuota', accountId: 'a2', remaining: 50 },
    { type: 'accountError', accountId: 'a3', error: 'auth' },
    { type: 'unknownThing' },
  ];
  const accounts = [{ id: 'a1', name: '一号' }];
  const r = await notifyUsageEvents({ settings: settingsOn(), events, accounts, fetchFn: f, now: 1000, state: st });
  assert.equal(r.sent, 3);
  assert.equal(f.calls.length, 2);
  const text = decodeURIComponent(f.calls[0].url.split('&text=')[1]);
  assert.ok(text.includes('额度告警') && text.includes('一号') && text.includes('a2'));
  const again = await notifyUsageEvents({ settings: settingsOn({ minIntervalSeconds: 0 }), events, accounts, fetchFn: f, now: 5000, state: st });
  assert.equal(again.sent, 0);
  assert.ok(formatAlertMessage({ siteName: 's', event: { type: 'accountError', accountId: 'x', error: 'bad' }, time: 0 }).includes('账号异常'));
});
