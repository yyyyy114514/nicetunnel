// 多用户：封禁时长与自动封禁。
//
// 封禁记在用户记录上：banned + bannedUntil（毫秒，0 = 永久）。到期后自动失效（同步时可用名单变化会立即下发），
// 不需要再写一次用户名单。
//
// 自动封禁（可选，默认关闭）：在主站 Cron 里每隔几分钟检查一次，任一条开启的规则触发就封禁，时长按阶梯处罚：
// 统计周期内第 1 次违规封 30 秒、第 2 次 5 分钟……（后台可改），统计周期（默认 168 小时）过了违规次数清零。
// 数据来源都不增加 Worker 请求：
//   - 节点账号的 Analytics Engine（节点在线上报时写的：用户、IP 标记、机房、连接数）——查询额度用的是各节点账号的；
//   - 主站自己的 Analytics Engine（可选，主站绑定 NT_AE 后每次拉专属订阅写一条）——用于订阅相关的规则；
//   - 超限记录：同步下发超限名单时顺手记下，存在主站已有的同步记录里。
// 封禁开始后，这个用户的统计只算封禁之后的数据，旧数据不会让他一解封就再被封。

/** 时长写法：30s / 5m / 24h / 3d；"永久" / 0 = 永久。返回秒（0 = 永久），写错返回 null */
export function parseDuration(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (t === '0' || t === '永久' || t === 'forever' || t === 'permanent') return 0;
  const m = /^(\d{1,7})\s*(s|m|h|d)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 0 ? null : n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

/** 秒 → "30 秒" / "5 分钟" / "3 小时" / "2 天"；0 → "永久" */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '永久';
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.round(s / 60) + ' 分钟';
  if (s < 86400 * 2) return Math.round(s / 3600) + ' 小时';
  return Math.round(s / 86400) + ' 天';
}

export const DEFAULT_LADDER = ['30s', '5m', '24h', '72h', '永久'];

/** 封禁是否还在生效 */
export const banActive = (u, now = Date.now()) => !!u?.banned && (!u.bannedUntil || now < u.bannedUntil);

/** 北京时间 "11-02 15:30" */
const cnTime = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');

/** 封禁提示（带时长），用于提示节点的名字和浏览器提示页 */
export function banNotice(message, user, now = Date.now()) {
  const msg = String(message || '此链接已停用，请联系管理员');
  if (!user?.bannedUntil) return `${msg}（永久）`;
  return `${msg}（${cnTime(user.bannedUntil)} 解封，剩余约 ${formatDuration((user.bannedUntil - now) / 1000)}）`;
}

/** 规则：key → 中文名、数据来源、统计的量 */
export const RULES = {
  overLimit: { label: '超过并行上限', source: 'over', unit: '次' },
  conns: { label: '连接数', source: 'node', unit: '次' },
  ips: { label: '使用的不同 IP 数', source: 'node', unit: '个' },
  colos: { label: '连到的不同机房数', source: 'node', unit: '个' },
  subFetch: { label: '订阅更新次数', source: 'main', unit: '次' },
  subIps: { label: '拉订阅的不同 IP 数', source: 'main', unit: '个' },
};

/** 每个开启的规则的统计窗口（小时）去重——同样窗口的规则共用一次查询 */
export function ruleWindows(cfg, source) {
  const hs = new Set();
  for (const [k, r] of Object.entries(RULES)) if (r.source === source && cfg?.[k]?.enabled) hs.add(cfg[k].hours);
  return [...hs];
}

/** 这个用户的统计从什么时候开始算：窗口起点和"上次封禁 / 解封"取较晚的 */
export const cutoffOf = (u, windowStart) => Math.max(windowStart, Number(u.banAt) || 0, Number(u.unbanAt) || 0);

/** AE 查询：节点数据（按用户 / IP 标记 / 机房聚合）。since：秒；only：只查这个用户 */
export const nodeAggSql = (dataset, since, only = '') => `SELECT blob1 AS u, blob2 AS t, blob3 AS k, sum(_sample_interval * double1) AS c FROM ${dataset} WHERE toUnixTimestamp(timestamp) > ${Math.floor(since)} AND blob5 != 'sub'${only ? ` AND blob1 = '${only}'` : ''} GROUP BY u, t, k LIMIT 20000`;
/** AE 查询：主站订阅数据（按用户 / IP 标记聚合） */
export const subAggSql = (dataset, since, only = '') => `SELECT blob1 AS u, blob2 AS t, sum(_sample_interval * double1) AS c FROM ${dataset} WHERE toUnixTimestamp(timestamp) > ${Math.floor(since)} AND blob5 = 'sub'${only ? ` AND blob1 = '${only}'` : ''} GROUP BY u, t LIMIT 20000`;

/** 把查询结果合并成 用户 → {conns, ips:Set, colos:Set}（多个账号的结果可以多次喂进来） */
export function aggregateRows(map, rows) {
  for (const r of rows || []) {
    const u = String(r.u || '');
    if (!/^[a-z0-9]{8}$/.test(u)) continue;
    let a = map.get(u);
    if (!a) { a = { count: 0, ips: new Set(), colos: new Set() }; map.set(u, a); }
    a.count += Number(r.c) || 0;
    if (r.t) a.ips.add(String(r.t));
    if (r.k) a.colos.add(String(r.k));
  }
  return map;
}

/**
 * 判断哪些用户触发了规则。
 * @param {{users:object[], cfg:object, node:Map<number,Map>, main:Map<number,Map>, overHits:Record<string,number[]>, now:number}} o
 *   node / main：窗口小时数 → 聚合结果（aggregateRows 的输出）
 * @returns {{id:string, rule:string, value:number, limit:number, hours:number}[]}
 */
export function evaluateRules({ users, cfg, node = new Map(), main = new Map(), overHits = {}, now }) {
  const hits = [];
  for (const u of users) {
    if (banActive(u, now)) continue;
    for (const [key, def] of Object.entries(RULES)) {
      const r = cfg?.[key];
      if (!r?.enabled) continue;
      const since = cutoffOf(u, now - r.hours * 3600e3);
      let value = 0;
      if (def.source === 'over') value = (overHits[u.id] || []).filter((t) => t > since).length;
      else {
        const agg = (def.source === 'node' ? node : main).get(r.hours)?.get(u.id);
        if (!agg) continue;
        value = key === 'ips' || key === 'subIps' ? agg.ips.size : key === 'colos' ? agg.colos.size : Math.round(agg.count);
      }
      if (value >= r.count) { hits.push({ id: u.id, rule: key, value, limit: r.count, hours: r.hours }); break; }
    }
  }
  return hits;
}

/**
 * 封禁一个用户（手动或自动）。auto 时按阶梯算时长并累计违规次数；统计周期过了从 1 重新算。
 * @returns {object} 新的用户记录
 */
export function banUser(u, { now, auto = false, seconds = 0, reason = '', cfg = {} }) {
  const v = { ...u, banned: true, banAuto: auto, banAt: now, banReason: String(reason || (auto ? '自动封禁' : '手动封禁')).slice(0, 80) };
  if (auto) {
    const resetMs = (cfg.resetHours || 168) * 3600e3;
    const fresh = !u.vioSince || now - u.vioSince >= resetMs;
    v.vio = (fresh ? 0 : Number(u.vio) || 0) + 1;
    v.vioSince = fresh ? now : u.vioSince;
    const ladder = (cfg.ladder?.length ? cfg.ladder : DEFAULT_LADDER).map(parseDuration).filter((x) => x !== null);
    const sec = ladder.length ? ladder[Math.min(v.vio, ladder.length) - 1] : 0;
    v.bannedUntil = sec ? now + sec * 1000 : 0;
  } else {
    v.bannedUntil = seconds > 0 ? now + seconds * 1000 : 0;
  }
  return v;
}

/** 解封（手动）：记下解封时间，规则只算之后的数据；resetVio=true 时违规次数清零 */
export function unbanUser(u, { now, resetVio = false }) {
  const v = { ...u, banned: false, bannedUntil: 0, banAuto: false, banReason: '', unbanAt: now };
  if (resetVio) { v.vio = 0; v.vioSince = 0; }
  return v;
}

/** 规则触发的说明文字："24 小时内连接数 52310 ≥ 50000" */
export const hitReason = (h) => `${h.hours} 小时内${RULES[h.rule]?.label || h.rule} ${h.value} ≥ ${h.limit}`;
