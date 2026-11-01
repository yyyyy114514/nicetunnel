// 节点自报统计：只在 isolate 内存里计数，不读写 KV、不外拉、不额外消耗请求额度。
// 后台"检测节点"带正确 UUID 请求 /version?stats=1 时随版本信息一起返回，用来定位"哪个节点为什么断 / 连不上"。
// 每个 isolate 各自一份（检测请求落到哪个 isolate 就看到哪个），属于有意的折衷：零成本、够用来看趋势与最近错误。
const RECENT_MAX = 12;
// 注意：Workers 在全局作用域（脚本加载时）Date.now() 返回 0，所以起始时间不能在加载时取，要等第一次计数/查询时再记
let s = fresh();

function fresh() {
  return { since: 0, ws: 0, post: 0, guardBlocked: 0, authFail: 0, regionErr: 0, chainOk: 0, chainFail: 0, noSocket: 0, portBlocked: 0, muOk: 0, muDeny: 0, fails: 0, recent: [] };
}

export function resetStats() { s = fresh(); }

/** 计数 +1（未知键忽略） */
const touch = (now = Date.now()) => { if (!s.since && now > 0) s.since = now; };
export function bump(key) { touch(); if (typeof s[key] === 'number' && key !== 'since') s[key]++; }

/** 记录一条失败（计数 + 最近错误环形缓冲；消息截断，避免占内存） */
export function recordFail(msg, now = Date.now()) {
  touch(now);
  s.fails++;
  s.recent.push({ t: now, m: String(msg || '').slice(0, 160) });
  if (s.recent.length > RECENT_MAX) s.recent.shift();
}

/** 对外快照（/version?stats=1） */
export function snapshotStats(now = Date.now()) {
  touch(now);
  return { ...s, upMin: Math.round((now - s.since) / 60000), recent: s.recent.map((r) => ({ ago: Math.round((now - r.t) / 1000), m: r.m })) };
}
