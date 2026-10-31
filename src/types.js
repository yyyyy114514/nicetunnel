// 共享类型定义（仅 JSDoc，无运行时代码）。各模块在注释里 import('../types.js').X 引用。
// 修改这里等于修改模块间契约，必须同步更新 docs/DESIGN.md。

/**
 * 一个 Cloudflare 账号（对应一个 Pages/Workers 节点站点）。存于 KV nt.accounts（数组）。
 * @typedef {Object} Account
 * @property {string} id            稳定标识，如 'a1'；唯一
 * @property {string} name          备注名
 * @property {string[]} hosts       该账号承载的节点域名（小写，无协议/端口）。role='node' 时至少 1 个
 * @property {'node'|'main'|'off'} role  node=参与节点分配；main=主站（只监控额度，不分配节点）；off=停用
 * @property {boolean} enabled
 * @property {number} weight        手工权重倍率，默认 1
 * @property {number|null} limit    覆盖每日额度上限，null=用 settings.usage.limitPerAccount
 * @property {{accountId:string, apiToken:string, email:string, globalKey:string}} auth
 *           apiToken(需 Account Analytics:Read) 或 email+globalKey 二选一；accountId 可空（首次轮询自动发现并回填）
 * @property {string} note
 */

/**
 * 用量快照，存于 KV nt.usage。day 为 UTC 日期，跨日整体清零。
 * @typedef {Object} UsageSnapshot
 * @property {1} v
 * @property {number} ts            快照生成时间(ms)
 * @property {string} day           'YYYY-MM-DD'（UTC）
 * @property {number} cursor        轮询游标（预留）
 * @property {Object<string, AccountUsage>} accounts  key=Account.id
 */

/**
 * @typedef {Object} AccountUsage
 * @property {number} used          今日 Workers+Pages 请求数
 * @property {number} workers
 * @property {number} pages
 * @property {number} rate          请求速率 EMA（次/分钟）
 * @property {number} polledAt      最近一次成功轮询时间(ms)，0=从未
 * @property {number} triedAt       最近一次尝试轮询(ms)
 * @property {boolean} ok           最近一次尝试是否成功
 * @property {string|null} err      最近一次错误（短文本）
 * @property {string} [accountId]   自动发现的 Cloudflare 账户 ID
 */

/**
 * 分配用的主机视图（由 allocator.buildHostPool 产出）。
 * @typedef {Object} HostInfo
 * @property {string} host
 * @property {string|null} accountId  null=未纳入账号管理的裸 host
 * @property {number} used
 * @property {number} budget          可用预算 = limit*(1-safetyMargin)
 * @property {number} remaining       有效剩余（扣除预测燃烧）
 * @property {number} weight          分配权重，>=0；0 表示本轮不可分配
 * @property {'ok'|'low'|'exhausted'|'stale'|'unknown'} state
 */

/**
 * 一个候选节点（尚未分配承载域名 host）。
 * @typedef {Object} NodeSpec
 * @property {string} id            稳定 id（hash(address,port,path,link)），用于分配时的 slot 标识
 * @property {string} name          最终备注，已保证在整份订阅内唯一；分组靠名字里的关键字（CF/住宅…）匹配
 * @property {'custom'|'random'|'link'} origin   custom=优质 random=兜底 link=汇聚订阅里自带的完整链接
 * @property {string} [address]     优选入口（IP/域名；IPv6 不带方括号）
 * @property {number} [port]
 * @property {string} [path]        完整 WS 路径（含 query，已含 /video/<密文> 链式或 ?ed=2560）
 * @property {string} [chain]       链式代理摘要，如 'sstp://vpn@host:1707'（仅展示，密码不在此）
 * @property {string} [link]        origin='link' 时的原始节点链接（vless:// vmess:// trojan:// ss:// …）
 * @property {string[]} [tags]
 */

/**
 * 分配后的节点。host 同时用作 TLS SNI 与 WS Host/gRPC authority。
 * @typedef {NodeSpec & {host: string}} ResolvedNode
 */

/**
 * 与客户端无关的"代理描述"，由 sub/params.js 从 ResolvedNode + Settings 生成，所有渲染器共用。
 * @typedef {Object} ProxyDescriptor
 * @property {string} name
 * @property {'vless'|'trojan'|'ss'} type
 * @property {string} server
 * @property {number} port
 * @property {string} uuid          vless=uuid, trojan=password, ss=password
 * @property {boolean} tls
 * @property {string} sni
 * @property {string} host          Host 头 / grpc authority
 * @property {'ws'|'grpc'|'xhttp'} network
 * @property {string} path          ws/xhttp 路径；grpc 为 serviceName
 * @property {string} [grpcMode]
 * @property {string} fingerprint
 * @property {string[]} alpn
 * @property {boolean} skipCertVerify
 * @property {{dns:string, sni:string}|null} ech
 * @property {string|null} tlsFragment
 * @property {{method:string}|null} ss
 * @property {boolean} udp
 * @property {object|null} xhttpExtra
 */

/**
 * 订阅请求上下文（由 app.js 组装后传给渲染层）。
 * @typedef {Object} SubContext
 * @property {string} uuid
 * @property {import('./control/settings.js').Settings} settings
 * @property {number} now
 * @property {string} requestUrl       完整订阅请求 URL（供 Surge MANAGED-CONFIG 等回填）
 * @property {string} subName
 */

export {};
