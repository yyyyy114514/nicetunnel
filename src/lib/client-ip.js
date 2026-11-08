// 访问者 IP：主站（登录 / API 限流、订阅限速）和数据面共用这一份，保证各处认的是同一个 IP
export function clientIp(request) {
  const h = request.headers;
  return h.get('CF-Connecting-IP') || h.get('True-Client-IP') || h.get('X-Real-IP') || h.get('X-Forwarded-For')
    || h.get('Fly-Client-IP') || h.get('X-Appengine-Remote-Addr') || h.get('X-Cluster-Client-IP') || '未知IP';
}
