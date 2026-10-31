// 纯节点入口：只打包数据面与身份推导，不包含主站后台、订阅、账号 API 或 Cron。
// 对外行为与 src/index.js 的 node 角色一致；单独构建可减少节点部署的无关代码与攻击面。
import { normalizeRequestUrl, handleDataPlane, camouflage } from './dataplane/adapter.js';
import { deriveIdentity } from './control/identity.js';

export default {
  async fetch(request, env) {
    const url = normalizeRequestUrl(request.url);
    const identity = deriveIdentity(env, url.hostname);
    const dp = await handleDataPlane(request, env, url, identity, 'node');
    if (dp) return dp;
    if (url.protocol === 'http:') return Response.redirect(url.href.replace(`http://${url.hostname}`, `https://${url.hostname}`), 301);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });
    return camouflage(request, url, env.URL || 'nginx');
  },
};
