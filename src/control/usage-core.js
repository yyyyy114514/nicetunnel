// 用量基础函数（无 I/O）。从 usage.js 拆出，供 allocator.js 使用，避免 usage ↔ allocator 循环依赖（单文件打包要求无环）。
// usage.js 会原样转出这些导出，外部仍可从 usage.js 引用。
import { defaultSettings } from './settings.js';

/** @typedef {import('../types.js').UsageSnapshot} UsageSnapshot */
/** @typedef {import('../types.js').AccountUsage} AccountUsage */

const DAY_MS = 86400000;

let DEFAULT_USAGE = null;
/** settings.usage（缺省字段用默认值补齐；不做完整 normalize，省 CPU） */
export function usageCfg(settings) {
  DEFAULT_USAGE ||= defaultSettings().usage;
  return { ...DEFAULT_USAGE, ...(settings?.usage || {}) };
}

/** UTC 日期 'YYYY-MM-DD' */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
/** 当日 UTC 0 点(ms) */
export const dayStartMs = (ms) => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
/** 下一个 UTC 0 点(ms)（额度重置时间） */
export const nextResetMs = (ms) => dayStartMs(ms) + DAY_MS;

/** 一条账号用量的"新旧"键：最近一次尝试（成功或失败）时间 */
const freshness = (u) => Math.max(Number(u?.triedAt) || 0, Number(u?.polledAt) || 0);

/**
 * 合并两份快照：逐账号取更新的那条（多个 isolate / Cron 与懒刷新并发轮询时不互相覆盖）。
 * 不同 UTC 日时以较新的日为准，旧日的条目丢弃。返回新对象；任一为空返回另一份。
 * @param {UsageSnapshot|null|undefined} a
 * @param {UsageSnapshot|null|undefined} b
 * @returns {UsageSnapshot|null}
 */
export function mergeSnapshots(a, b) {
  if (!a?.accounts) return b?.accounts ? b : a || b || null;
  if (!b?.accounts) return a;
  if (a.day !== b.day) return a.day > b.day ? a : b;
  const accounts = { ...a.accounts };
  for (const [id, u] of Object.entries(b.accounts)) {
    if (!accounts[id] || freshness(u) > freshness(accounts[id])) accounts[id] = u;
  }
  const newer = (b.ts || 0) >= (a.ts || 0) ? b : a;
  return { ...newer, accounts, ts: Math.max(a.ts || 0, b.ts || 0) };
}

/**
 * 把一条 AccountUsage 视图换算到"今天"：若最近成功轮询在之前的 UTC 日，则今日用量必为 0（CF 在 UTC 0 点重置），
 * 视为"在今日 0 点已知 used=0"：used/workers/pages/rate 清零，polledAt=今日 0 点。
 * 不修改入参。从未轮询(polledAt=0)的保持不变。
 * @param {AccountUsage|undefined} u
 * @returns {AccountUsage|undefined}
 */
export function usageForToday(u, now) {
  if (!u || !u.polledAt) return u;
  const start = dayStartMs(now);
  if (u.polledAt >= start) return u;
  return { ...u, used: 0, workers: 0, pages: 0, rate: 0, polledAt: start };
}
