// 客户端测速间隔：默认完全按 INI；只有号池额度吃紧时才逐步放慢（额度保护）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPolicy, groupInterval } from '../src/control/allocator.js';
import { normalizeSettings } from '../src/control/settings.js';

const s = normalizeSettings({});
// 当前时刻：UTC 中午（今天剩一半时间）
const now = Date.UTC(2026, 9, 30, 12);
const resetAt = Date.UTC(2026, 9, 31);
const sum = (remaining, budget = 1e6) => ({ budget, remaining, used: budget - remaining, resetAt });

test('默认：余量正常（含充足）时 tight=0，各组完全按 INI；吃紧才放慢', () => {
  assert.equal(s.sub.testIntervalAuto, true);
  assert.equal(s.sub.testIntervalMin, 0);
  assert.equal(testPolicy(sum(1e6), s, now).tight, 0, '余量比 2');
  assert.equal(testPolicy(sum(5e5), s, now).tight, 0, '刚好平均节奏');
  assert.equal(testPolicy(sum(3.75e5), s, now).tight, 0.5, '余量比 0.75');
  assert.equal(testPolicy(sum(1e5), s, now).tight, 1, '余量比 0.2');
  assert.equal(testPolicy(sum(0), s, now).tight, 1);
});

test('groupInterval：tight=0 原样（180 / 300 不被拉长）；吃紧时向上限线性拉长并取整到 60；不低于下限', () => {
  const p = (tight, min = 0, ceil = 1800) => ({ min, tight, ceil });
  assert.equal(groupInterval(180, p(0)), 180, '故障转移 180 秒保持');
  assert.equal(groupInterval(300, p(0)), 300, '随机优选 300 秒保持');
  assert.equal(groupInterval(300, p(1)), 1800);
  assert.equal(groupInterval(300, p(0.5)), 1080);
  assert.equal(groupInterval(300, p(0, 600)), 600, '设了下限');
  assert.equal(groupInterval(3600, p(1)), 3600, 'INI 比上限还长：不缩短');
  assert.equal(groupInterval(undefined, p(0)), 300, 'INI 没写间隔：300');
});

test('关闭额度保护 / 没有预算数据：tight=0；临近重置不会除以 0', () => {
  assert.equal(testPolicy(sum(0), normalizeSettings({ sub: { testIntervalAuto: false } }), now).tight, 0);
  assert.equal(testPolicy({ budget: 0, remaining: 0, resetAt }, s, now).tight, 0);
  assert.ok(Number.isFinite(testPolicy(sum(1e5), s, resetAt - 60e3).tight));
});
