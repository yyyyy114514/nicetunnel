// 后台 JSON API（docs/API.md §2）。只依赖注入的 deps，不直接 import 账号/用量/分配/订阅模块，便于并行开发与单测。
//
//   const api = createAdminApi(deps);
//   const res = await api.handleAdminRequest(appCtx);   // 非本模块负责的路径返回 null
//
// deps = {store?, accounts:{normalizeAccounts, publicAccounts, parseAccountsText, importUsagePanelConfig, mergeAccounts},
//         usage:{pollBatch, emptySnapshot}, allocator:{buildHostPool, poolSummary}, buildSubscription,
//         sources:{loadCustomEntries}, pool:{parseCidrList, cidrSourceUrl}, rules:{refreshRuleset, getStatus?},
//         checkProxy?, fetchFn?, version, state?}
import { normalizeSettings, applyPatch, publicSettings, defaultSettings, mask, normalizeHost } from '../control/settings.js';
import { requireAuth, checkCsrf, jsonResponse, errorResponse, identityOf, clientIp, requestUa } from '../control/auth.js';
import { filterLogs, trackRequest } from '../control/logs.js';
import { selfCheck } from '../control/selfcheck.js';
import { DATAPLANE_VERSION, CAPS } from '../dataplane/contract.js';
import { buildLabel } from '../build-info.js';
import { KEYS } from '../control/store.js';
import { HOST_CHECK_TTL_MS } from '../control/allocator.js';
import { sendTelegram, notifyUsageEvents, telegramConfigured, formatTime, escapeHtml, defaultNotifyState, redactSecrets } from '../control/notify.js';
import { createUsersRoutes } from './users-api.js';
import { qrSvg } from '../lib/qr.js';
import { refreshHome, loadHome } from '../control/homefeed.js';

const MAX_BODY = 2 * 1024 * 1024;
const PREVIEW_BODY_LIMIT = 20 * 1024;
const POLL_MIN_MS = 60e3;
const RULES_MIN_MS = 60e3;

// ---------------------------------------------------------------------------
// 设置补丁校验（normalizeSettings 只会"收敛"，这里把收敛前的非法值报告给前端）
// ---------------------------------------------------------------------------

/** 枚举字段及其可选值 */
const ENUMS = {
  'node.protocol': ['vless', 'trojan', 'ss'],
  'node.transport': ['ws', 'grpc', 'xhttp'],
  'node.grpcMode': ['gun', 'multi'],
  'node.tlsFragment': [null, 'Shadowrocket', 'Happ'],
  'proxy.mode': ['proxyip', 'socks5', 'http', 'https', 'turn', 'sstp'],
  'preferred.random.isp': ['auto', 'ct', 'cu', 'cmcc', 'cf'],
  'allocation.seedMode': ['ip', 'token', 'none'],
  'rules.mode': ['expand', 'provider'],
};
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * 校验设置补丁。未知键忽略（与 deepMerge 一致）。
 * @param {object} patch
 * @param {object} current 当前设置
 * @returns {Record<string,string>} 字段路径 → 中文错误；空对象表示通过
 */
export function validateSettingsPatch(patch, current) {
  const fields = {};
  if (!isPlain(patch)) return { '': '必须是对象' };
  const defaults = defaultSettings();
  let merged;
  try { merged = applyPatch(current, patch); } catch { return { '': '无法解析' }; }

  const walk = (p, d, prefix) => {
    for (const k of Object.keys(p)) {
      if (!(k in d)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      const v = p[k], dv = d[k];
      if (v === undefined) continue;
      if (path in ENUMS) {
        if (!ENUMS[path].includes(v)) fields[path] = `取值无效，可选：${ENUMS[path].map(String).join(' / ')}`;
      } else if (isPlain(dv)) {
        if (!isPlain(v)) fields[path] = '必须是对象';
        else walk(v, dv, path);
      } else if (typeof dv === 'boolean') {
        if (typeof v !== 'boolean') fields[path] = '必须是布尔值';
      } else if (typeof dv === 'number') {
        const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
        if (typeof v === 'boolean' || !Number.isFinite(n)) fields[path] = '必须是数字';
        else {
          const got = getPath(merged, path);
          if (Math.abs(got - n) > 1e-9 && Math.round(n) !== got) fields[path] = `超出允许范围（最接近的合法值为 ${got}）`;
        }
      } else if (Array.isArray(dv)) {
        if (!Array.isArray(v) && typeof v !== 'string') fields[path] = '必须是列表';
        else if (path === 'preferred.random.ports') {
          const list = Array.isArray(v) ? v : String(v).split(/[\s,，、;；]+/).filter(Boolean);
          if (list.some((x) => !(Number.isInteger(Number(x)) && Number(x) > 0 && Number(x) < 65536))) fields[path] = '端口必须是 1~65535 的整数';
        }
      } else if (typeof dv === 'string') {
        if (typeof v !== 'string') fields[path] = '必须是字符串';
      }
    }
  };
  walk(patch, defaults, '');
  const cam = patch?.camouflage?.url;
  if (typeof cam === 'string' && cam.trim() && !/^(nginx|1101|https?:\/\/\S+)$/i.test(cam.trim())) fields['camouflage.url'] = '只能是 nginx、1101 或 http(s):// 网址';
  return fields;
}

/** UI 回传的脱敏 botToken（含 *）等同于"保持不变" */
function stripMaskedSecrets(patch, current) {
  const t = patch?.notify?.telegram;
  if (t && typeof t.botToken === 'string' && t.botToken.includes('*')) {
    const cur = current?.notify?.telegram?.botToken || '';
    if (!cur || t.botToken === mask(cur)) t.botToken = '';
  }
  return patch;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 读取 JSON 请求体（限 2MB）。失败返回 {error: Response} */
async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return { error: errorResponse(413, 'too_large', '请求体过大') };
  let text = '';
  try { text = await request.text(); } catch { return { error: errorResponse(400, 'bad_body', '无法读取请求体') }; }
  if (text.length > MAX_BODY) return { error: errorResponse(413, 'too_large', '请求体过大') };
  if (!text.trim()) return { body: {} };
  try {
    const body = JSON.parse(text);
    if (!isPlain(body)) return { error: errorResponse(400, 'bad_json', '请求体必须是 JSON 对象') };
    return { body };
  } catch { return { error: errorResponse(400, 'bad_json', '请求体不是合法 JSON') }; }
}

const waitUntil = (ctx, p) => {
  const safe = Promise.resolve(p).catch(() => {});
  if (ctx.executionCtx?.waitUntil) ctx.executionCtx.waitUntil(safe);
  return safe;
};

/** 节点摘要（预览用） */
const nodeView = (n) => {
  const o = { name: n.name, origin: n.origin, address: n.address, port: n.port, host: n.host };
  if (n.chain) o.chain = n.chain;
  return o;
};

/** 自定义来源条目 → 上游风格的地址行 `addr:port#备注` */
export function entryToLine(e) {
  if (typeof e === 'string') return e;
  if (!e || typeof e !== 'object') return String(e);
  if (e.link) return e.link;
  const addr = e.address && e.address.includes(':') && !e.address.startsWith('[') ? `[${e.address}]` : e.address;
  const remark = e.remark ?? e.name ?? '';
  return `${addr ?? ''}${e.port ? ':' + e.port : ''}${remark ? '#' + remark : ''}`;
}

// ---------------------------------------------------------------------------
// 旧版 edgetunnel config.json 视图（只读，迁移期保留）
// ---------------------------------------------------------------------------
export function legacyConfigView(settings, identity = {}) {
  const s = normalizeSettings(settings);
  return {
    UUID: identity.uuid || '',
    HOST: identity.host ? [identity.host, ...s.hosts.unmanaged] : s.hosts.unmanaged,
    HOSTS: s.hosts.unmanaged,
    协议类型: s.node.protocol,
    传输协议: s.node.transport,
    gRPC模式: s.node.grpcMode,
    PATH: s.node.path,
    随机路径: s.node.randomPath,
    跳过证书验证: s.node.skipCertVerify,
    启用0RTT: s.node.zeroRtt,
    TLS分片: s.node.tlsFragment,
    ECH: s.node.ech.enabled,
    ECHConfig: { DNS: s.node.ech.dns, SNI: s.node.ech.sni },
    Fingerprint: s.node.fingerprint,
    ALPN: s.node.alpn,
    反代: {
      PROXYIP: s.proxy.proxyip,
      SOCKS5: { 启用: s.proxy.mode === 'proxyip' ? null : s.proxy.mode, 全局: s.proxy.chain.global, 账号: s.proxy.chain.account ? mask(s.proxy.chain.account) : '', 白名单: s.proxy.socks5Whitelist },
    },
    优选订阅生成: { SUBNAME: s.site.name, SUBUpdateTime: s.sub.updateHours, 本地IP库: { 随机IP: s.preferred.random.enabled, 随机数量: s.preferred.random.count, 指定端口: s.preferred.random.ports[0] ?? -1 } },
    订阅转换配置: { SUBCONFIG: s.rules.configUrl, SUBEMOJI: s.sub.emoji, UDP: s.sub.udp, XUDP: s.sub.xudp, TLS13: s.sub.tls13, APPEND_TYPE: s.sub.appendType, SORT: s.sub.sort, EXPAND: s.rules.mode === 'expand' },
    TG: { 启用: s.notify.telegram.enabled, ChatID: s.notify.telegram.chatId || null, BotToken: s.notify.telegram.botToken ? mask(s.notify.telegram.botToken) : null },
    meta: { schema: s.schema, note: '只读视图；请在新后台修改设置' },
  };
}

// ---------------------------------------------------------------------------
// createAdminApi
// ---------------------------------------------------------------------------

/**
 * @param {object} deps 见文件头
 */
export function createAdminApi(deps = {}) {
  // isolate 内限频状态（可注入便于测试）
  const st = deps.state || { lastPollAt: -Infinity, lastRulesAt: -Infinity };
  const notifyState = deps.notifyState || defaultNotifyState;

  /** 准备请求级公共对象 */
  async function prep(ctx) {
    const store = ctx.store || deps.store;
    const now = ctx.now ?? Date.now();
    const fetchFn = ctx.fetchFn || deps.fetchFn || globalThis.fetch;
    const settings = ctx.settings ? normalizeSettings(ctx.settings) : normalizeSettings(await store.getSettings());
    const identity = identityOf(ctx);
    return { store, now, fetchFn, settings, identity, env: ctx.env || {} };
  }

  async function loadUsage(store, now) {
    const u = await store.getUsage();
    if (u && typeof u === 'object') return u;
    return deps.usage?.emptySnapshot ? deps.usage.emptySnapshot(now) : { v: 1, ts: 0, day: new Date(now).toISOString().slice(0, 10), cursor: 0, accounts: {} };
  }

  /** 号池视图：summary + hosts(含 sharePct) */
  function poolView(settings, accounts, snapshot, now) {
    const al = deps.allocator;
    if (!al?.buildHostPool) return { summary: null, hosts: [] };
    const pool = al.buildHostPool({ settings, accounts, snapshot, now }) || [];
    const total = pool.reduce((s, h) => s + Math.max(0, h.weight || 0), 0);
    const hosts = pool.map((h) => ({
      host: h.host, accountId: h.accountId, used: h.used, budget: h.budget, remaining: h.remaining, weight: h.weight, state: h.state, rate: h.rate ?? 0, pace: h.pace ?? null,
      sharePct: total > 0 ? Math.round((Math.max(0, h.weight || 0) / total) * 10000) / 100 : 0,
    }));
    return { summary: al.poolSummary ? al.poolSummary(pool, settings, now) : null, hosts };
  }

  const pubAccounts = (a) => (deps.accounts?.publicAccounts ? deps.accounts.publicAccounts(a) : a);
  const track = (ctx, c, type, msg) => waitUntil(ctx, trackRequest({ ...ctx, store: c.store, settings: c.settings, now: c.now, fetchFn: c.fetchFn, notifyState }, { type, msg }));

  // ---------------- 各接口 ----------------

  /**
   * POST /admin/api/hosts/checks —— 后台"检测节点"在浏览器里跑完后把结果交给主站（一次请求、一次 KV 写）。
   * body: { results: [{ host, state: ok|old|edt|cors|bad|down, caps?: string[] }] }
   * 分配时：bad/down 不再分配；Caps 没有 pool-route@1（或 edt 原版）的不承载地区条目。结果 3 天后失效。
   */
  async function saveHostChecks(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const list = Array.isArray(body?.results) ? body.results.slice(0, 2000) : null;
    if (!list) return errorResponse(400, 'bad_request', '缺少 results 数组');
    const STATES = new Set(['ok', 'old', 'edt', 'cors', 'bad', 'down']);
    const prev = (await c.store.getJson(KEYS.hostChecks, 0).catch(() => null)) || {};
    const hosts = {};
    for (const [h, v] of Object.entries(prev.hosts || {})) if (c.now - (Number(v?.at) || 0) < HOST_CHECK_TTL_MS) hosts[h] = v;
    for (const r of list) {
      const host = normalizeHost(r?.host || '');
      if (!host || !STATES.has(r?.state)) continue;
      const caps = Array.isArray(r.caps) ? r.caps.filter((x) => typeof x === 'string').slice(0, 32) : undefined;
      hosts[host] = { s: r.state, at: c.now, ...(caps ? { caps } : {}) };
    }
    await c.store.putJson(KEYS.hostChecks, { at: c.now, hosts }, 300e3);
    const excluded = Object.keys(hosts).filter((h) => ['bad', 'down'].includes(hosts[h].s));
    const noRegion = Object.keys(hosts).filter((h) => !excluded.includes(h) && (hosts[h].s === 'edt' || (hosts[h].caps && !hosts[h].caps.includes('pool-route@1'))));
    return jsonResponse({ ok: true, saved: Object.keys(hosts).length, excluded, noRegion });
  }

  async function getState(ctx, c) {
    const [accounts, usage] = await Promise.all([c.store.getAccounts(), loadUsage(c.store, c.now)]);
    let rules = { mode: c.settings.rules.mode, lastRefreshAt: 0, lists: [] };
    if (deps.rules?.getStatus) {
      try { rules = { ...rules, ...(await deps.rules.getStatus({ store: c.store, settings: c.settings, now: c.now })) }; } catch { /* 忽略 */ }
    }
    const host = c.identity.host || ctx.url?.hostname || new URL(ctx.request.url).hostname;
    return jsonResponse({
      ok: true,
      version: deps.version ?? '',
      role: 'main',
      now: c.now,
      uuid: c.identity.uuid,
      uuidSource: c.identity.uuidSource || 'env',
      build: buildLabel(),
      dataplane: { version: DATAPLANE_VERSION, caps: CAPS },
      subUrl: c.identity.subToken ? `https://${host}/sub?token=${c.identity.subToken}` : '',
      host,
      settings: publicSettings(c.settings),
      accounts: pubAccounts(accounts),
      usage,
      pool: poolView(c.settings, accounts, usage, c.now),
      kv: { bound: !!c.store.kvBound, writesTodayEstimate: c.store.writesToday ? c.store.writesToday() : 0 },
      rules,
      checks: selfCheck({ settings: c.settings, accounts, usage, host, now: c.now, kvBound: !!c.store.kvBound, rules, identity: c.identity, loginPath: c.env?.LOGIN_PATH }),
    });
  }

  async function putSettings(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    stripMaskedSecrets(body, c.settings);
    const fields = validateSettingsPatch(body, c.settings);
    if (Object.keys(fields).length) return errorResponse(400, 'invalid', '设置校验失败', { fields });
    const next = applyPatch(c.settings, body);
    await c.store.saveSettings(next);
    track(ctx, { ...c, settings: next }, 'Save_Config', '保存设置');
    return jsonResponse({ ok: true, settings: publicSettings(next) });
  }

  async function getAccounts(ctx, c) {
    return jsonResponse({ ok: true, accounts: pubAccounts(await c.store.getAccounts()) });
  }

  /**
   * 浏览器/密码管理器会把保存的后台密码自动填进密码框（API Token 栏就是密码框），保存后 CF 收到的是后台密码，
   * 轮询报 400（9106 Authentication failed），真正的 Token 从未被使用。凭据与后台密码相同时一律当作"未填"（保留旧值）。
   */
  function dropAdminPassword(list, pw) {
    if (!pw || !Array.isArray(list)) return list;
    const same = (v) => typeof v === 'string' && v.trim() === pw;
    return list.map((a) => {
      if (!isPlain(a)) return a;
      const b = { ...a };
      for (const k of ['apiToken', 'globalKey']) if (same(b[k])) b[k] = '';
      if (isPlain(b.auth)) {
        b.auth = { ...b.auth };
        for (const k of ['apiToken', 'globalKey']) if (same(b.auth[k])) b.auth[k] = '';
      }
      return b;
    });
  }

  async function putAccounts(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    if (!Array.isArray(body.accounts)) return errorResponse(400, 'invalid', 'accounts 必须是数组', { fields: { accounts: '必须是数组' } });
    const mode = body.mode === 'merge' ? 'merge' : 'replace';
    const current = await c.store.getAccounts();
    const A = deps.accounts;
    const incoming = dropAdminPassword(body.accounts, c.identity.adminPassword);
    const merged = A.normalizeAccounts(A.mergeAccounts(current, A.normalizeAccounts(incoming), { mode }));
    await c.store.saveAccounts(merged);
    track(ctx, c, 'Save_Config', `保存账号 ${merged.length} 个`);
    return jsonResponse({ ok: true, accounts: pubAccounts(merged) });
  }

  async function importAccounts(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return errorResponse(400, 'invalid', '导入内容为空', { fields: { text: '不能为空' } });
    const format = body.format === 'usage_panel_json' ? 'usage_panel_json' : 'lines';
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const dryRun = body.dryRun !== false;
    const A = deps.accounts;
    let parsed;
    if (format === 'usage_panel_json') {
      let json;
      try { json = JSON.parse(text); } catch { return errorResponse(400, 'bad_json', '用量面板配置不是合法 JSON'); }
      parsed = A.importUsagePanelConfig(json);
    } else parsed = A.parseAccountsText(text);
    const current = await c.store.getAccounts();
    const merged = A.normalizeAccounts(A.mergeAccounts(current, dropAdminPassword(parsed.accounts || [], c.identity.adminPassword), { mode }));
    const curIds = new Set(current.map((a) => a.id));
    const added = merged.filter((a) => !curIds.has(a.id)).length;
    const updated = Math.max(0, (parsed.accounts || []).length - added);
    if (!dryRun) {
      await c.store.saveAccounts(merged);
      track(ctx, c, 'Save_Config', `导入账号 新增${added} 更新${updated}`);
    }
    return jsonResponse({ ok: true, dryRun, accounts: pubAccounts(merged), errors: parsed.errors || [], added, updated });
  }

  /**
   * POST /admin/api/accounts/upsert —— 给脚本用的"新增或更新"（幂等，按 id / host / accountId / email 匹配已有账号）。
   * Body：{accounts?:[{host|hosts, accountId?, apiToken?, email?, globalKey?, name?, role?, enabled?, weight?, limit?, note?}],
   *        text?:"每行 host,accountId,apiToken[,名称]（同批量导入格式）", overwrite?:boolean, poll?:boolean}
   *  - 已有账号：空的凭据字段保留旧值；role/enabled/weight/limit/note 默认不覆盖（overwrite:true 才覆盖）；hosts 取并集。
   *  - poll:true：保存后立刻轮询涉及的账号（≤40 个）并返回 polled，用来马上发现令牌无效 / 权限不足。
   */
  async function upsertAccounts(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const A = deps.accounts;
    let incoming = Array.isArray(body.accounts)
      ? body.accounts.map((a) => (isPlain(a) && a.hosts === undefined && a.host !== undefined ? { ...a, hosts: [].concat(a.host) } : a))
      : [];
    const parseErrors = [];
    if (typeof body.text === 'string' && body.text.trim()) {
      const p = A.parseAccountsText(body.text);
      incoming = incoming.concat(p.accounts);
      parseErrors.push(...(p.errors || []));
    }
    if (!incoming.length) return errorResponse(400, 'invalid', '没有可添加的账号：请提供 accounts 数组或 text', { fields: { accounts: '不能为空' }, parseErrors });
    if (incoming.length > 500) return errorResponse(400, 'invalid', '单次最多 500 个账号，请分批提交', { fields: { accounts: '超过 500 个' } });
    incoming = dropAdminPassword(incoming, c.identity.adminPassword);
    const current = await c.store.getAccounts();
    const r = A.mergeAccountsWithStats(current, incoming, { mode: 'merge', overwriteMeta: body.overwrite === true });
    await c.store.saveAccounts(r.accounts);
    // 涉及的账号：host / accountId / email 与提交内容有交集的
    const inc = A.normalizeAccounts(incoming);
    const hosts = new Set(inc.flatMap((a) => a.hosts));
    const cfIds = new Set(inc.map((a) => a.auth.accountId).filter(Boolean));
    const mails = new Set(inc.map((a) => a.auth.email).filter(Boolean));
    const touched = r.accounts.filter((a) => a.hosts.some((h) => hosts.has(h)) || (a.auth.accountId && cfIds.has(a.auth.accountId)) || (a.auth.email && mails.has(a.auth.email)));
    let polled, pollSkipped;
    if (body.poll === true && typeof deps.pollUsage === 'function' && c.now - (st.lastUpsertPollAt || -Infinity) < 5e3) {
      // 账号已经保存：不能再返回 429（脚本会以为保存失败），只说明这次没轮询
      pollSkipped = '轮询过于频繁，本次只保存、未轮询，请 5 秒后再试';
    } else if (body.poll === true && typeof deps.pollUsage === 'function') {
      st.lastUpsertPollAt = c.now;
      const ids = touched.filter((a) => a.role !== 'off' && a.enabled !== false).slice(0, 40).map((a) => a.id);
      if (ids.length) {
        const pr = await deps.pollUsage({ store: c.store, settings: c.settings, accounts: r.accounts, now: c.now, fetchFn: c.fetchFn, ids, force: true });
        const name = new Map(r.accounts.map((a) => [a.id, a.hosts[0] || a.name || a.id]));
        polled = (pr.polled || []).map((p) => ({ id: p.id, host: name.get(p.id), ok: p.ok, used: p.used, ...(p.ok ? {} : { error: redactSecrets(String(p.error || '')).slice(0, 200), kind: p.kind }) }));
      }
    }
    track(ctx, c, 'Save_Config', `脚本新增/更新账号 新增${r.added} 更新${r.updated}`);
    return jsonResponse({ ok: true, added: r.added, updated: r.updated, total: r.accounts.length, parseErrors, accounts: pubAccounts(touched), ...(polled ? { polled } : {}), ...(pollSkipped ? { pollSkipped } : {}) });
  }

  /** POST /admin/api/accounts/delete —— Body：{ids?:[…], hosts?:[…]}，按 id 或 host 删除；返回删除的数量 */
  async function deleteAccounts(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    const hosts = new Set((Array.isArray(body.hosts) ? body.hosts : []).map((h) => normalizeHost(String(h))).filter(Boolean));
    if (!ids.size && !hosts.size) return errorResponse(400, 'invalid', '请提供 ids 或 hosts', { fields: { ids: '不能为空' } });
    const cur = await c.store.getAccounts();
    const keep = cur.filter((a) => !ids.has(a.id) && !a.hosts.some((h) => hosts.has(h)));
    const removed = cur.length - keep.length;
    if (removed) {
      await c.store.saveAccounts(keep);
      track(ctx, c, 'Save_Config', `脚本删除账号 ${removed} 个`);
    }
    return jsonResponse({ ok: true, removed, total: keep.length });
  }

  async function pollUsage(ctx, c) {
    if (c.now - st.lastPollAt < POLL_MIN_MS) {
      const retryAfter = Math.ceil((st.lastPollAt + POLL_MIN_MS - c.now) / 1000);
      return errorResponse(429, 'throttled', '轮询过于频繁，请稍后再试', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const all = await c.store.getAccounts();
    let chosen = all.filter((a) => a.enabled !== false && a.role !== 'off');
    if (Array.isArray(body.ids) && body.ids.length) {
      const ids = new Set(body.ids.map(String));
      chosen = chosen.filter((a) => ids.has(a.id));
    }
    // 不再按列表顺序截取前 batchSize 个（那样排在后面的号永远轮不到）：交给 selectBatch 按"最久未轮询优先"选，
    // 单次上限由子请求预算决定；号很多时多点几次即可轮完
    if (!chosen.length) return errorResponse(400, 'no_accounts', '没有可轮询的账号');
    st.lastPollAt = c.now;
    const ids = chosen.map((a) => a.id);
    let r, saved = false;
    if (typeof deps.pollUsage === 'function') {
      r = await deps.pollUsage({ store: c.store, settings: c.settings, accounts: all, now: c.now, fetchFn: c.fetchFn, ids, force: true });
      saved = !!r.persisted;
    } else {
      const snapshot = await loadUsage(c.store, c.now);
      r = await deps.usage.pollBatch({ accounts: all, snapshot, settings: c.settings, now: c.now, fetchFn: c.fetchFn, ids, force: true });
      try { saved = await c.store.saveUsage(r.snapshot, { force: true, liveIds: all.map((a) => a.id) }); } catch { /* KV 写失败仍返回结果 */ }
    }
    if (r.events?.length) waitUntil(ctx, notifyUsageEvents({ settings: c.settings, events: r.events, accounts: all, fetchFn: c.fetchFn, now: c.now, state: notifyState }));
    return jsonResponse({ ok: true, saved, polled: r.polled || [], usage: r.snapshot, pool: poolView(c.settings, all, r.snapshot, c.now) });
  }

  async function preview(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const formats = ['b64', 'clash', 'sb', 'surge', 'raw'];
    const format = formats.includes(body.format) ? body.format : 'raw';
    let settings = c.settings;
    if (body.settings !== undefined) {
      const fields = validateSettingsPatch(body.settings, c.settings);
      if (Object.keys(fields).length) return errorResponse(400, 'invalid', '临时设置校验失败', { fields });
      settings = applyPatch(c.settings, stripMaskedSecrets(body.settings, c.settings));
    }
    const ip = typeof body.ip === 'string' && body.ip.trim() ? body.ip.trim() : (ctx.ip || clientIp(ctx.request));
    let r;
    try {
      r = await deps.buildSubscription({
        store: c.store, settings, identity: c.identity, request: ctx.request, now: c.now, fetchFn: c.fetchFn,
        overrides: { preview: true, noLog: true, noRateLimit: true }, format, ip,
      });
    } catch (e) {
      return errorResponse(500, 'preview_failed', '生成预览失败：' + redactSecrets(e?.message || String(e)).slice(0, 200));
    }
    const nodes = (r.nodes || []).map(nodeView);
    let hostShare = r.hostShare;
    if (!hostShare) {
      hostShare = {};
      for (const n of nodes) if (n.host) hostShare[n.host] = (hostShare[n.host] || 0) + 1;
    }
    const raw = typeof r.body === 'string' ? r.body : '';
    return jsonResponse({ ok: true, format, nodes, summary: r.summary ?? null, rawLength: raw.length, body: raw.slice(0, PREVIEW_BODY_LIMIT), hostShare, contentType: r.contentType || '' });
  }

  async function testSource(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const t0 = Date.now();
    if (body.kind === 'cidr') {
      const P = deps.pool;
      const r = c.settings.preferred.random;
      let text = typeof body.text === 'string' && body.text.trim() ? body.text : null;
      const warnings = [];
      if (text === null) {
        const isp = ['ct', 'cu', 'cmcc', 'cf'].includes(body.isp) ? body.isp : (r.isp === 'auto' ? 'cf' : r.isp);
        const url = P.cidrSourceUrl(isp, r.cidrBase);
        try {
          const res = await c.fetchFn(url);
          if (!res.ok) return errorResponse(502, 'fetch_failed', `拉取 CIDR 失败：HTTP ${res.status}`);
          text = (await res.text()).slice(0, MAX_BODY);
        } catch (e) {
          return errorResponse(502, 'fetch_failed', '拉取 CIDR 失败：' + redactSecrets(e?.message || String(e)).slice(0, 200));
        }
        warnings.push(`来源：${url}`);
      }
      const list = P.parseCidrList(text) || [];
      return jsonResponse({ ok: true, kind: 'cidr', count: list.length, sample: list.slice(0, 20), warnings, ms: Date.now() - t0 });
    }
    if (body.kind === 'regions') {
      // 测试地区列表（可用未保存的临时 urls / regex）
      const urls = Array.isArray(body.urls) ? body.urls.map(String).filter((u) => /^https?:\/\//i.test(u)) : c.settings.preferred.regions.urls;
      if (!urls.length) return errorResponse(400, 'invalid', '没有可测试的列表 URL', { fields: { urls: '不能为空' } });
      const regex = typeof body.regex === 'string' ? body.regex : c.settings.preferred.regions.regex;
      const s = applyPatch(c.settings, { preferred: { regions: { urls, regex, enabled: true } } });
      const st = await deps.regions.loadRegionStructure({ settings: s, fetchFn: c.fetchFn, now: c.now, cache: new Map() });
      const regions = [...st.groups.values()].map((g) => ({ name: [g.region, g.kind].filter(Boolean).join('-'), nodes: g.nodes.length }));
      return jsonResponse({ ok: true, kind: 'regions', count: st.total, regions, entries: st.entries.length, warnings: st.warnings, ms: Date.now() - t0 });
    }
    if (body.kind === 'best') {
      // 测试优选订阅 URL（可用未保存的临时 urls）
      const urls = Array.isArray(body.urls) ? body.urls.map(String).filter((u) => /^(https?|sub):\/\//i.test(u)) : c.settings.preferred.best.urls;
      if (!urls.length) return errorResponse(400, 'invalid', '没有可测试的优选 URL', { fields: { urls: '不能为空' } });
      const s = applyPatch(c.settings, { preferred: { best: { urls, enabled: true } } });
      const isp = ['ct', 'cu', 'cmcc', 'cf'].includes(body.isp) ? body.isp : 'cf';
      const r = await deps.best.fetchBest({ settings: s, isp, fetchFn: c.fetchFn, now: c.now, uuid: c.identity.uuid });
      const sample = r.entries.slice(0, 20).map((e) => `${e.address}:${e.port}${e.remark ? '#' + e.remark : ''}`);
      return jsonResponse({ ok: true, kind: 'best', count: r.entries.length + r.links.length, sample, warnings: r.errors, ms: Date.now() - t0 });
    }
    if (body.kind !== 'custom' && body.kind !== undefined) return errorResponse(400, 'invalid', 'kind 只能是 custom / cidr / best / regions', { fields: { kind: '取值无效' } });
    const text = typeof body.text === 'string' ? body.text : c.settings.preferred.custom.text;
    try {
      const r = await deps.sources.loadCustomEntries({ text, settings: c.settings, fetchFn: c.fetchFn, now: c.now, cache: new Map(), uuid: c.identity.uuid });
      const entries = r.entries || [];
      return jsonResponse({ ok: true, kind: 'custom', count: entries.length, sample: entries.slice(0, 20).map(entryToLine), warnings: r.warnings || [], ms: Date.now() - t0 });
    } catch (e) {
      return errorResponse(502, 'fetch_failed', '解析优选来源失败：' + redactSecrets(e?.message || String(e)).slice(0, 200));
    }
  }

  /** GET /admin/api/netinfo：访问者网络信息检测（对应 edt 后台的网络信息检测）+ 当前自适应结果 */
  async function netinfo(ctx, c) {
    const cf = ctx.request.cf || {};
    const ip = ctx.ip || clientIp(ctx.request);
    const detected = deps.detectIsp ? deps.detectIsp(cf) : 'cf';
    const resolved = deps.pool?.resolveIsp ? deps.pool.resolveIsp(c.settings.preferred.random.isp, detected) : detected;
    const ISP_CN = { ct: '中国电信', cu: '中国联通', cmcc: '中国移动', cf: '其他 / 官方' };
    return jsonResponse({
      ok: true,
      ip,
      prefix: deps.allocator?.ipPrefix ? deps.allocator.ipPrefix(ip) : '',
      country: cf.country || '', region: cf.region || '', city: cf.city || '', timezone: cf.timezone || '',
      asn: cf.asn || 0, asOrganization: cf.asOrganization || '',
      colo: cf.colo || '', httpProtocol: cf.httpProtocol || '', tlsVersion: cf.tlsVersion || '',
      isp: detected, ispName: ISP_CN[detected] || detected, adaptiveIsp: resolved, adaptiveIspName: ISP_CN[resolved] || resolved,
      ua: requestUa(ctx.request),
    });
  }

  async function getLogs(ctx, c) {
    const sp = (ctx.url || new URL(ctx.request.url)).searchParams;
    const logs = filterLogs(await c.store.getLogs(), { limit: Number(sp.get('limit')) || 200, type: sp.get('type') || '' });
    return jsonResponse({ ok: true, logs });
  }

  async function clearLogs(ctx, c) {
    await c.store.clearLogs();
    return jsonResponse({ ok: true });
  }

  async function notifyTest(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    // 允许用未保存的临时 token/chatId 测试（空串=用已保存的值）
    let settings = c.settings;
    if (isPlain(body.telegram)) settings = applyPatch(c.settings, stripMaskedSecrets({ notify: { telegram: body.telegram } }, c.settings));
    const t = settings.notify.telegram;
    if (!t.botToken || !t.chatId) return errorResponse(400, 'not_configured', '请先填写 Bot Token 与 Chat ID');
    const text = `<b>#${escapeHtml(settings.site.name)} 测试消息</b>\n\n✅ Telegram 通知配置正常\n📅 <b>时间：</b>${formatTime(c.now)}`;
    const r = await sendTelegram({ settings, text, fetchFn: c.fetchFn, now: c.now, force: true, ua: requestUa(ctx.request) });
    if (!r.sent) return errorResponse(502, 'send_failed', '发送失败：' + (r.error || r.reason), { detail: r.error || r.reason });
    return jsonResponse({ ok: true, sent: true, enabled: telegramConfigured(settings) });
  }

  async function exportData(ctx, c) {
    const accounts = await c.store.getAccounts();
    const data = { v: 2, exportedAt: c.now, settings: c.settings, accounts };
    return jsonResponse({ ok: true, data }, 200, { 'Content-Disposition': `attachment; filename="nicetunnel-backup-${new Date(c.now).toISOString().slice(0, 10)}.json"` });
  }

  async function importData(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    const data = isPlain(body.data) ? body.data : body;
    const dryRun = body.dryRun === true;
    if (data.v !== 2) return errorResponse(400, 'invalid', '不支持的备份格式（需要 v:2）', { fields: { v: '必须为 2' } });
    if (!isPlain(data.settings) && !Array.isArray(data.accounts)) return errorResponse(400, 'invalid', '备份里没有 settings 或 accounts');
    const fields = isPlain(data.settings) ? validateSettingsPatch(data.settings, defaultSettings()) : {};
    if (data.accounts !== undefined && !Array.isArray(data.accounts)) fields.accounts = '必须是数组';
    if (Object.keys(fields).length) return errorResponse(400, 'invalid', '备份校验失败', { fields });
    const settings = isPlain(data.settings) ? normalizeSettings(data.settings) : null;
    const accounts = Array.isArray(data.accounts) ? deps.accounts.normalizeAccounts(data.accounts) : null;
    if (!dryRun) {
      if (settings) await c.store.saveSettings(settings);
      if (accounts) await c.store.saveAccounts(accounts);
      track(ctx, c, 'Save_Config', '导入备份');
    }
    return jsonResponse({ ok: true, dryRun, settings: settings ? publicSettings(settings) : null, accounts: accounts ? pubAccounts(accounts) : null });
  }

  async function refreshRules(ctx, c) {
    if (c.now - st.lastRulesAt < RULES_MIN_MS) {
      const retryAfter = Math.ceil((st.lastRulesAt + RULES_MIN_MS - c.now) / 1000);
      return errorResponse(429, 'throttled', '刷新过于频繁，请稍后再试', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    st.lastRulesAt = c.now;
    const maxLists = Math.max(1, Math.min(10, Number(body.maxLists) || 3));
    try {
      const r = await deps.rules.refreshRuleset({ settings: c.settings, store: c.store, kv: c.store.kv || null, fetchFn: c.fetchFn, now: c.now, maxLists });
      return jsonResponse({ ok: true, updated: r.updated || [], pending: r.pending ?? 0, errors: r.errors || [] });
    } catch (e) {
      return errorResponse(502, 'refresh_failed', '刷新规则失败：' + redactSecrets(e?.message || String(e)).slice(0, 200));
    }
  }

  /** POST /admin/api/rules/ini/fetch：从远程 URL 获取转换配置并保存到 KV（之后订阅只读 KV，不再连远程） */
  async function fetchIni(ctx, c) {
    if (c.now - (st.lastIniAt || -Infinity) < 10e3) return errorResponse(429, 'throttled', '操作过于频繁，请稍后再试', { retryAfter: 10 }, { 'Retry-After': '10' });
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    st.lastIniAt = c.now;
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : c.settings.rules.configUrl;
    const r = await deps.rules.fetchIni({ store: c.store, settings: c.settings, fetchFn: c.fetchFn, now: c.now, url });
    if (!r.ok) return errorResponse(502, 'fetch_failed', redactSecrets(r.error || '获取失败').slice(0, 200));
    // INI 变了，规则块要重建：顺手刷新几个规则列表（子请求，不耗 Workers 额度）
    let rulesRefresh = null;
    if (r.changed || body.rebuild) {
      try { rulesRefresh = await deps.rules.refreshRuleset({ settings: { ...c.settings, rules: { ...c.settings.rules, configUrl: url } }, store: c.store, kv: c.store.kv || null, fetchFn: c.fetchFn, now: c.now, maxLists: 3 }); } catch { /* 不影响保存结果 */ }
    }
    track(ctx, c, 'Save_Config', `获取并保存转换配置（${r.groups} 组 / ${r.rulesets} 条规则集）`);
    return jsonResponse({ ok: true, ...r, rules: rulesRefresh ? { updated: rulesRefresh.updated || [], pending: rulesRefresh.pending ?? 0, errors: rulesRefresh.errors || [] } : null });
  }

  async function reset(ctx, c) {
    const { body, error } = await readJson(ctx.request);
    if (error) return error;
    if (body.confirm !== 'RESET') return errorResponse(400, 'confirm_required', '危险操作：请在 confirm 中填写 RESET');
    const scope = body.scope;
    if (!['settings', 'usage', 'logs', 'all'].includes(scope)) return errorResponse(400, 'invalid', 'scope 只能是 settings / usage / logs / all', { fields: { scope: '取值无效' } });
    const done = [];
    if (scope === 'settings' || scope === 'all') { await c.store.saveSettings(defaultSettings()); done.push('settings'); }
    if (scope === 'usage' || scope === 'all') {
      const empty = deps.usage?.emptySnapshot ? deps.usage.emptySnapshot(c.now) : { v: 1, ts: c.now, day: new Date(c.now).toISOString().slice(0, 10), cursor: 0, accounts: {} };
      await c.store.saveUsage(empty, { force: true, liveIds: [] });
      done.push('usage');
    }
    if (scope === 'logs' || scope === 'all') { await c.store.clearLogs(); done.push('logs'); }
    if (scope !== 'logs') track(ctx, c, 'Init_Config', `重置 ${done.join(',')}`);
    return jsonResponse({ ok: true, reset: done });
  }

  // ---------------- 兼容旧版接口 ----------------

  /** GET /admin/check：参数解析与响应格式与上游一致（_worker.js 138–206 行），实际检测由 deps.checkProxy 完成 */
  async function legacyCheck(ctx) {
    const url = ctx.url || new URL(ctx.request.url);
    const protocol = ['socks5', 'http', 'https', 'turn', 'sstp'].find((t) => url.searchParams.has(t)) || null;
    const plain = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json;charset=utf-8' } });
    if (!protocol) return plain({ error: '缺少代理参数' }, 400);
    const param = url.searchParams.get(protocol);
    if (typeof deps.checkProxy !== 'function') return plain({ success: false, error: '当前部署未启用代理检查', proxy: `${protocol}://${param}`, responseTime: 0 });
    const t0 = Date.now();
    try {
      return plain(await deps.checkProxy(ctx.request, protocol, param));
    } catch (e) {
      return plain({ success: false, error: e?.message || String(e), proxy: `${protocol}://${param}`, responseTime: Date.now() - t0 });
    }
  }

  /** GET /admin/getADDAPI?url=…&port=…：校验优选 API（上游 123–137 行），返回 {success, data:[地址行]} */
  async function legacyGetAddApi(ctx, c) {
    const url = ctx.url || new URL(ctx.request.url);
    const plain = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json;charset=utf-8' } });
    const target = url.searchParams.get('url');
    if (!target) return plain({ success: false, data: [] }, 403);
    try {
      new URL(target);
      const port = url.searchParams.get('port');
      // 上游把 port 作为该 API 的默认端口；这里以 `?port=` 追加给来源解析（sources 支持 `?port=` 默认端口语法）
      const line = port && !/[?&]port=/.test(target) ? target + (target.includes('?') ? '&' : '?') + 'port=' + encodeURIComponent(port) : target;
      const r = await deps.sources.loadCustomEntries({ text: line, settings: c.settings, fetchFn: c.fetchFn, now: c.now, cache: new Map(), uuid: c.identity.uuid });
      return plain({ success: true, data: (r.entries || []).map(entryToLine) });
    } catch (e) {
      const msg = e?.message || String(e);
      return plain({ msg: '验证优选API失败，失败原因：' + msg, error: msg }, 500);
    }
  }

  /** GET /locations | /admin/locations：反代 speed.cloudflare.com/locations（上游 497–500 行） */
  async function legacyLocations(ctx, c) {
    const res = await c.fetchFn(new Request('https://speed.cloudflare.com/locations', { headers: { Referer: 'https://speed.cloudflare.com/' } }));
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  }

  async function legacyConfig(ctx, c) {
    if (ctx.request.method === 'POST') return errorResponse(410, 'gone', '旧版配置接口已停用，请使用新后台保存设置');
    return new Response(JSON.stringify(legacyConfigView(c.settings, c.identity), null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  async function legacyLog(ctx, c) {
    const logs = filterLogs(await c.store.getLogs(), { limit: 2000 }).reverse();
    return new Response(JSON.stringify(logs.map((e) => ({ TYPE: e.type, IP: e.ip, ASN: e.asn, CC: e.loc, URL: e.url, UA: e.ua, TIME: e.t }))), { status: 200, headers: { 'Content-Type': 'application/json;charset=utf-8' } });
  }

  // ---------------- 路由表 ----------------
  /** @type {Record<string, (ctx:object, c:object)=>Promise<Response>>} key = `METHOD path`（path 不含 /admin/api/ 前缀） */
  const API_ROUTES = {
    'GET state': getState,
    'PUT settings': putSettings,
    'GET accounts': getAccounts,
    'PUT accounts': putAccounts,
    'POST accounts/import': importAccounts,
    'POST accounts/upsert': upsertAccounts,
    'POST accounts/delete': deleteAccounts,
    'POST usage/poll': pollUsage,
    'POST hosts/checks': saveHostChecks,
    'POST preview': preview,
    'POST test-source': testSource,
    'GET netinfo': netinfo,
    'GET logs': getLogs,
    'POST logs/clear': clearLogs,
    'POST notify/test': notifyTest,
    'GET export': exportData,
    'POST import': importData,
    'POST rules/refresh': refreshRules,
    'POST rules/ini/fetch': fetchIni,
    'POST reset': reset,
    // 家宽：立即拉一次 VPN Gate 列表（不管开没开，方便先试）
    'POST home/refresh': async (ctx, c) => {
      const r = await refreshHome({ store: c.store, settings: c.settings, fetchFn: c.fetchFn, now: c.now, force: true });
      const data = r.ok ? await loadHome(c.store) : null;
      return jsonResponse({ ok: true, ...r, entries: (data?.entries || []).map((e) => ({ cc: e.cc })) });
    },
    // 概览页"一键导入"的二维码：只为主站自己的订阅链接生成（不接受任意内容）
    'GET sub/qr': async (ctx, c) => {
      const host = c.identity.host || ctx.url?.hostname || new URL(ctx.request.url).hostname;
      if (!c.identity.subToken) return errorResponse(404, 'no_sub', '没有订阅链接');
      return new Response(qrSvg(`https://${host}/sub?token=${c.identity.subToken}`, { px: 5 }), { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
    },
    // 多用户专属链接（「用户」页）
    ...createUsersRoutes(readJson),
  };
  /** 旧版路径（大小写与上游一致：getADDAPI 区分大小写，其余小写匹配） */
  const LEGACY_ROUTES = {
    'admin/check': { fn: legacyCheck, needsPrep: false },
    'admin/getADDAPI': { fn: legacyGetAddApi },
    'admin/locations': { fn: legacyLocations },
    'locations': { fn: legacyLocations, softAuth: true },
    'admin/config.json': { fn: legacyConfig },
    'admin/log.json': { fn: legacyLog },
  };

  /**
   * 处理 /admin/api/* 与旧版兼容路径。非本模块路径返回 null（由路由层继续处理，例如 /admin 页面）。
   * @param {object} ctx AppContext
   * @returns {Promise<Response|null>}
   */
  async function handleAdminRequest(ctx) {
    const url = ctx.url || new URL(ctx.request.url);
    const path = url.pathname.replace(/^\/+/, '');
    const lower = path.toLowerCase();
    const isApi = lower.startsWith('admin/api/');
    let legacy = null;
    if (!isApi) {
      legacy = path === 'admin/getADDAPI' ? LEGACY_ROUTES[path] : LEGACY_ROUTES[lower] || null;
      if (!legacy) return null;
    }
    // /locations 未登录时与上游一样不处理（交给伪装页）
    if (legacy?.softAuth) {
      const denied = requireAuth(ctx, { api: false });
      if (denied) return null;
    } else {
      const denied = requireAuth(ctx, { api: true });
      if (denied) return denied;
    }
    // Bearer 鉴权的请求不依赖 cookie，不需要 CSRF 头
    const csrf = ctx.viaBearer ? null : checkCsrf(ctx.request);
    if (csrf) return csrf;
    // 旧版 GET 接口（/admin/check 会让主站去连指定主机）：cookie 是 SameSite=Lax，别的网站顶层跳转也会带上。
    // 浏览器会标明请求来源，来自其它站点的一律拒绝
    if (legacy && !ctx.viaBearer && !legacy.softAuth) {
      const site = (ctx.request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
      if (site === 'cross-site' || site === 'same-site') return errorResponse(403, 'csrf', '跨站请求，已拒绝');
    }

    try {
      if (legacy) {
        const c = legacy.needsPrep === false ? null : await prep(ctx);
        return await legacy.fn(ctx, c);
      }
      const sub = path.slice('admin/api/'.length).replace(/\/+$/, '');
      const fn = API_ROUTES[`${ctx.request.method.toUpperCase()} ${sub}`];
      if (!fn) {
        const exists = Object.keys(API_ROUTES).some((k) => k.endsWith(' ' + sub));
        return exists ? errorResponse(405, 'method_not_allowed', '请求方法不支持') : errorResponse(404, 'not_found', '接口不存在');
      }
      return await fn(ctx, await prep(ctx));
    } catch (e) {
      return errorResponse(500, 'internal', '服务器内部错误：' + redactSecrets(e?.message || String(e)).slice(0, 200));
    }
  }

  return { handleAdminRequest, routes: Object.keys(API_ROUTES), _state: st };
}

const apiCache = new WeakMap();
/**
 * 便捷导出：deps 放在 appCtx.adminDeps 上时直接调用；同一个 deps 对象复用同一实例（限频状态在 isolate 内共享）。
 * @param {object} appCtx
 */
export async function handleAdminRequest(appCtx) {
  const deps = appCtx.adminDeps || {};
  let api = apiCache.get(deps);
  if (!api) { api = createAdminApi(deps); apiCache.set(deps, api); }
  return api.handleAdminRequest(appCtx);
}
