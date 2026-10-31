// 配置自检：把"配置看起来有问题 / 可以更省额度"的情况列出来，显示在后台概览顶部。纯函数，无 I/O。
// level：warn = 很可能不符合预期；info = 提示。每条都说明原因，并尽量给出怎么改。

/**
 * @param {{settings:object, accounts:object[], usage:object|null, host:string, now:number, kvBound:boolean,
 *          rules?:{ini?:object|null}, cronSeen?:boolean}} o
 * @returns {{level:'warn'|'info', id:string, text:string}[]}
 */
/** Cloudflare 默认分配的子域名（大陆网络普遍干扰） */
export const isCfDefaultHost = (h) => /(^|\.)(pages|workers)\.dev$/i.test(String(h || '').trim());

export function selfCheck({ settings: s, accounts = [], usage, host = '', now, kvBound, rules, identity, loginPath = '' }) {
  const out = [];
  const add = (level, id, text) => out.push({ level, id, text });
  const node = accounts.filter((a) => a.role === 'node' && a.enabled !== false);
  const hasCred = (a) => !!(a.auth?.apiToken || a.auth?.hasToken || (a.auth?.email && (a.auth?.globalKey || a.auth?.hasKey)));
  const lower = (x) => String(x || '').toLowerCase();

  if (identity?.envUuidInvalid) add('warn', 'uuid-invalid', '环境变量 UUID 的格式不是标准 v4 UUID，已被忽略，主站改用「ADMIN + KEY」推导出的值。节点站点如果也填了自己的 UUID，会因此与主站不一致。请把环境变量 UUID 改成标准 v4 格式，或直接复制下面「节点站点（互联）」卡片里显示的 UUID 填到所有节点。');
  // LOGIN_PATH 与 KEY 相同：浏览器打开是登录页、代理客户端拿订阅（已兼容），但很容易把登录地址当订阅链接用，建议分开
  const hiddenLogin = String(loginPath || '').trim().replace(/^\/+|\/+$/g, '');
  if (hiddenLogin && identity?.hasCustomKey && hiddenLogin === identity.secretKey) add('warn', 'login-path-key', '环境变量 LOGIN_PATH 与 KEY 是同一个值：同一个地址既是登录页又是快速订阅。现在会按访问者区分（浏览器→登录页，代理客户端→订阅），但有的客户端 UA 像浏览器，会拿到登录页 HTML 而报 YAML 解析错误。请把两者设成不同的值。');
  if (!kvBound) add('warn', 'kv', '没有绑定 KV：设置、账号、用量都无法保存。请给主站绑定名为 KV 的 KV 命名空间。');

  // 分配池里是否混进了主站自己
  const poolHosts = new Set([...node.flatMap((a) => a.hosts || []), ...(s.hosts?.unmanaged || [])].map(lower));
  if (host && poolHosts.has(lower(host))) {
    add('warn', 'main-in-pool', `主站域名 ${host} 也在节点分配池里：会让主站（承担全部订阅请求、最缺额度的那个号）同时承载代理流量。如不需要，请从账号或"未纳入账号管理的节点域名"里删掉。`);
  }
  // Cloudflare 默认分配的 *.pages.dev / *.workers.dev 域名在中国大陆普遍被干扰（SNI 阻断、重置、限速），
  // 节点表现为"测速还行、实际用起来卡、慢、断"。上游 edgetunnel 一般只用主站的自定义域名，所以没有这个问题
  const freeSub = [...poolHosts].filter(isCfDefaultHost);
  if (freeSub.length) add('warn', 'cf-default-host', `${freeSub.length} 个节点域名是 Cloudflare 默认分配的 pages.dev / workers.dev 地址（${freeSub.slice(0, 3).join('、')}${freeSub.length > 3 ? ' 等' : ''}）：这类域名在中国大陆普遍被干扰，节点会卡、慢、容易断。请给这些节点绑定自定义域名（Pages 项目 → 自定义域；Workers → 设置 → 域和路由），再在账号里把域名换成自定义域名。`);
  if (!poolHosts.size) add('warn', 'no-hosts', '分配池里没有任何节点域名：订阅会回退到主站自己的域名。请在"账号"页添加节点域名。');

  // Workers Paid 与地区路由
  const pd = s.paid || {};
  const regionsOn = !!(s.preferred?.regions?.enabled && s.preferred.regions.urls?.length);
  const paidNode = node.filter((a) => a.paid && a.hosts?.length);
  const mainCarries = pd.main ? (pd.mainHosts?.length ? pd.mainHosts : [host].filter(Boolean)) : [];
  const paidHosts = [...new Set([...mainCarries, ...paidNode.flatMap((a) => a.hosts)])];
  if (regionsOn) {
    if (pd.regionOnly !== false && paidHosts.length) add('info', 'paid-region', `地区条目只分配给付费域名：${paidHosts.slice(0, 4).join('、')}${paidHosts.length > 4 ? ' 等' : ''}（Workers Paid 每个连接 CPU 上限 30 秒，链式连接不会再被掐断）。普通节点照常用免费账号分摊。`);
    else if (!paidHosts.length) add('info', 'region-free-cpu', '地区路由的链式连接在 Worker 里跑整套 VPN/TCP，CPU 开销大：免费版每个连接只有 10ms CPU，传 1~2MB 就会被掐断，客户端表现为"用着用着断"。主号开通 Workers Paid 后在「额度」页勾选"主号已开通 Workers Paid"，地区条目就会只走主站。');
    if (mainCarries.length && !pd.mainHosts?.length) add('info', 'paid-main-host', `地区条目会使用主站域名 ${host || '（当前访问域名）'}：如果主站同时绑定了多个域名（例如 workers.dev 和自定义域名），客户端里用的是生成订阅时访问的那个；需要固定可在「额度」页的 Workers Paid 设置里填"主站承载地区条目的域名"。`);
  }
  if (pd.main && kvBound === true && !regionsOn) add('info', 'paid-no-region', '已勾选"主号已开通 Workers Paid"，但没有启用地区路由：付费主要用来承载地区路由的链式连接，普通节点仍然走免费账号。');
  const paidNoCred = paidNode.filter((a) => !hasCred(a));
  if (paidNoCred.length) add('info', 'paid-no-cred', `${paidNoCred.length} 个付费账号没有填 API 凭据：用量未知，按固定权重分摊地区条目。填上 Token 后按剩余预算（每日 ${Math.round((pd.dailyBudget || 330000) / 1000)}k）分配。`);

  // 凭据被浏览器自动填成了后台密码（旧版后台的 Token 输入框会被密码管理器填充）：CF 收到的是后台密码，轮询报 400 / 9106
  const pw = identity?.adminPassword;
  const pwAsCred = pw ? accounts.filter((a) => a.auth?.apiToken === pw || a.auth?.globalKey === pw) : [];
  if (pwAsCred.length) add('warn', 'cred-is-admin-pw', `${pwAsCred.length} 个账号保存的 API Token / Global Key 与后台密码相同（${pwAsCred.slice(0, 3).map((a) => a.name || a.id).join('、')}${pwAsCred.length > 3 ? ' 等' : ''}）：多半是浏览器把后台密码自动填进了 Token 输入框，轮询会报 400（9106 Authentication failed），真正的 Token 从未被使用。请在账号页重新粘贴正确的 API Token 并保存。`);

  // 账号与用量
  const noCred = node.filter((a) => !hasCred(a));
  if (noCred.length) add('info', 'no-cred', `${noCred.length} 个节点账号没有填 API 凭据，额度未知，只能按固定权重参与分配（${noCred.slice(0, 3).map((a) => a.name || a.id).join('、')}${noCred.length > 3 ? ' 等' : ''}）。`);
  // 主号（主站所在账号）：没有凭据就看不到主站自己的用量（订阅、后台请求都算在它上面）
  const mainAcc = accounts.find((a) => a.role === 'main');
  if (!mainAcc || !hasCred(mainAcc)) add('info', 'main-quota', '还没填主号（主站所在的 Cloudflare 账号）的 API Token：看不到主站自己今天用了多少。到「额度 → 主号额度」填上即可。');
  const u = usage?.accounts || {};
  const failing = node.filter((a) => hasCred(a) && u[a.id] && u[a.id].ok === false);
  if (failing.length) add('warn', 'poll-fail', `${failing.length} 个账号最近一次轮询失败（${failing.slice(0, 3).map((a) => `${a.name || a.id}：${u[a.id].err || '未知错误'}`).join('；')}）。请检查 API Token 权限（需要 Account Analytics: Read）。`);
  const withCred = node.filter(hasCred).length;
  const age = usage?.ts ? (now - usage.ts) / 60000 : Infinity;
  if (s.usage?.enabled && withCred && age > Math.max(40, (s.usage.minWriteIntervalMinutes || 10) * 3)) {
    add('warn', 'usage-stale', `用量数据已 ${Number.isFinite(age) ? Math.round(age) + ' 分钟' : '很久'}没有更新：请确认主站设置了 Cron 触发器（*/5 * * * *）。主站用 Pages 部署时没有 Cron，只能靠订阅请求顺带刷新。`);
  }
  if (!s.usage?.enabled) add('info', 'usage-off', '用量轮询已关闭：不会按剩余额度分配。');
  if (s.allocation?.enabled === false) add('info', 'alloc-off', '按剩余额度分配已关闭：节点域名按随机打乱轮流使用。');

  // 额度大头
  if (s.preferred?.random?.enabled !== false && s.preferred?.random?.aggregate === false) add('info', 'agg-off', '"只显示一个随机优选"已关闭：随机优选的 CF 节点会在 🚀 节点选择 等手动选择列表里逐个列出。想只看到一个随机优选组，请到「优选 → 兜底节点」打开它。');
  // 测速间隔：下限太大时坏掉或变慢的 CF IP 要很久才被客户端换掉（表现为卡、慢）；关掉额度保护则额度吃紧时也不会放慢
  const tmin = Number(s.sub?.testIntervalMin) || 0;
  if (tmin >= 600) add('info', 'test-interval-slow', `测速间隔下限 ${tmin} 秒：所有测速组至少隔这么久才测一次，变慢或失效的节点要这么久才会被换掉，客户端表现为卡、慢。建议设为 0（按 INI，随机优选通常 300 秒），额度由"额度吃紧时自动放慢"保护。`);
  if (s.sub?.testIntervalAuto === false) add('info', 'test-interval-noguard', '"额度吃紧时自动放慢测速"已关闭：号池额度紧张时客户端仍按 INI 的间隔测速（每次 = 每个节点 1 次 Worker 请求）。');
  if ((s.sub?.updateHours ?? 1) < 1) add('info', 'update-hours', `客户端更新间隔只有 ${s.sub.updateHours} 小时：用户很多时，订阅请求会快速占满主站的每日 10 万次额度。`);

  // 功能配置
  if (s.preferred?.regions?.enabled) {
    if (!s.preferred.regions.urls?.length) add('warn', 'regions-empty', '地区路由已启用，但没有填节点列表 URL：不会生成任何地区条目。');
    else add('info', 'regions-nodes', '地区路由已启用：所有节点站点必须运行本项目的 _worker.js（原版 edgetunnel 不认识地区路由路径）。');
  }
  if (s.preferred?.best?.enabled && !s.preferred.best.urls?.length) add('warn', 'best-empty', '优选订阅已启用，但没有填优选 URL。');
  if (s.rules?.configUrl && !s.rules?.configText && !rules?.ini) add('info', 'ini-not-cached', '转换配置还没有"获取并保存"：订阅会先用内置规则，并在后台去拉取。建议到"订阅与规则"页点一次"获取并保存"。');
  const tg = s.notify?.telegram;
  if (tg?.enabled && (!tg.botToken || !tg.chatId)) add('warn', 'tg-incomplete', 'Telegram 通知已启用，但 Bot Token 或 Chat ID 没填完整。');

  const order = { warn: 0, info: 1 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
