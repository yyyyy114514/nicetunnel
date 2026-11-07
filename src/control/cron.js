// Cron（主站，建议 */5）：每次触发 = 一批账号用量轮询 + 一小块维护任务（轮转）。
// 免费版 Cron 单次 CPU 10ms：所有任务都按"小块"设计；网络等待不计 CPU。
import { createStore } from './store.js';
import { normalizeAccounts } from './accounts.js';
import { notifyUsageEvents } from './notify.js';
import { pollAndPersist, refreshCidr } from './pipeline.js';
import { refreshRulesStep } from './rulesfeed.js';
import { refreshBest, bestIspKeys } from './bestfeed.js';
import { syncUsers, runAutoBan, MU_KEYS } from './users.js';
import { refreshHome, HOME_KEY } from './homefeed.js';
import { subrequestBudget } from './usage.js';
import { ruleWindows } from './autoban.js';

/**
 * 给这次调用的 fetch 计数：超出预算时直接报错（只是这一个请求失败），
 * 不让 Cloudflare 抛 Too many subrequests——那样后面的下发也会全部失败。
 */
export function countingFetch(fetchFn, limit) {
  const f = (...args) => {
    if (f.n >= limit) return Promise.reject(new Error(`本次 Cron 子请求预算（${limit}）已用完`));
    f.n++;
    return fetchFn(...args);
  };
  f.n = 0;
  f.left = () => Math.max(0, limit - f.n);
  return f;
}
/** 每分钟触发器在用的标记：最多每小时写一次 KV；5 分钟那个触发器看到 2 小时内的标记，就把多用户的事都交给它 */
const MINUTE_MARK_MS = 3600e3, MINUTE_SEEN_MS = 2 * 3600e3;
/** 自动封禁这次要查的大概子请求数：每个窗口查全部账号 + 主站每个窗口 1 次 */
export function autoBanCost(settings, accounts) {
  const ab = settings?.users?.autoBan;
  if (!ab?.enabled) return 0;
  return ruleWindows(ab, 'node').length * accounts + ruleWindows(ab, 'main').length;
}

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
export async function runScheduled({ event, env, now = Date.now(), fetchFn: rawFetch = globalThis.fetch, store: injected }) {
  const store = injected || createStore({ kv: env.KV, normalizeAccounts });
  const report = { usage: null, maintenance: null, logs: false, users: null, errors: [] };
  let settings;
  try { settings = await store.getSettings(); } catch (e) { report.errors.push('settings: ' + e.message); return report; }
  // 这次调用的所有外部请求都经过计数（免费版每次 50 个，留 5 个余量）
  const fetchFn = countingFetch(rawFetch, subrequestBudget(settings));

  // 多用户：开着，或者刚关掉还没把"关闭"推下去（上次下发的状态还是开）
  let muAccounts = 0;
  let muNeeded = !!settings.users?.enabled;
  if (!muNeeded) { try { muNeeded = !!(await store.getJson(MU_KEYS.sync, 60e3))?.sig; } catch { /* 忽略 */ } }
  if (muNeeded) { try { muAccounts = Object.keys((await store.getJson(MU_KEYS.accounts, 60e3)) || {}).length; } catch { /* 忽略 */ } }
  const T = Math.min(20, muAccounts); // 同步：每个账号 1 次在线查询 + 1 次下发
  const ab = settings.users?.autoBan;
  // 自动封禁：每 checkMinutes 分钟检查一次（分钟数能整除时）
  const abDue = !!(settings.users?.enabled && ab?.enabled && Math.floor(now / 60e3) % (ab.checkMinutes || 10) === 0);
  const runUsers = async () => {
    if (!muNeeded) return;
    try {
      const [accounts, usage] = await Promise.all([store.getAccounts(), store.getUsage()]);
      // 先封禁、再同步一次：封禁结果随这次同步下发，不再多同步一轮。
      // 子请求按剩余的算：先给下发留够（每个账号 1 个），剩下的给自动封禁；在线查询放在最后，够才查（不够就沿用上次的超限结果）
      if (abDue) report.autoBan = await runAutoBan({ store, settings, accounts, usage, fetchFn, now, mainAe: !!env?.NT_AE, budget: fetchFn.left() - T - 2 });
      report.users = await syncUsers({ store, settings, accounts, usage, fetchFn, now, query: fetchFn.left() >= 2 * T + 2 });
    } catch (e) { report.errors.push('users: ' + e.message); }
  };
  if (event?.cron === MU_CRON) {
    // 记下"每分钟触发器在用"：5 分钟那次就不再做多用户的事，子请求全留给用量轮询
    try { const t = await store.getJson(MU_KEYS.minuteTick, 600e3); if (!t || now - Number(t) >= MINUTE_MARK_MS) await store.putJson(MU_KEYS.minuteTick, now, 600e3); } catch { /* 忽略 */ }
    await runUsers();
    report.subrequests = fetchFn.n;
    return report;
  }
  let minuteOn = false;
  try { const t = await store.getJson(MU_KEYS.minuteTick, 300e3); minuteOn = !!t && now - Number(t) < MINUTE_SEEN_MS; } catch { /* 忽略 */ }

  // 1) 用量
  if (settings.usage.enabled) {
    try {
      const accounts = await store.getAccounts();
      if (accounts.length) {
        // 给后面的多用户任务留子请求（每分钟触发器在用时，那些事归它做，这里不留）：
        // 同步每个账号 2 个（在线查询 + 下发）；轮到自动封禁检查时改成 下发 + 封禁检查（最多留一半，放不下的窗口轮流查），
        // 不轮到的时候不留——之前一直按最坏情况留，账号一多用量轮询只剩 2 个名额
        const budget = subrequestBudget(settings);
        const muReserve = !muNeeded || minuteOn ? 0 : abDue ? T + 2 + Math.min(autoBanCost(settings, T), Math.floor(budget / 2)) : 2 * T + 2;
        const reserve = CRON_RESERVE + muReserve;
        const r = await pollAndPersist({ store, settings, accounts, now, fetchFn, tickMinutes: TICK_MS / 60e3, reserve });
        report.usage = { polled: r.polled.length, ok: r.polled.filter((p) => p.ok).length, persisted: r.persisted };
        if (r.events.length) await notifyUsageEvents({ settings, events: r.events, accounts, fetchFn, now });
      }
    } catch (e) { report.errors.push('usage: ' + e.message); }
  }

  // 2) 维护（小块）
  let task = maintenanceTask(now, settings);
  // 家宽列表到了刷新时间（默认每小时）：这一轮只做它（解析 1.3MB 列表要几毫秒 CPU，不和别的维护任务挤在一起）
  if (settings.preferred?.home?.enabled) {
    try {
      const h = await store.getJson(HOME_KEY, 60e3);
      if (!h || now - (h.fetchedAt || 0) >= (settings.preferred.home.refreshMinutes || 60) * 60e3) task = { kind: 'home' };
    } catch { /* 忽略 */ }
  }
  try {
    if (task.kind === 'home') {
      report.maintenance = await refreshHome({ store, settings, fetchFn, now });
    } else if (task.kind === 'best') {
      report.maintenance = await refreshBest({ store, settings, isp: task.isp, fetchFn, now });
    } else if (task.kind === 'cidr') {
      report.maintenance = settings.preferred.random.enabled ? await refreshCidr({ store, isp: task.isp, settings, fetchFn }) : { skipped: 'random disabled' };
    } else {
      report.maintenance = await refreshRulesStep({ store, settings, fetchFn, now, maxLists: 1 });
    }
  } catch (e) { report.errors.push('maintenance: ' + e.message); }

  // 3) 多用户同步（没配每分钟触发器时，至少每 5 分钟一次；配了就交给它）
  if (!minuteOn) await runUsers();
  report.subrequests = fetchFn.n;

  // 4) 日志落盘（缓冲在本 isolate；Cron 与请求可能不在同一 isolate，所以这里只是兜底）
  try { report.logs = await store.flushLogs({ flushMinutes: settings.log.flushMinutes, maxEntries: settings.log.maxEntries }); } catch { /* 忽略 */ }
  return report;
}
