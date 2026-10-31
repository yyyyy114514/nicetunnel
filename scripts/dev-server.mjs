// 本地预览：用 Node 跑打包好的 dist/_worker.js（内存 KV，外部请求照常走网络）。
// 用法：node scripts/build.mjs && node scripts/dev-server.mjs [端口]   管理员密码：环境变量 ADMIN（默认 dev-admin）
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 8787;
const { default: worker } = await import(pathToFileURL(fileURLToPath(new URL('../dist/_worker.js', import.meta.url))).href);
const mem = new Map();
const KV = {
  async get(k, o) { const v = mem.get(k); if (v == null) return null; return (o?.type || o) === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { mem.set(k, String(v)); },
};
const env = { KV, ADMIN: process.env.ADMIN || 'dev-admin', KEY: 'dev' };

// 演示数据：12 个账号、不同消耗速度（DEV_SEED=0 关闭）
if (process.env.DEV_SEED !== '0') {
  const now = Date.now();
  const accounts = Array.from({ length: 12 }, (_, i) => ({
    id: 'a' + i, name: `账号 ${String(i + 1).padStart(2, '0')}`, hosts: [`vp${i + 2}.example.com`], role: 'node', enabled: true, weight: 1, limit: null, note: '',
    auth: { accountId: (i + 1).toString(16).padStart(32, '0'), apiToken: 'demo-token', email: '', globalKey: '' },
  }));
  const rates = [160, 90, 60, 45, 30, 20, 12, 8, 5, 2, 1, 0];
  const used = [74000, 52000, 41000, 38000, 26000, 19000, 12000, 9000, 4000, 1500, 800, 100];
  const snap = { v: 1, ts: now, day: new Date(now).toISOString().slice(0, 10), cursor: 0, accounts: {} };
  accounts.forEach((a, i) => { snap.accounts[a.id] = { used: used[i], workers: used[i], pages: 0, rate: rates[i], polledAt: now - i * 40e3, triedAt: now - i * 40e3, ok: true, err: null, fails: 0, alerted: {} }; });
  // DEV_SEED=states：造出各种轮询状态，用来看后台"轮询状态"列怎么显示
  if (process.env.DEV_SEED === 'states') {
    const H = 3600e3;
    accounts[4].auth.apiToken = ''; // 无凭据
    snap.accounts.a1.polledAt = now - 3 * H; snap.accounts.a1.triedAt = now - 3 * H; // 过期：3 小时没更新（没有 Cron 时常见）
    Object.assign(snap.accounts.a2, { ok: false, err: '账户获取失败: 403', errKind: 'auth', fails: 4, polledAt: now - 2 * H, triedAt: now - 60e3 }); // 失败过，之前成功过
    Object.assign(snap.accounts.a3, { ok: false, err: '查询失败: 401', errKind: 'auth', fails: 2, polledAt: 0, triedAt: now - 60e3, used: 0 }); // 一直失败，从没成功
    delete snap.accounts.a5; // 还没轮询
  }
  await KV.put('nt.accounts', JSON.stringify(accounts));
  await KV.put('nt.usage', JSON.stringify(snap));
  await KV.put('nt.settings', JSON.stringify({ schema: 2, site: { name: 'nicetunnel' }, preferred: { custom: { text: '104.17.1.1:443#日本-住宅-01\n104.18.2.2:443#美国-住宅-01' } }, rules: { configUrl: '' } }));
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  // 本地是 http，伪装成 https，避免触发 http→https 跳转
  const url = `https://${req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('CF-Connecting-IP', '127.0.0.1');
  try {
    const r = await worker.fetch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
    const out = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    // 本地 http 下 Secure cookie 不会被浏览器保存，去掉 Secure
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) out['set-cookie'] = sc.map((c) => c.replace(/;\s*Secure/i, ''));
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e?.stack || e));
  }
}).listen(port, () => console.log(`nicetunnel 本地预览：http://localhost:${port}/login`));
