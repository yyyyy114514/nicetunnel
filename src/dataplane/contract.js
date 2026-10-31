// 主站 ↔ 节点站点的"数据面契约"。节点站点只依赖这里约定的东西，所以主站可以随意迭代，只要不破坏契约，节点就不用重新部署。
//
// 契约内容（改动任何一条都需要递增 DATAPLANE_VERSION，并保证旧节点给出明确的"请更新节点"提示，而不是静默失败）：
//   1. 身份：节点只需要环境变量 UUID（与主站一致）；admin 密码缺省时回退取 UUID，不需要 ADMIN。
//   2. 订阅里每个节点的 WS 路径：`/` + 反代参数（proxyip= / socks5= / http= / https= / turn= / sstp=）+ `?ed=2560`（上游格式，由 edt-core 解析）。
//   3. 链式路径 `/video/<密文>`：密文用 UUID 加解密，明文是 {type, hostname, port, username, password}（上游格式）。
//   4. 地区路由路径 `/video/<密文>`：明文是 {type:'pool', v, u, r, region, kind, i, k, ttl, sticky}（见 pool-route.js；未知字段一律忽略）。
//   5. XHTTP 混淆头：由 UUID 派生（getLocalMark）。
//   6. GET /version?uuid=<UUID>：仅 UUID 校验通过时返回 {Version, Dataplane, Caps, Edition} 并带 CORS；否则与普通伪装页一致。
//   7. 其余请求一律返回伪装页，不做任何外部请求。
//   8. 链式拨号结果在当前 isolate 内反馈给地区选路；失败冷却 5 分钟，CHAIN_TIMEOUT 控制链路连接/读写超时。
//   9. 链式拨号失败先换下一台候选重试（地区路由把候选链随连接传进数据面），换完仍失败才断开客户端；
//      CHAIN_FAILOVER 控制最多再换几台（默认 1，0=关闭）。非地区路由不受影响，行为与上游一致。
//  10. SSTP 链路（sstp-keepalive@1）：应答 SSTP/PPP 保活、对端 RST/断开立即结束、TCP 序号校验、接收窗口流控、SYN 带 MSS。
//      纯节点内部行为，不改路径格式，所以不提高 DATAPLANE_VERSION；后台检测会把缺少该能力的节点标为"建议更新"。
//  11. SSTP 竞速（chain-race@1）：地区路由时同时拨前两台 SSTP 候选，先握手成功者胜出；CHAIN_RACE=1 关闭。同一 Worker 请求，不额外耗额度。
//  12. 扫描防护（guard-cred@1）：只把 UUID / Trojan 密码不符计为认证失败（XUDP 的 Mux 命令等正常流量不再导致封 IP）。
//  13. 节点自报统计（node-stats@1）：GET /version?uuid=<UUID>&stats=1 附带本 isolate 的连接 / 拦截 / 链路成败 / 最近错误，只在内存，不耗额度。
//  14. 出站连接器兜底（socket-fallback@1）：运行环境没有 request.fetcher 时改用 cloudflare:sockets connect()；SOCKET_API=sockets 强制使用。/version?stats=1 的 Socket 字段报告实际用的是哪个。
//  15. 地区路由种子（pool-seed@1）：路径明文可带 s:[[类型, 账号]…]（该地区列表前几台）。新实例没缓存列表时先用种子拨号、后台拉列表；SSTP 连服务器与首个 HTTP 响应各最多 3 秒，死节点更快换下一台。
//
// 向前兼容的约定：
//   - 主站新增能力时，优先通过"可选字段"表达（旧节点忽略未知字段）；只有确实需要节点配合的新行为才提高对应的 `v`。
//   - 节点遇到比自己支持的更高的 `v` 时，返回 503「节点站点版本过旧，请更新节点 _worker.js」，后台"检测节点"也会标出落后的节点。

/** 数据面协议版本：仅当上面的契约发生不兼容变化时递增 */
export const DATAPLANE_VERSION = 2;

/** 地区路由路径明文里 `v` 字段本节点最高支持的版本；主站生成的路径使用 POOL_ROUTE_V */
export const POOL_ROUTE_V = 1;

/** 本节点支持的能力（供后台检测与以后的主站判断） */
export const CAPS = Object.freeze(['chain-path@1', 'pool-route@1', 'chain-health@1', 'chain-failover@1', 'sstp-keepalive@1', 'chain-race@1', 'guard-cred@1', 'node-stats@1', 'socket-fallback@1', 'pool-seed@1', 'xhttp-mark@1', 'version-cors@1']);
