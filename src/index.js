// nicetunnel 入口：同一份代码按角色运行
//   main：有 KV（或 MODE=main）→ 数据面 + 订阅/后台/Cron
//   node：无 KV（或 MODE=node）→ 只有数据面 + 静态伪装页（不读 KV、不做外部请求，最省额度）
import { normalizeRequestUrl, handleDataPlane, camouflage } from './dataplane/adapter.js';
import { deriveIdentity } from './control/identity.js';
import { handleMain } from './control/app.js';
import { runScheduled } from './control/cron.js';

export function detectRole(env) {
  const mode = String(env.MODE || 'auto').toLowerCase();
  if (mode === 'main' || mode === 'node') return mode;
  return env.KV && typeof env.KV.get === 'function' ? 'main' : 'node';
}

export default {
  async fetch(request, env, ctx) {
    const url = normalizeRequestUrl(request.url);
    const identity = deriveIdentity(env, url.hostname);
    const dp = await handleDataPlane(request, env, url, identity);
    if (dp) return dp;
    const role = detectRole(env);
    if (role === 'main') return handleMain({ request, env, ctx, url, identity });
    // node：非代理请求一律伪装页；http 跳 https 与上游一致
    if (url.protocol === 'http:') return Response.redirect(url.href.replace(`http://${url.hostname}`, `https://${url.hostname}`), 301);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });
    return camouflage(request, url, env.URL || 'nginx');
  },
  async scheduled(event, env, ctx) {
    if (detectRole(env) !== 'main') return;
    await runScheduled({ event, env, ctx });
  },
};
