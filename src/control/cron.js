// Cron（主站，建议 */5）：每次触发 = 一批账号用量轮询 + 一小块维护任务（轮转）。
// 免费版 Cron 单次 CPU 10ms：所有任务都按"小块"设计；网络等待不计 CPU。
import { createStore } from './store.js';
import { normalizeAccounts } from './accounts.js';
import { notifyUsageEvents } from './notify.js';
import { pollAndPersist, refreshCidr } from './pipeline.js';
import { refreshRulesStep } from './rulesfeed.js';
import { refreshBest, bestIspKeys } from './bestfeed.js';
import { syncUsers, MU_KEYS } from './users.js';

/** 每分钟一次的触发器只做多用户同步（在线汇总 + 下发），其它任务仍按 5 分钟那个触发器跑 */
export const MU_CRON = '* * * * *';
/** 轮询之后同一次调用里还要做的事（维护任务的外拉、TG）预留的子请求 */
const CRON_RESERVE = 8;

export const ISPS_FOR_CIDR = ['cf', 'ct', 'cu', 'cmcc'];
const TICK_MS = 5 * 60e3;

/**
 * 维护任务轮转表：tick 序号决定本次做哪一块。
 * 规则列表每 tick 刷 1 个，CIDR 每天每个运营商刷 1 次即可。
 */
export function maintenanceTask(now, settings) {
  const tick = Math.floor(now / TICK_MS);
  // 启用优选订阅时，每 4 个 tick 有 1 个用于刷新优选池（轮流刷新各运营商）
  const bestOn = !!settings?.preferred?.best?.enabled && settings.preferred.best.urls?.length > 0;
  const slots = bestOn ? ['rules', 'best', 'cidr', 'rules'] : ['rules', 'rules', 'cidr', 'rules'];
  const kind = slots[tick % slots.length];
  const cycle = Math.floor(tick / slots.length);
  if (kind === 'cidr') return { kind, isp: ISPS_FOR_CIDR[cycle % ISPS_FOR_CIDR.length] };
  if (kind === 'best') {
    const keys = bestIspKeys(settings);
    return { kind, isp: keys[cycle % keys.length] };
  }
  return { kind };
}

/**
 * @param {{event?: any, env: any, ctx?: any, now?: number, fetchFn?: typeof fetch, store?: any}} o
 */
export async function runScheduled({ event, env, now = Date.now(), fetchFn = globalThis.fetch, store: injected }) {
  const store = injected || createStore({ kv: env.KV, normalizeAccounts });
  const report = { usage: null, maintenance: null, logs: false, users: null, errors: [] };
  let settings;
  try { settings = await store.getSettings(); } catch (e) { report.errors.push('settings: ' + e.message); return report; }

  // 多用户：开着，或者刚关掉还没把"关闭"推下去（上次下发的状态还是开）
  let muAccounts = 0;
  let muNeeded = !!settings.users?.enabled;
  if (!muNeeded) { try { muNeeded = !!(await store.getJson(MU_KEYS.sync, 60e3))?.sig; } catch { /* 忽略 */ } }
  if (muNeeded) { try { muAccounts = Object.keys((await store.getJson(MU_KEYS.accounts, 60e3)) || {}).length; } catch { /* 忽略 */ } }
  const runUsers = async () => {
    if (!muNeeded) return;
    try {
      const [accounts, usage] = await Promise.all([store.getAccounts(), store.getUsage()]);
      report.users = await syncUsers({ store, settings, accounts, usage, fetchFn, now });
    } catch (e) { report.errors.push('users: ' + e.message); }
  };
  if (event?.cron === MU_CRON) { await runUsers(); return report; }

  // 1) 用量
  if (settings.usage.enabled) {
    try {
      const accounts = await store.getAccounts();
      if (accounts.length) {
        // 多用户同步每个账号最多 2 个子请求（AE 查询 + KV 写入）
        const reserve = CRON_RESERVE + (muNeeded ? 2 * Math.min(20, muAccounts) : 0);
        const r = await pollAndPersist({ store, settings, accounts, now, fetchFn, tickMinutes: TICK_MS / 60e3, reserve });
        report.usage = { polled: r.polled.length, ok: r.polled.filter((p) => p.ok).length, persisted: r.persisted };
        if (r.events.length) await notifyUsageEvents({ settings, events: r.events, accounts, fetchFn, now });
      }
    } catch (e) { report.errors.push('usage: ' + e.message); }
  }

  // 2) 维护（小块）
  const task = maintenanceTask(now, settings);
  try {
    if (task.kind === 'best') {
      report.maintenance = await refreshBest({ store, settings, isp: task.isp, fetchFn, now });
    } else if (task.kind === 'cidr') {
      report.maintenance = settings.preferred.random.enabled ? await refreshCidr({ store, isp: task.isp, settings, fetchFn }) : { skipped: 'random disabled' };
    } else {
      report.maintenance = await refreshRulesStep({ store, settings, fetchFn, now, maxLists: 1 });
    }
  } catch (e) { report.errors.push('maintenance: ' + e.message); }

  // 3) 多用户同步（没配每分钟触发器时，至少每 5 分钟一次）
  await runUsers();

  // 4) 日志落盘（缓冲在本 isolate；Cron 与请求可能不在同一 isolate，所以这里只是兜底）
  try { report.logs = await store.flushLogs({ flushMinutes: settings.log.flushMinutes, maxEntries: settings.log.maxEntries }); } catch { /* 忽略 */ }
  return report;
}
