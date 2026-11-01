// 后台「用户」页的接口（多用户专属链接）。鉴权、CSRF 由 api.js 统一处理；这里只管业务。
import { jsonResponse, errorResponse } from '../control/auth.js';
import {
  MU_KEYS, MAX_BATCH, getUsers, saveUsers, makeUsers, getMuSecret, userSubUrl, effectiveLimit,
  cfAccountIdOf, setupAccount, accountReady, syncUsers, userStats, normalizeUser,
} from '../control/users.js';
import { redactSecrets } from '../control/notify.js';

const PAGE_MAX = 200;

/** 可以配置多用户的节点账号（主站账号读自己的 KV，不需要配置） */
const nodeAccounts = (accounts) => (accounts || []).filter((a) => a.role === 'node' && a.hosts?.length);

/**
 * @param {(request: Request) => Promise<{body?: any, error?: Response}>} readJson
 */
export function createUsersRoutes(readJson) {
  const origin = (ctx) => { const u = ctx.url || new URL(ctx.request.url); return `${u.protocol}//${u.host}`; };
  const needOn = (c) => (c.settings.users?.enabled ? null : errorResponse(400, 'disabled', '多用户未开启：先在「系统」页打开'));

  async function withLinks(c, ctx, list) {
    const secret = await getMuSecret(c.store);
    const o = origin(ctx);
    return Promise.all(list.map(async (u) => ({ ...u, effLimit: effectiveLimit(u, c.settings), sub: await userSubUrl(secret, o, u.id) })));
  }

  async function accountsView(c) {
    const [accounts, usage, metas, sync] = await Promise.all([c.store.getAccounts(), c.store.getUsage(), c.store.getJson(MU_KEYS.accounts, 10e3), c.store.getJson(MU_KEYS.sync, 10e3)]);
    const meta = metas || {};
    return {
      accounts: nodeAccounts(accounts).map((a) => {
        const m = meta[a.id] || null;
        return { id: a.id, name: a.name || a.hosts[0], hosts: a.hosts, enabled: a.enabled !== false, cfId: cfAccountIdOf(a, usage), meta: m, ready: accountReady(m), pushed: !!(sync?.sig && sync.pushed?.[a.id] === sync.sig), error: sync?.errors?.[a.id] || '' };
      }),
      sync: sync ? { at: sync.at, over: Object.keys(sync.over || {}).length, errors: Object.keys(sync.errors || {}).length } : null,
    };
  }

  /** 改了名单 / 限制后立刻下发（不查在线，沿用上次的超限结果） */
  async function pushNow(c) {
    try {
      const [accounts, usage] = await Promise.all([c.store.getAccounts(), c.store.getUsage()]);
      return await syncUsers({ store: c.store, settings: c.settings, accounts, usage, fetchFn: c.fetchFn, now: c.now, query: false });
    } catch (e) { return { error: redactSecrets(String(e?.message || e)).slice(0, 200) }; }
  }

  const pickIds = (body) => new Set((Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => /^[a-z0-9]{8}$/.test(x)));

  return {
    /** 列表（分页 + 搜索）+ 账号配置状态 */
    'GET users': async (ctx, c) => {
      const u = ctx.url || new URL(ctx.request.url);
      const q = String(u.searchParams.get('q') || '').trim().toLowerCase();
      const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
      const limit = Math.max(1, Math.min(PAGE_MAX, Number(u.searchParams.get('limit')) || 100));
      const all = await getUsers(c.store);
      const filtered = q ? all.filter((x) => x.id.includes(q) || x.name.toLowerCase().includes(q)) : all;
      const page = filtered.slice().reverse().slice(offset, offset + limit); // 新建的在前
      return jsonResponse({
        ok: true, enabled: !!c.settings.users?.enabled, defaultLimit: c.settings.users?.defaultLimit ?? 2,
        total: all.length, matched: filtered.length, banned: all.filter((x) => x.banned).length, offset, limit,
        users: await withLinks(c, ctx, page), ...(await accountsView(c)),
      });
    },
    /** 批量生成 */
    'POST users/create': async (ctx, c) => {
      const off = needOn(c); if (off) return off;
      const { body, error } = await readJson(ctx.request); if (error) return error;
      const count = Number(body.count);
      if (!Number.isFinite(count) || count < 1 || count > MAX_BATCH) return errorResponse(400, 'invalid', `数量必须是 1~${MAX_BATCH}`);
      const all = await getUsers(c.store);
      let made;
      try { made = makeUsers(all, { count, prefix: body.prefix, limit: body.limit, now: c.now }); } catch (e) { return errorResponse(400, e.code || 'invalid', e.message); }
      await saveUsers(c.store, all.concat(made));
      const push = await pushNow(c);
      return jsonResponse({ ok: true, created: await withLinks(c, ctx, made), push });
    },
    /** 批量修改：封禁 / 解封、并行上限、名字（单个） */
    'POST users/update': async (ctx, c) => {
      const { body, error } = await readJson(ctx.request); if (error) return error;
      const ids = pickIds(body);
      if (!ids.size) return errorResponse(400, 'invalid', '没有选中用户');
      const all = await getUsers(c.store);
      let n = 0;
      const next = all.map((u) => {
        if (!ids.has(u.id)) return u;
        n++;
        const v = { ...u };
        if (typeof body.banned === 'boolean') v.banned = body.banned;
        if ('limit' in body) v.limit = body.limit;
        if (typeof body.name === 'string' && ids.size === 1) v.name = body.name;
        return normalizeUser(v) || u;
      });
      await saveUsers(c.store, next);
      const push = await pushNow(c);
      return jsonResponse({ ok: true, updated: n, push });
    },
    'POST users/delete': async (ctx, c) => {
      const { body, error } = await readJson(ctx.request); if (error) return error;
      const ids = pickIds(body);
      if (!ids.size) return errorResponse(400, 'invalid', '没有选中用户');
      const all = await getUsers(c.store);
      const next = all.filter((u) => !ids.has(u.id));
      await saveUsers(c.store, next);
      const push = await pushNow(c);
      return jsonResponse({ ok: true, removed: all.length - next.length, push });
    },
    /** 在线与用量（查各账号 Analytics Engine） */
    'POST users/stats': async (ctx, c) => {
      const off = needOn(c); if (off) return off;
      const [accounts, usage] = await Promise.all([c.store.getAccounts(), c.store.getUsage()]);
      const r = await userStats({ store: c.store, accounts, usage, fetchFn: c.fetchFn });
      return jsonResponse({ ok: true, ...r });
    },
    /** 配置一个节点账号：建 KV、加绑定、重新部署；manualBound=true 表示管理员已手动绑定 */
    'POST users/setup': async (ctx, c) => {
      const { body, error } = await readJson(ctx.request); if (error) return error;
      const [accounts, usage, metas] = await Promise.all([c.store.getAccounts(), c.store.getUsage(), c.store.getJson(MU_KEYS.accounts, 0)]);
      const a = nodeAccounts(accounts).find((x) => x.id === String(body.id || ''));
      if (!a) return errorResponse(404, 'not_found', '账号不存在');
      const all = { ...(metas || {}) };
      const prev = all[a.id] || {};
      let meta;
      if (body.reset) meta = {};
      else if (typeof body.manualBound === 'boolean') meta = { ...prev, manualBound: body.manualBound };
      else meta = await setupAccount({ account: a, cfId: cfAccountIdOf(a, usage), fetchFn: c.fetchFn, now: c.now, prev, redeploy: body.redeploy !== false });
      if (meta.err) meta.err = redactSecrets(meta.err);
      all[a.id] = meta;
      await c.store.putJson(MU_KEYS.accounts, all, 10e3);
      const push = meta.nsId ? await pushNow(c) : null;
      return jsonResponse({ ok: true, meta, ready: accountReady(meta), push });
    },
    /** 立即同步（查在线 + 下发） */
    'POST users/sync': async (ctx, c) => {
      const [accounts, usage] = await Promise.all([c.store.getAccounts(), c.store.getUsage()]);
      const r = await syncUsers({ store: c.store, settings: c.settings, accounts, usage, fetchFn: c.fetchFn, now: c.now });
      return jsonResponse({ ok: true, ...r });
    },
  };
}
