// Telegram 通知。请求方式与消息格式对齐上游 cmliu/edgetunnel 请求日志记录()（_worker.js 5341–5370 行）：
//   GET https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>&parse_mode=HTML&text=<msg>
// 新增：按事件类型限频（minIntervalSeconds）、同一 dedupeKey 去重、超时、异常吞掉、错误信息脱敏（不含 token）。

export const TG_API = 'https://api.telegram.org';
/** 同一 dedupeKey 的最短重复间隔下限（秒）；参考上游日志 30 分钟去重 */
export const DEDUPE_MIN_SECONDS = 1800;

/** 上游日志类型 → 通知事件开关名（settings.notify.telegram.events 的键） */
export const TYPE_TO_EVENT = {
  Get_SUB: 'subFetch',
  Get_Best_SUB: 'subFetch',
  Admin_Login: 'adminLogin',
  Save_Config: 'configSave',
  Save_Custom_IPs: 'configSave',
  Init_Config: 'configSave',
  lowQuota: 'lowQuota',
  accountError: 'accountError',
  // usage.js collectEvents 实际产出的类型（之前表里没有，额度/账号告警一条都发不出去）
  low: 'lowQuota',
  exhausted: 'lowQuota',
  authFailed: 'accountError',
  pollFailing: 'accountError',
  recovered: 'accountError',
};

const ALERT_TITLES = { low: '额度偏低', exhausted: '额度耗尽', authFailed: 'Token 失效', pollFailing: '用量查询连续失败', recovered: '账号恢复', lowQuota: '额度告警', accountError: '账号异常' };

/** 新建通知状态（isolate 内存） */
export const createNotifyState = () => ({ lastByEvent: new Map(), lastByKey: new Map() });
/** isolate 级默认状态 */
export const defaultNotifyState = createNotifyState();

/** HTML 转义（parse_mode=HTML 下防止 UA 等字段里的 < > & 让整条消息发送失败） */
export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 把文本里的 bot token / 订阅 token / UUID 脱敏 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '***')
    .replace(/([?&](?:token|uuid|password|key)=)[^&#\s]*/gi, '$1***')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => m.slice(0, 4) + '****');
}

const tgConf = (settings) => settings?.notify?.telegram || {};

/** TG 是否已配置可用 */
export const telegramConfigured = (settings) => {
  const t = tgConf(settings);
  return !!(t.enabled && t.botToken && t.chatId);
};

/**
 * 发送 Telegram 消息（永不抛异常）。
 * @param {{settings:object, text:string, fetchFn?:typeof fetch, now?:number, state?:ReturnType<typeof createNotifyState>,
 *          event?:string, dedupeKey?:string, force?:boolean, ua?:string, timeoutMs?:number}} o
 *   event：事件开关名（adminLogin/configSave/subFetch/lowQuota/accountError）；给出且该开关关闭时不发送。
 *   force：测试消息用，跳过启用开关/事件开关/限频/去重（仍需 token 与 chatId）。
 * @returns {Promise<{sent:boolean, reason?:'disabled'|'not_configured'|'event_off'|'rate'|'dup'|'error', error?:string}>}
 */
export async function sendTelegram({ settings, text, fetchFn = globalThis.fetch, now = Date.now(), state = defaultNotifyState, event, dedupeKey, force = false, ua, timeoutMs = 5000 }) {
  const t = tgConf(settings);
  if (!t.botToken || !t.chatId) return { sent: false, reason: 'not_configured' };
  if (!force) {
    if (!t.enabled) return { sent: false, reason: 'disabled' };
    if (event && t.events && t.events[event] === false) return { sent: false, reason: 'event_off' };
    const minMs = Math.max(0, Number(t.minIntervalSeconds) || 0) * 1000;
    const evKey = event || 'misc';
    const lastEv = state.lastByEvent.get(evKey);
    if (minMs && lastEv !== undefined && now - lastEv < minMs) return { sent: false, reason: 'rate' };
    if (dedupeKey) {
      const lastKey = state.lastByKey.get(dedupeKey);
      if (lastKey !== undefined && now - lastKey < Math.max(minMs, DEDUPE_MIN_SECONDS * 1000)) return { sent: false, reason: 'dup' };
    }
    // 先占位再发送：并发请求里只有一个真正发出
    state.lastByEvent.set(evKey, now);
    if (dedupeKey) {
      state.lastByKey.set(dedupeKey, now);
      if (state.lastByKey.size > 500) state.lastByKey.delete(state.lastByKey.keys().next().value);
    }
  }
  // text 可以是函数：通过所有限频/开关检查之后才真正生成消息（格式化时间等较贵，订阅热路径上不应白做）
  const body = typeof text === 'function' ? text() : text;
  const url = `${TG_API}/bot${t.botToken}/sendMessage?chat_id=${encodeURIComponent(t.chatId)}&parse_mode=HTML&text=${encodeURIComponent(String(body ?? ''))}`;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: ac?.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;', 'User-Agent': ua || 'Unknown' },
    });
    if (!res.ok) {
      let desc = '';
      try { desc = (await res.json())?.description || ''; } catch { /* 忽略 */ }
      return { sent: false, reason: 'error', error: redactSecrets(`HTTP ${res.status}${desc ? ' ' + desc : ''}`).slice(0, 200) };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: 'error', error: redactSecrets(e?.name === 'AbortError' ? '请求超时' : e?.message || String(e)).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 北京时间格式化（与上游 toLocaleString('zh-CN', Asia/Shanghai) 一致；运行时缺 ICU 时退化为 ISO） */
export function formatTime(ms) {
  try { return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); } catch { return new Date(ms).toISOString(); }
}

/**
 * 请求类日志通知（格式与上游逐行一致，字段值做 HTML 转义与脱敏）。
 * @param {{siteName:string, type:string, ip:string, cc:string, asn:string, url:string, ua:string, time:number,
 *          usage?:{used:number, total:number}|null}} o  usage：号池已用/总预算（上游为单号 CF.Usage）
 */
export function formatRequestMessage({ siteName, type, ip, cc, asn, url, ua, time, usage }) {
  let host = '', pathQs = '';
  try { const u = new URL(url); host = u.host; pathQs = u.pathname + u.search; } catch { pathQs = String(url || ''); }
  const usageLine = usage && usage.total > 0
    ? `📊 <b>请求用量：</b>${usage.used}/${usage.total} <b>${((usage.used / usage.total) * 100).toFixed(2)}%</b>\n`
    : '';
  return `<b>#${escapeHtml(siteName)} 日志通知</b>\n\n` +
    `📌 <b>类型：</b>#${escapeHtml(type)}\n` +
    `🌐 <b>IP：</b><code>${escapeHtml(ip)}</code>\n` +
    `📍 <b>位置：</b>${escapeHtml(cc)}\n` +
    `🏢 <b>ASN：</b>${escapeHtml(asn)}\n` +
    `🔗 <b>域名：</b><code>${escapeHtml(host)}</code>\n` +
    `🔍 <b>路径：</b><code>${escapeHtml(redactSecrets(pathQs))}</code>\n` +
    `🤖 <b>UA：</b><code>${escapeHtml(ua)}</code>\n` +
    `📅 <b>时间：</b>${formatTime(time)}\n` +
    usageLine;
}

/**
 * 额度/账号告警消息（usage.pollBatch 产出的 events）。
 * @param {{siteName:string, event:{type:string, accountId?:string, [k:string]:any}, accountName?:string, time:number}} o
 */
export function formatAlertMessage({ siteName, event, accountName, time }) {
  const title = ALERT_TITLES[event.type] || '系统通知';
  const lines = [`<b>#${escapeHtml(siteName)} ${title}</b>`, ''];
  lines.push(`📌 <b>类型：</b>#${escapeHtml(event.type)}`);
  if (event.accountId) lines.push(`👤 <b>账号：</b>${escapeHtml(accountName || event.accountId)}`);
  for (const [k, v] of Object.entries(event)) {
    if (k === 'type' || k === 'accountId' || v === undefined || v === null || typeof v === 'object') continue;
    lines.push(`• <b>${escapeHtml(k)}：</b>${escapeHtml(redactSecrets(String(v)).slice(0, 200))}`);
  }
  lines.push(`📅 <b>时间：</b>${formatTime(time)}`);
  return lines.join('\n');
}

/**
 * 发送一批额度/账号事件：同类事件合并成一条消息（避免被按类型限频吞掉），同一天同一组账号去重。
 * @param {{settings:object, events:object[], accounts?:object[], fetchFn?:typeof fetch, now?:number, state?:object}} o
 * @returns {Promise<{sent:number, skipped:number}>}
 */
export async function notifyUsageEvents({ settings, events = [], accounts = [], fetchFn, now = Date.now(), state = defaultNotifyState }) {
  let sent = 0, skipped = 0;
  const names = new Map(accounts.map((a) => [a.id, a.name || a.id]));
  const groups = new Map();
  for (const ev of events) {
    if (!ev || !TYPE_TO_EVENT[ev.type] || TYPE_TO_EVENT[ev.type] === 'subFetch') { skipped++; continue; }
    // 按通知开关（lowQuota / accountError）分组：同一开关的多种类型合并成一条，避免互相被限频吞掉
    const key = TYPE_TO_EVENT[ev.type];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const siteName = settings?.site?.name || 'nicetunnel';
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [eventKey, evs] of groups) {
    const text = evs.map((ev) => formatAlertMessage({ siteName, event: ev, accountName: names.get(ev.accountId), time: now })).join('\n\n');
    const ids = evs.map((e) => e.type + ':' + (e.accountId || '')).sort().join(',');
    const r = await sendTelegram({ settings, fetchFn, now, state, event: eventKey, dedupeKey: `${eventKey}|${ids}|${day}`, text: text.slice(0, 3800) });
    if (r.sent) sent += evs.length; else skipped += evs.length;
  }
  return { sent, skipped };
}
