// 设置的单一事实来源：默认值、合并、清洗、公开视图（脱敏）、从 edgetunnel 旧配置迁移。
// 全部为纯函数，不碰 KV/网络，便于单测。存储层见 store.js。
import { regexRisk } from '../lib/pool-parse.js';
import { parseDuration, DEFAULT_LADDER, RULES as AUTOBAN_RULES } from './autoban.js';

/** 自动封禁各规则的默认阈值（count 次 / 个，hours 小时内） */
const AUTOBAN_DEFAULTS = {
  overLimit: { enabled: true, count: 3, hours: 24 },
  conns: { enabled: false, count: 30000, hours: 24 },
  ips: { enabled: false, count: 10, hours: 24 },
  colos: { enabled: false, count: 4, hours: 6 },
  subFetch: { enabled: false, count: 100, hours: 24 },
  subIps: { enabled: false, count: 6, hours: 24 },
};

export const SCHEMA_VERSION = 5;

/** 数据面默认的"强制走 SOCKS5"域名名单（与上游一致） */
export const DEFAULT_SOCKS5_WHITELIST = ['*tapecontent.net', '*cloudatacdn.com', '*loadshare.org', '*cdn-centaurus.com', 'scholar.google.com'];

/** 订阅转换 INI 默认地址（用户自己的 subconfig2.ini） */
export const DEFAULT_RULES_CONFIG_URL = 'https://raw.githubusercontent.com/yyyyy114514/edgetunnel-misc/main/subconfig2.ini';

/** @returns {Settings} */
export function defaultSettings() {
  return {
    schema: SCHEMA_VERSION,
    site: { name: 'nicetunnel' },
    node: {
      protocol: 'vless', // vless | trojan | ss
      transport: 'ws', // ws | grpc | xhttp   （ws 每连接计 1 次请求，最省额度）
      grpcMode: 'gun', // gun | multi
      grpcUserAgent: '',
      path: '/',
      randomPath: false,
      alpn: '', // '' 表示客户端自动协商
      fingerprint: 'chrome',
      skipCertVerify: false,
      zeroRtt: false, // 路径追加 ?ed=2560
      tlsFragment: null, // null | 'Shadowrocket' | 'Happ'
      ech: { enabled: false, dns: 'https://dns.alidns.com/dns-query', sni: 'cloudflare-ech.com' },
      ss: { method: 'aes-128-gcm', tls: true },
    },
    // 未纳入账号管理的"裸" host（兼容 edgetunnel 的 HOSTS）：额度未知，按固定权重参与分配
    hosts: { unmanaged: [], unmanagedWeight: 1 },
    proxy: {
      mode: 'proxyip', // proxyip | socks5 | http | https | turn | sstp
      proxyip: 'auto',
      chain: { account: '', global: false },
      socks5Whitelist: DEFAULT_SOCKS5_WHITELIST.slice(),
    },
    sub: {
      updateHours: 1, // Profile-Update-Interval
      emoji: false,
      udp: false,
      xudp: false,
      tls13: false,
      appendType: false,
      sort: false,
      userinfo: true, // 在 Subscription-Userinfo 里展示整个号池的额度
      rateLimitPerMinute: 10, // 同一 IP 每分钟最多拉取订阅次数（isolate 内近似限速），0=不限
      announcement: '', // 公告：Clash / sing-box / Surge 订阅里多一个以此为名的分组（排最前，只含直连，不影响使用）；留空不显示
      // 客户端测速（url-test / fallback / load-balance）默认完全按 INI 里每个组写的间隔（例如随机优选 300 秒、故障转移 180 秒）。
      // 以前默认把所有组拉到至少 600 秒、最长 1800 秒：坏掉或变慢的 CF IP 要 10~30 分钟才被换掉，表现为"卡、慢"。
      // testIntervalMin：所有组的间隔下限（秒），0 = 不设下限
      testIntervalMin: 0,
      // 额度吃紧时自动放慢：号池余量低于平均节奏时，各组间隔从 INI 值逐步拉长，最长到 testIntervalCeil；余量正常时不改动
      testIntervalAuto: true,
      testIntervalFloor: 180, // 旧版字段，已不使用（保留以兼容旧配置）
      testIntervalCeil: 1800,
      // url-test 组的默认容差（毫秒）：INI 没写时使用。与常用 INI 一致取 50；太大会让客户端一直停在变慢的节点上
      tolerance: 50,
    },
    preferred: {
      // 优质：自定义/汇聚订阅（地址行、URL、sub:// 嵌套；备注里可带 $sstp://… 等链式代理）
      custom: { enabled: true, text: '', maxNodes: 0, refreshSeconds: 300 },
      // 优选订阅：多个优选 URL / 优选订阅生成器（返回 IP 列表、CSV 测速结果或节点订阅），与优质、随机三者可同时开启。
      // URL 里的 {isp} 会按访问者运营商替换为 ct/cu/cmcc/cf（运营商自适应）
      best: { enabled: false, urls: [], maxPerUrl: 20, maxNodes: 40, refreshSeconds: 600, namePrefix: '优选' },
      // 地区路由（可选，默认关闭）：适用于"节点寿命很短、列表高频变化"的来源（如 VPN Gate）。
      // 订阅里只放"地区"条目（日本、韩国…），客户端不选具体节点；真实节点由节点站点在每条连接建立时从列表里解析。
      // 订阅因此只在"地区集合"变化时才需要更新，条目更少也让客户端测速更省额度。
      // 列表格式：每行 入口地址#名称$sstp://用户:密码@主机:端口（也支持 socks5/http/https/turn；没有入口地址的行由随机优选池补入口）
      // ⚠ 开启后所有节点站点必须运行本项目的 _worker.js（原版 edgetunnel 不认识地区路由路径）。
      regions: { enabled: false, urls: [], regex: '', kinds: [], nameTemplate: '【{kind}】{region}', kindNames: ['住宅=家宽'], pickK: 10, stickyMinutes: 30, ttlSeconds: 180, refreshSeconds: 1800 },
      // 家宽（客户端链式，可选）：Clash 专属订阅（&target=home）里加 VPN Gate 住宅宽带的 OpenVPN 节点，由客户端（mihomo）
      // 经本项目的 CF 节点连过去（dialer-proxy）。Worker 只做普通转发，免费版也不会被掐断。见 control/homefeed.js
      home: { enabled: false, maxNodes: 40, excludeOfficial: true, sourceUrl: '', refreshMinutes: 60 },
      // 兜底：随机优选 CF IP
      random: {
        enabled: true,
        count: 16,
        ports: [443, 2053, 2083, 2087, 2096, 8443],
        isp: 'auto', // auto | ct | cu | cmcc | cf
        cidrBase: '', // 空=内置默认来源
        stable: { enabled: true, rotatePercent: 25, windowMinutes: 60 },
        // 只显示一个随机优选：CF 随机/优选 IP 节点只出现在测速组（INI 里匹配 CF 的 url-test 组）里，
        // 不在 🚀 节点选择 等手动选择列表里逐个列出。仅对 Clash / Surge / sing-box 生效（通用订阅没有分组）
        aggregate: true,
        goodRatio: 0.5, // 有优选订阅数据时，随机节点里取自"已知可用地址"的比例
        portBias: 0.5, // 随机端口倾向 443 的概率
        blacklist: [],
        namePrefix: 'CF',
      },
    },
    allocation: {
      enabled: true,
      alpha: 1, // 权重 = 剩余额度^alpha
      maxShare: 0.25, // 单个 host 最多占用的节点比例，保证多样性
      // 节奏感知：按"当前消耗速度到 UTC 0 点会不会用完"调权——会剩额度的号加权、会提前耗尽的号降权，
      // 目标是所有号在重置前同时用到接近预算（每个号都用上，不死薅少数号）
      pace: true,
      paceMax: 4,
      seedMode: 'ip', // ip | token | none
      windowMinutes: 30,
    },
    usage: {
      enabled: true,
      limitPerAccount: 100000,
      safetyMargin: 0.08,
      floorRemaining: 1500,
      horizonMinutes: 20,
      batchSize: 15, // 每次轮询的最少账号数（实际按 cycleMinutes 自动放大）
      cycleMinutes: 15, // 每个账号至少每隔多少分钟轮询一次
      staleMinutes: 60,
      lazyRefresh: true, // 没有 Cron（例如主站是 Pages）时由订阅请求触发后台刷新
      minWriteIntervalMinutes: 10,
    },
    rules: {
      configUrl: DEFAULT_RULES_CONFIG_URL,
      configText: '', // 非空则优先于 URL
      iniAutoRefresh: true, // false=只在后台点"获取并保存"时才更新转换配置，Cron 不再自动拉取
      mode: 'expand', // expand | provider
      providerMirror: '',
      refreshHours: 24,
    },
    notify: {
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        events: { adminLogin: true, configSave: true, subFetch: false, lowQuota: true, accountError: true },
        minIntervalSeconds: 60,
      },
    },
    log: { enabled: true, subFetch: false, maxEntries: 300, flushMinutes: 5 },
    camouflage: { url: 'nginx' }, // nginx | 1101 | https://example.com
    advanced: { debug: false, tcpConcurrentDial: 2, proxyConcurrentDial: 1, preloadRaceDial: false },
    // Workers Paid（付费版）：每请求 CPU 上限 30 秒（免费版 10ms）。地区路由的链式连接要在 Worker 里跑整套 VPN/TCP，
    // 免费版传 1~2MB 就会被掐断；把地区条目只分给付费账号的域名（含主站自己）即可解决，普通节点照常用免费号分摊
    paid: {
      main: false, // 主号已开通 Workers Paid
      regionOnly: true, // 有付费域名时，地区条目只分配给付费域名
      mainHosts: [], // 主站承载地区条目的域名；留空 = 订阅请求所用的主站域名
      dailyBudget: 330000, // 付费账号的每日预算（10M/月 ÷ 30），用于分配权重；账号自己填了每日额度时以账号为准
    },
    // 多用户专属链接（见 control/users.js）：开启后后台多一个「用户」页
    users: {
      enabled: false, defaultLimit: 2, banMessage: '此链接已停用，请联系管理员',
      // 填写标识才开订阅：开启期间生成的用户，要先在浏览器打开链接填写标识，订阅才可用（之前 / 关闭后生成的不受影响）
      requireLabel: false, needLabelMessage: '未添加标识信息，浏览器打开订阅链接填写信息后即可使用订阅',
      // 自动封禁（可选）：任一条开启的规则触发就按阶梯封禁；统计周期过了违规次数清零（见 control/autoban.js）
      autoBan: { enabled: false, checkMinutes: 10, resetHours: 168, ladder: DEFAULT_LADDER.slice(), ...JSON.parse(JSON.stringify(AUTOBAN_DEFAULTS)) },
    },
    ui: { simpleMode: false },
    // 节点防护（gate / 仅多用户 / 紧急锁定）：推送到各节点账号 KV 的 nt.mu.state 扩展字段
    security: { gate: '', rejectSharedUuid: false, lockdown: false },
  };
}

// ---------------------------------------------------------------------------
// 合并与清洗
// ---------------------------------------------------------------------------
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深度合并：对象递归合并，数组与基础值整体替换；只接受 base 中已存在的键（未知键丢弃，防止脏数据膨胀） */
export function deepMerge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch === undefined ? base : patch;
  const out = {};
  for (const k of Object.keys(base)) {
    if (!(k in patch) || patch[k] === undefined) out[k] = clone(base[k]);
    else if (isPlain(base[k]) && isPlain(patch[k])) out[k] = deepMerge(base[k], patch[k]);
    else out[k] = clone(patch[k]);
  }
  return out;
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const int = (v, def, min, max) => Math.round(num(v, def, min, max));
const str = (v, def = '') => (typeof v === 'string' ? v.trim() : def);
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const strList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、;；]+/)).map((s) => String(s).trim()).filter(Boolean);
export const normalizeHost = (h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

/** 把任意输入清洗成合法的 Settings（缺省补默认，越界收敛，枚举回退） */
export function normalizeSettings(raw) {
  const d = defaultSettings();
  const s = deepMerge(d, isPlain(raw) ? raw : {});
  // 旧版本把"当时的默认值"整份存进了 KV，之后改的默认值不会自动生效。schema 2 → 3：测速间隔下限的旧默认 0 升级为 600
  // （只在读到旧 schema 且值正好是旧默认 0 时升级；之后用户再保存并设为 0 会被尊重，因为保存后 schema 已是 3）
  if (isPlain(raw) && Number.isInteger(raw.schema) && raw.schema < 3 && raw.sub && raw.sub.testIntervalMin === 0) s.sub.testIntervalMin = 600;
  // schema 4 → 5：测速间隔改为默认按 INI（旧默认下限 600 → 0）、默认容差 100 → 50。只迁移恰好等于旧默认的值
  if (isPlain(raw) && Number.isInteger(raw.schema) && raw.schema < 5 && isPlain(raw.sub)) {
    if (raw.sub.testIntervalMin === 600 || (raw.schema < 3 && raw.sub.testIntervalMin === 0)) s.sub.testIntervalMin = 0;
    if (raw.sub.tolerance === 100) s.sub.tolerance = 50;
  }
  // schema 3 → 4：地区路由旧默认候选 5 / 粘性 10 分钟 / 列表 TTL 90 秒升级为 10 / 30 / 180。
  // 只迁移恰好等于旧默认的值；用户显式保存过的新 schema 配置不受影响。
  if (isPlain(raw) && Number.isInteger(raw.schema) && raw.schema < 4 && isPlain(raw.preferred?.regions)) {
    const old = raw.preferred.regions;
    if (old.pickK === 5) s.preferred.regions.pickK = 10;
    if (old.stickyMinutes === 10) s.preferred.regions.stickyMinutes = 30;
    if (old.ttlSeconds === 90) s.preferred.regions.ttlSeconds = 180;
  }
  s.schema = SCHEMA_VERSION;
  s.site.name = str(s.site.name, d.site.name) || d.site.name;
  // edgetunnel 的订阅名默认值就是 "edgetunnel"：从它迁移过来、且没改过名字的，一律显示为本项目名
  // （后台品牌、页面标题、订阅文件名、Telegram 通知都用这个名字；自己起过别的名字则保持不变）
  if (/^edgetunnel$/i.test(s.site.name.trim())) s.site.name = d.site.name;

  const n = s.node;
  n.protocol = oneOf(n.protocol, ['vless', 'trojan', 'ss'], d.node.protocol);
  n.transport = oneOf(n.transport, ['ws', 'grpc', 'xhttp'], d.node.transport);
  n.grpcMode = oneOf(n.grpcMode, ['gun', 'multi'], d.node.grpcMode);
  n.grpcUserAgent = str(n.grpcUserAgent);
  n.path = '/' + str(n.path, '/').replace(/^\/+/, '');
  n.randomPath = bool(n.randomPath, false);
  n.alpn = str(n.alpn);
  n.fingerprint = str(n.fingerprint, 'chrome') || 'chrome';
  n.skipCertVerify = bool(n.skipCertVerify, false);
  n.zeroRtt = bool(n.zeroRtt, false);
  n.tlsFragment = oneOf(n.tlsFragment, ['Shadowrocket', 'Happ'], null);
  n.ech.enabled = bool(n.ech.enabled, false);
  n.ech.dns = str(n.ech.dns, d.node.ech.dns) || d.node.ech.dns;
  n.ech.sni = str(n.ech.sni, d.node.ech.sni);
  n.ss.method = str(n.ss.method, d.node.ss.method) || d.node.ss.method;
  n.ss.tls = bool(n.ss.tls, true);

  s.hosts.unmanaged = [...new Set(strList(s.hosts.unmanaged).map(normalizeHost).filter(Boolean))];
  s.hosts.unmanagedWeight = num(s.hosts.unmanagedWeight, 1, 0, 1000);

  const p = s.proxy;
  p.mode = oneOf(p.mode, ['proxyip', 'socks5', 'http', 'https', 'turn', 'sstp'], 'proxyip');
  p.proxyip = str(p.proxyip, 'auto') || 'auto';
  p.chain.account = str(p.chain.account);
  p.chain.global = bool(p.chain.global, false);
  p.socks5Whitelist = strList(p.socks5Whitelist);

  const u = s.sub;
  u.updateHours = num(u.updateHours, 1, 0.05, 168);
  for (const k of ['emoji', 'udp', 'xudp', 'tls13', 'appendType', 'sort', 'userinfo']) u[k] = bool(u[k], d.sub[k]);
  u.rateLimitPerMinute = int(u.rateLimitPerMinute, 10, 0, 1000);
  u.announcement = String(u.announcement ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  u.testIntervalMin = int(u.testIntervalMin, 0, 0, 86400);
  u.testIntervalAuto = bool(u.testIntervalAuto, true);
  u.testIntervalFloor = int(u.testIntervalFloor, 180, 60, 86400);
  u.testIntervalCeil = int(u.testIntervalCeil, 1800, 60, 86400);
  u.tolerance = int(u.tolerance, 50, 0, 5000);

  const c = s.preferred.custom;
  c.enabled = bool(c.enabled, true);
  c.text = typeof c.text === 'string' ? c.text : '';
  c.maxNodes = int(c.maxNodes, 0, 0, 5000);
  c.refreshSeconds = int(c.refreshSeconds, 300, 30, 86400);
  const b = s.preferred.best;
  b.enabled = bool(b.enabled, false);
  b.urls = [...new Set(strList(b.urls).filter((x) => /^(https?|sub):\/\//i.test(x)))];
  b.maxPerUrl = int(b.maxPerUrl, 20, 1, 500);
  b.maxNodes = int(b.maxNodes, 40, 1, 500);
  b.refreshSeconds = int(b.refreshSeconds, 600, 60, 86400);
  b.namePrefix = str(b.namePrefix, '优选') || '优选';
  const g = s.preferred.regions;
  g.enabled = bool(g.enabled, false);
  g.urls = [...new Set(strList(g.urls).filter((x) => /^https?:\/\//i.test(x)))];
  g.regex = str(g.regex);
  if (g.regex) { try { new RegExp(g.regex, 'u'); if (regexRisk(g.regex)) g.regex = ''; } catch { g.regex = ''; } }
  g.kinds = [...new Set(strList(g.kinds))];
  g.nameTemplate = str(g.nameTemplate, '【{kind}】{region}');
  if (!g.nameTemplate.includes('{region}')) g.nameTemplate = '【{kind}】{region}';
  g.kindNames = strList(g.kindNames).filter((x) => x.includes('='));
  g.pickK = int(g.pickK, 10, 1, 100);
  g.stickyMinutes = int(g.stickyMinutes, 30, 0, 1440); // 0=每条连接随机挑
  g.ttlSeconds = int(g.ttlSeconds, 180, 15, 3600);
  g.refreshSeconds = int(g.refreshSeconds, 1800, 60, 86400);
  const hm = s.preferred.home;
  hm.enabled = bool(hm.enabled, false);
  hm.maxNodes = int(hm.maxNodes, 40, 1, 200);
  hm.excludeOfficial = bool(hm.excludeOfficial, true);
  hm.sourceUrl = /^https:\/\//i.test(str(hm.sourceUrl)) ? str(hm.sourceUrl) : '';
  hm.refreshMinutes = int(hm.refreshMinutes, 60, 15, 1440);
  const r = s.preferred.random;
  r.enabled = bool(r.enabled, true);
  r.count = int(r.count, 16, 0, 200);
  r.ports = [...new Set(strList(r.ports).map(Number).filter((x) => Number.isInteger(x) && x > 0 && x < 65536))];
  if (!r.ports.length) r.ports = d.preferred.random.ports.slice();
  r.isp = oneOf(r.isp, ['auto', 'ct', 'cu', 'cmcc', 'cf'], 'auto');
  r.cidrBase = str(r.cidrBase);
  r.stable.enabled = bool(r.stable.enabled, true);
  r.stable.rotatePercent = int(r.stable.rotatePercent, 25, 0, 100);
  r.stable.windowMinutes = int(r.stable.windowMinutes, 60, 1, 10080);
  r.blacklist = strList(r.blacklist);
  r.aggregate = bool(r.aggregate, true);
  r.goodRatio = num(r.goodRatio, 0.5, 0, 1);
  r.portBias = num(r.portBias, 0.5, 0, 0.95);
  r.namePrefix = str(r.namePrefix, 'CF') || 'CF';

  const a = s.allocation;
  a.enabled = bool(a.enabled, true);
  a.alpha = num(a.alpha, 1, 0, 4);
  a.maxShare = num(a.maxShare, 0.25, 0.02, 1);
  a.pace = bool(a.pace, true);
  a.paceMax = num(a.paceMax, 4, 1, 20);
  a.seedMode = oneOf(a.seedMode, ['ip', 'token', 'none'], 'ip');
  a.windowMinutes = int(a.windowMinutes, 30, 1, 10080);

  const q = s.usage;
  q.enabled = bool(q.enabled, true);
  q.limitPerAccount = int(q.limitPerAccount, 100000, 1000, 100000000);
  q.safetyMargin = num(q.safetyMargin, 0.08, 0, 0.9);
  q.floorRemaining = int(q.floorRemaining, 1500, 0, q.limitPerAccount);
  q.horizonMinutes = int(q.horizonMinutes, 20, 0, 1440);
  q.batchSize = int(q.batchSize, 15, 1, 45); // Free 版单次调用外部子请求上限 50
  q.cycleMinutes = int(q.cycleMinutes, 15, 5, 1440);
  q.staleMinutes = int(q.staleMinutes, 60, 5, 1440);
  q.lazyRefresh = bool(q.lazyRefresh, true);
  q.minWriteIntervalMinutes = int(q.minWriteIntervalMinutes, 10, 1, 1440);

  const l = s.rules;
  l.configUrl = str(l.configUrl);
  l.configText = typeof l.configText === 'string' ? l.configText : '';
  l.iniAutoRefresh = bool(l.iniAutoRefresh, true);
  l.mode = oneOf(l.mode, ['expand', 'provider'], 'expand');
  l.providerMirror = str(l.providerMirror);
  l.refreshHours = int(l.refreshHours, 24, 1, 720);

  const t = s.notify.telegram;
  t.enabled = bool(t.enabled, false);
  t.botToken = str(t.botToken);
  t.chatId = str(t.chatId);
  t.minIntervalSeconds = int(t.minIntervalSeconds, 60, 0, 86400);
  for (const k of Object.keys(d.notify.telegram.events)) t.events[k] = bool(t.events[k], d.notify.telegram.events[k]);

  s.log.enabled = bool(s.log.enabled, true);
  s.log.subFetch = bool(s.log.subFetch, false);
  s.log.maxEntries = int(s.log.maxEntries, 300, 10, 2000);
  s.log.flushMinutes = int(s.log.flushMinutes, 5, 1, 1440);

  s.camouflage.url = str(s.camouflage.url, 'nginx') || 'nginx';

  const v = s.advanced;
  v.debug = bool(v.debug, false);
  v.tcpConcurrentDial = int(v.tcpConcurrentDial, 2, 1, 8);
  v.proxyConcurrentDial = int(v.proxyConcurrentDial, 1, 1, 8);
  v.preloadRaceDial = bool(v.preloadRaceDial, false);

  const pd = s.paid;
  pd.main = bool(pd.main, false);
  pd.regionOnly = bool(pd.regionOnly, true);
  pd.mainHosts = [...new Set(strList(pd.mainHosts).map(normalizeHost).filter(Boolean))];
  pd.dailyBudget = num(pd.dailyBudget, 330000, 1000, 1e8);

  const us = s.users;
  us.enabled = bool(us.enabled, false);
  us.defaultLimit = int(us.defaultLimit, 2, 0, 50); // 0 = 不限
  // 被封禁用户拉订阅时看到的提示（占位节点的名字 / 浏览器提示页的标题）
  us.banMessage = String(us.banMessage ?? '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 60) || '此链接已停用，请联系管理员';
  us.requireLabel = bool(us.requireLabel, false);
  // 没填标识的用户拉订阅时看到的提示（占位节点的名字 / 浏览器页面的说明）
  us.needLabelMessage = String(us.needLabelMessage ?? '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 60) || '未添加标识信息，浏览器打开订阅链接填写信息后即可使用订阅';
  const ab = us.autoBan;
  ab.enabled = bool(ab.enabled, false);
  // 检查间隔取 5 的倍数（Cron 每 1 或 5 分钟触发一次，按"分钟数能整除"判断该不该检查）
  ab.checkMinutes = Math.max(5, Math.round(int(ab.checkMinutes, 10, 5, 1440) / 5) * 5);
  ab.resetHours = int(ab.resetHours, 168, 1, 8760);
  ab.ladder = strList(ab.ladder).filter((x) => parseDuration(x) !== null).slice(0, 10);
  if (!ab.ladder.length) ab.ladder = DEFAULT_LADDER.slice();
  for (const k of Object.keys(AUTOBAN_RULES)) {
    const r = ab[k] && typeof ab[k] === 'object' ? ab[k] : (ab[k] = {});
    const def = AUTOBAN_DEFAULTS[k];
    r.enabled = bool(r.enabled, def.enabled);
    r.count = int(r.count, def.count, 1, 1e9);
    r.hours = int(r.hours, def.hours, 1, 720);
  }

  s.ui.simpleMode = bool(s.ui.simpleMode, false);

  // 防护设置：gate（仅含字母数字，限 32 字符）、rejectSharedUuid、lockdown
  const sec = s.security;
  sec.gate = String(sec.gate ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  sec.rejectSharedUuid = bool(sec.rejectSharedUuid, false);
  sec.lockdown = bool(sec.lockdown, false);

  return s;
}

/** 合并补丁并清洗；补丁里为空串的敏感字段（botToken）表示"保持不变" */
export function applyPatch(current, patch) {
  const cur = normalizeSettings(current);
  const p = clone(isPlain(patch) ? patch : {});
  if (p.notify?.telegram && p.notify.telegram.botToken === '') delete p.notify.telegram.botToken;
  return normalizeSettings(deepMerge(cur, p));
}

/** 返回给前端的公开视图：敏感字段脱敏（保留长度提示，不泄露内容） */
export function publicSettings(settings) {
  const s = clone(normalizeSettings(settings));
  const tok = s.notify.telegram.botToken;
  s.notify.telegram.botToken = tok ? mask(tok) : '';
  return s;
}
export function mask(text, head = 3, tail = 2) {
  const t = String(text || '');
  if (t.length <= head + tail) return '*'.repeat(t.length);
  return t.slice(0, head) + '*'.repeat(Math.min(12, t.length - head - tail)) + t.slice(-tail);
}

// ---------------------------------------------------------------------------
// 从 edgetunnel 旧配置迁移（KV 里的 config.json / tg.json / cf.json / ADD.txt）
// ---------------------------------------------------------------------------
/**
 * @param {object} legacy edgetunnel 的 config.json 解析结果（中文键）
 * @param {{tg?:object, addTxt?:string}} [extras]
 * @returns {Settings}
 */
export function importLegacyEdt(legacy, extras = {}) {
  const L = isPlain(legacy) ? legacy : {};
  const g = (obj, ...keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const patch = {
    site: { name: g(L, '优选订阅生成', 'SUBNAME') },
    node: {
      protocol: L['协议类型'],
      transport: L['传输协议'],
      grpcMode: L['gRPC模式'],
      grpcUserAgent: L['gRPCUserAgent'],
      path: L['PATH'],
      randomPath: L['随机路径'],
      alpn: L['ALPN'],
      fingerprint: L['Fingerprint'],
      skipCertVerify: L['跳过证书验证'],
      zeroRtt: L['启用0RTT'],
      tlsFragment: L['TLS分片'] ?? null,
      ech: { enabled: L['ECH'], dns: g(L, 'ECHConfig', 'DNS'), sni: g(L, 'ECHConfig', 'SNI') },
      ss: { method: g(L, 'SS', '加密方式'), tls: g(L, 'SS', 'TLS') },
    },
    hosts: { unmanaged: Array.isArray(L['HOSTS']) ? L['HOSTS'] : [] },
    proxy: {
      mode: String(g(L, '反代', 'SOCKS5', '启用') || 'proxyip').toLowerCase(),
      proxyip: g(L, '反代', 'PROXYIP'),
      chain: { account: g(L, '反代', 'SOCKS5', '账号'), global: g(L, '反代', 'SOCKS5', '全局') },
      socks5Whitelist: g(L, '反代', 'SOCKS5', '白名单'),
    },
    sub: {
      updateHours: g(L, '优选订阅生成', 'SUBUpdateTime'),
      emoji: g(L, '订阅转换配置', 'SUBEMOJI'),
      udp: g(L, '订阅转换配置', 'UDP'),
      xudp: g(L, '订阅转换配置', 'XUDP'),
      tls13: g(L, '订阅转换配置', 'TLS13'),
      appendType: g(L, '订阅转换配置', 'APPEND_TYPE'),
      sort: g(L, '订阅转换配置', 'SORT'),
    },
    preferred: {
      custom: { text: extras.addTxt && extras.addTxt !== 'null' ? extras.addTxt : (g(L, '优选订阅生成', 'SUB') || '') },
      random: {
        count: g(L, '优选订阅生成', '本地IP库', '随机数量'),
        ports: (() => { const p = g(L, '优选订阅生成', '本地IP库', '指定端口'); return Number(p) > 0 ? [Number(p)] : undefined; })(),
      },
    },
    rules: {
      configUrl: g(L, '订阅转换配置', 'SUBCONFIG'),
      mode: g(L, '订阅转换配置', 'EXPAND') === false ? 'provider' : 'expand',
    },
    notify: { telegram: { enabled: g(L, 'TG', '启用'), botToken: extras.tg?.BotToken, chatId: extras.tg?.ChatID } },
  };
  // 清掉 undefined，避免覆盖默认值
  const strip = (o) => {
    if (Array.isArray(o) || !isPlain(o)) return o;
    for (const k of Object.keys(o)) { if (o[k] === undefined) delete o[k]; else o[k] = strip(o[k]); }
    return o;
  };
  const s = normalizeSettings(strip(patch));
  // 旧版"随机IP=false"表示只用 ADD.txt；新版允许自定义(优质)与随机(兜底)并存，迁移后随机兜底保持默认开启
  return s;
}

/**
 * @typedef {ReturnType<typeof defaultSettings>} Settings
 */
