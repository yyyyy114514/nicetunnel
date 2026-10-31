import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, applyPatch } from '../src/control/settings.js';
import {
  shouldLog, makeLogEntry, normalizeLogEntry, filterLogs, recordLog, createLogState, trackRequest, LOG_LIMITS,
} from '../src/control/logs.js';
import { createNotifyState } from '../src/control/notify.js';

function memStore() {
  const buf = [], flushes = [];
  return { buf, flushes, appendLog: (e) => buf.push(e), flushLogs: async (o) => { flushes.push(o); return false; } };
}

test('shouldLog：log.enabled / OFF_LOG / subFetch', () => {
  const s = defaultSettings();
  assert.equal(shouldLog(s, 'Admin_Login'), true);
  assert.equal(shouldLog(s, 'Get_SUB'), false); // 默认 subFetch=false
  assert.equal(shouldLog(applyPatch(s, { log: { subFetch: true } }), 'Get_SUB'), true);
  assert.equal(shouldLog(applyPatch(s, { log: { enabled: false } }), 'Admin_Login'), false);
  assert.equal(shouldLog(s, 'Admin_Login', { OFF_LOG: 'true' }), false);
});

test('makeLogEntry：字段格式、截断与脱敏', () => {
  const e = makeLogEntry({
    type: 'Get_SUB', now: 123, ip: '1.2.3.4', ua: 'x'.repeat(1000),
    cf: { country: 'CN', city: 'Beijing', asn: 4134, asOrganization: 'Chinanet' },
    url: 'https://vp.x/sub?token=secret123&b64', msg: 'm',
  });
  assert.equal(e.t, 123);
  assert.equal(e.type, 'Get_SUB');
  assert.equal(e.loc, 'CN Beijing');
  assert.equal(e.asn, 'AS4134 Chinanet');
  assert.equal(e.ua.length, LOG_LIMITS.ua);
  assert.ok(!e.url.includes('secret123'));
  assert.deepEqual(Object.keys(e).sort(), ['asn', 'ip', 'loc', 'msg', 't', 'type', 'ua', 'url']);
  assert.equal(makeLogEntry({ type: 'x', now: 0 }).loc, 'N/A N/A');
});

test('normalizeLogEntry 兼容上游 log.json 格式', () => {
  const e = normalizeLogEntry({ TYPE: 'Get_SUB', IP: '1.1.1.1', ASN: 'AS1 X', CC: 'US LA', URL: 'https://a/sub?token=zz', UA: 'u', TIME: 5 });
  assert.deepEqual(e, { t: 5, type: 'Get_SUB', ip: '1.1.1.1', ua: 'u', loc: 'US LA', asn: 'AS1 X', url: 'https://a/sub?token=***', msg: '' });
  assert.equal(normalizeLogEntry(null), null);
});

test('filterLogs：最新在前、按类型过滤、limit', () => {
  const logs = [];
  for (let i = 0; i < 10; i++) logs.push({ t: i, type: i % 2 ? 'A' : 'B', ip: '', ua: '', loc: '', msg: '' });
  const all = filterLogs(logs, { limit: 3 });
  assert.deepEqual(all.map((e) => e.t), [9, 8, 7]);
  const a = filterLogs(logs, { type: 'A' });
  assert.deepEqual(a.map((e) => e.t), [9, 7, 5, 3, 1]);
  assert.deepEqual(filterLogs(null), []);
});

test('recordLog：进入 store 缓冲并按 settings.log 调用 flush；非订阅类 30 分钟去重', async () => {
  const store = memStore();
  const settings = applyPatch(defaultSettings(), { log: { flushMinutes: 7, maxEntries: 99 } });
  const state = createLogState();
  const entry = makeLogEntry({ type: 'Admin_Login', now: 0, ip: '1.1.1.1', ua: 'u', url: 'https://a/admin' });
  assert.equal(await recordLog({ store, settings, entry, now: 0, state }), true);
  assert.equal(await recordLog({ store, settings, entry, now: 60_000, state }), false);
  assert.equal(await recordLog({ store, settings, entry, now: 31 * 60_000, state }), true);
  assert.equal(store.buf.length, 2);
  assert.deepEqual(store.flushes[0], { flushMinutes: 7, maxEntries: 99 });
  // 订阅拉取：subFetch=false 时不记
  const sub = makeLogEntry({ type: 'Get_SUB', now: 0 });
  assert.equal(await recordLog({ store, settings, entry: sub, now: 0, state }), false);
  // subFetch=true 时记录且不去重
  const s2 = applyPatch(settings, { log: { subFetch: true } });
  assert.equal(await recordLog({ store, settings: s2, entry: sub, now: 0, state }), true);
  assert.equal(await recordLog({ store, settings: s2, entry: sub, now: 1, state }), true);
});

test('trackRequest：记日志 + 按事件开关发 TG；异常不抛', async () => {
  const store = memStore();
  const calls = [];
  const fetchFn = async (u) => { calls.push(String(u)); return new Response('{}'); };
  const settings = applyPatch(defaultSettings(), { notify: { telegram: { enabled: true, botToken: '1:abc', chatId: '1' } } });
  const request = new Request('https://vp.x/admin', { headers: { 'User-Agent': 'UA', 'CF-Connecting-IP': '8.8.8.8' } });
  const r = await trackRequest({ request, store, settings, now: 0, fetchFn, logState: createLogState(), notifyState: createNotifyState() }, { type: 'Admin_Login' });
  assert.equal(r.logged, true);
  assert.equal(r.tg.sent, true);
  assert.equal(store.buf[0].ip, '8.8.8.8');
  assert.ok(decodeURIComponent(calls[0]).includes('#Admin_Login'));
  // 订阅拉取：subFetch 事件默认关闭 → 不发
  const r2 = await trackRequest({ request, store, settings, now: 0, fetchFn, logState: createLogState(), notifyState: createNotifyState() }, { type: 'Get_SUB' });
  assert.equal(r2.tg.sent, false);
  const bad = await trackRequest({ request: null }, { type: 'x' });
  assert.equal(bad.logged, false);
});
