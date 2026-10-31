# nicetunnel 设计文档（契约）

> 本文件是并行开发的唯一依据。改契约必须同步修改本文件与 `src/types.js`。
> 规则：**不在热路径写 KV；每个订阅请求只消耗 1 次 Worker 请求；CPU 预算 10ms。**

## 1. 背景与目标

用户有 20+ 个 Cloudflare 免费账号，每个账号单独部署一份节点站点（Pages，域名 vp2…vp25），全部使用相同 UUID；
另有一个主站（vp.xxx，持有 KV）负责订阅、后台。所有用户共用同一个订阅链接，客户端约每 10 分钟刷新一次。
另外有 gate 项目（GitHub Actions 每 10 分钟刷新 VPN Gate 的 SSTP 住宅节点，发布 `nodes.txt`）。

要解决的问题：

1. 上游 edgetunnel 的节点分配只做随机打乱，**不看各账号剩余额度** → 前面的号耗尽后不会转移到有额度的号。
2. **控制面浪费额度**：每次订阅请求都触发 CF API(/accounts + /graphql)、KV 读写、整份日志读写、现拉 CIDR、回调外部 SUBAPI。
3. 随机优选质量差：每次刷新全部重新随机，客户端 url-test 结果每次作废；CIDR 每次现拉。
4. 同时要"优质(自定义/gate)"与"兜底(随机优选)"两组节点并存。
5. 订阅转换文件（INI）要继续沿用，但不再依赖第三方 SUBAPI。

目标：额度利用率最高、体验好；`edt` 已有功能一个不少；订阅 URL/token 与现网一致。

## 2. Cloudflare 免费版约束（官方文档已核实）

| 项目 | 限制 | 设计影响 |
|---|---|---|
| Workers+Pages Functions 请求 | 10 万/天，UTC 0 点重置，二者共用 | 每个号的真实容量 |
| KV 写 | **1000/天**；读 10 万/天 | 热路径零写入；快照限频写 |
| 子请求 | 50 次外部 + 1000 次 CF 服务调用 / 次；Cache API 与 fetch 共用 50 | 轮询批大小 ≤45；少用 Cache API |
| CPU | **10 ms/请求，10 ms/Cron 触发** | 禁止逐行处理大文本；Cron 每次只做一小块 |
| 并发连接 | 单次调用最多 6 个并行等待 | 轮询并发上限 6 |
| Pages | 文档未提 Cron | 无 Cron 时用懒刷新(SWR) |

## 3. 总体架构

单一代码库 → `scripts/build.mjs` 打成全量包 `dist/_worker.js` 与纯节点包 `dist/_worker.node.js`（Workers / Pages 均可）。

```
              ┌──────────── 用户客户端 (Clash / v2rayN / Shadowrocket …) ────────────┐
              │  订阅: https://vp.xxx/sub?token=…            代理: WS → vpN.xxx        │
              └───────────────┬───────────────────────────────────────┬───────────────┘
                              │ 1 次请求/次刷新                         │ 1 次请求/条连接
                  ┌───────────▼──────────┐                  ┌─────────▼──────────┐
                  │  main（有 KV）        │                  │  node（Pages，无 KV）│  ×N 个号
                  │  控制面 + 数据面      │                  │  仅数据面 + 伪装页   │
                  │  /sub /admin /login   │                  └────────────────────┘
                  │  cron: 轮询额度/刷新  │
                  └───────────────────────┘
```

### 3.1 角色判定（`src/role.js`）

- `env.MODE` = `main` | `node` | `auto`（默认）。
- `auto`：`env.KV` 存在且有 `get` → `main`；否则 `node`。
- 两种角色都先走**数据面分发**（与上游一致，保证协议兼容）：
  - `Upgrade: websocket` → `parseProxyParams` + `handleWebSocket`
  - `POST` 且路径不是 `admin/…` 也不是 `login` → gRPC（content-type `application/grpc` 且无本机标识）或 XHTTP
  - 其余请求：`node` → 只回伪装页；`main` → 进入控制面路由。
- 必须有 UUID 才能工作：`env.UUID`（合法 v4）优先；否则由 `env.ADMIN|admin|PASSWORD|password|pswd|TOKEN|KEY|UUID|uuid` + `env.KEY` 经 `md5md5` 推导（与上游完全一致，见 `src/control/identity.js`）。

### 3.2 身份与 token（兼容现网）

```
adminPassword = ADMIN||admin||PASSWORD||password||pswd||TOKEN||KEY||UUID||uuid
secretKey     = env.KEY || '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改'
userIDMD5     = md5md5(adminPassword + secretKey)
uuid          = (env.UUID 合法 v4) ? env.UUID.toLowerCase()
              : [m.slice(0,8), m.slice(8,12), '4'+m.slice(13,16), '8'+m.slice(17,20), m.slice(20)].join('-')
tokenHost     = env.HOST 首个(去协议/路径/端口) || 请求域名
subToken      = md5md5(tokenHost + uuid)          // 与上游算法一致（见 test/md5.test.mjs）
authCookie    = md5md5(UA + secretKey + adminPassword)   // 名称 'auth'，HttpOnly Secure SameSite=Lax 86400s
```

### 3.3 KV 键与缓存

| KV 键 | 内容 | 写入时机 |
|---|---|---|
| `nt.settings` | Settings v2（JSON） | 管理员保存 / 首次迁移 |
| `nt.accounts` | `Account[]` | 管理员保存 |
| `nt.usage` | `UsageSnapshot` | Cron/懒刷新，**限频**（≥ `usage.minWriteIntervalMinutes` 且有显著变化或跨日） |
| `nt.cidr.<isp>` | CIDR 文本 | Cron 每日 |
| `nt.rules.list.<hash(url)>` | 规则列表规范化文本 | Cron，每 tick 刷 1 个 |
| `nt.rules.<fmt>.<iniHash>` | 拼装好的规则块（clash/surge/singbox） | 列表变化时 |
| `nt.log` | 日志环形缓冲 | 批量限频 |
| `nt.meta` | `{migratedAt, lastTick, …}` | 极少 |
| 旧键 `config.json` `tg.json` `cf.json` `ADD.txt` `log.json` | edt 遗留 | **只读**，首次迁移用 |

进程内缓存（isolate 内存，带 TTL，可注入时钟）：settings 30s、accounts 30s、usage 20s、规则块 10min、gate/自定义源 `refreshSeconds`(SWR)。

### 3.4 订阅请求流程（`GET /sub`，目标：1 请求、≤4 次 KV 读且多数命中内存、≤1 个外部 fetch 且多数命中缓存）

1. 校验 token（`subToken`）或 `/<KEY>` 快速订阅 → 302 到 `/sub?token=…`。失败 → 伪装页。
2. 限速：同一 IP 每分钟 > `sub.rateLimitPerMinute` → 429（isolate 内近似）。
3. 取 settings / accounts / usage / 规则块（均走缓存）。若 `usage.lazyRefresh` 且快照过期且无 Cron → `ctx.waitUntil(refresh)`。
4. 取节点候选：`sources.getCustomEntries`(缓存+SWR) + `pool.buildRandomNodes`(无状态确定性) → `NodeSpec[]`。
5. `allocator.buildHostPool` → `allocator.allocateHosts`（种子=客户端 IP 前缀 + 时间窗）→ `ResolvedNode[]`。
6. 渲染：`sub.renderSubscription({format, nodes, ctx, rules, iniModel})`。
7. 响应头：`Subscription-Userinfo`(号池总额度/已用/重置时间)、`Profile-Update-Interval`、`Content-Disposition`、`Cache-Control: no-store`。
8. 异步：按配置记日志/通知（限频），**不**写 KV 热路径。

格式判定（与上游一致）：显式参数 `b64|base64`→mixed(base64)、`clash`、`sb|singbox`、`surge`；否则按 UA（clash/mihomo/stash/verge→clash；sing-box/sfa/sfi/karing/hiddify→singbox；surge/loon→surge；其余→mixed base64；浏览器 UA→明文）。

### 3.5 Cron（`scheduled`，仅 Workers）

- `*/5 * * * *`：`usage.pollBatch`（≤batchSize 个号，按最久未更新优先）→ 限频写 `nt.usage`；必要时发 TG 告警。
- 每 tick 额外做**一小块**维护（轮转）：刷新 1 个规则列表 / 1 个 ISP 的 CIDR（CPU 约束）。
- `event.cron` 可区分任务；所有任务必须在 10ms CPU 内完成（网络等待不计 CPU）。

## 4. 模块契约

所有控制面模块：纯 ESM、零依赖、无顶层副作用；时间/随机/网络/KV 均通过参数注入，便于 `node --test`。
命名：英文标识符 + 中文注释。每个模块自带 `test/<name>.test.mjs`。

### 4.1 `control/accounts.js`、`control/usage.js`、`control/allocator.js`（负责人：U）

```js
// accounts.js
normalizeAccounts(raw): Account[]                       // 校验/去重/补 id/规整 hosts，未知键丢弃
publicAccounts(accounts): object[]                      // 敏感字段脱敏（保留 email）
parseAccountsText(text): {accounts: Account[], errors: string[]}   // 批量导入，见下
importUsagePanelConfig(json): {accounts: Account[], errors: string[]}  // 旧用量面板 usage_config.json
mergeAccounts(current, incoming, {mode:'merge'|'replace'}): Account[]  // 空密文字段=保留旧值，按 id 或 host 匹配

// usage.js
utcDay(ms): string
async pollAccount(account, {fetchFn, now, timeoutMs=8000}): {ok, workers, pages, used, accountId?, error?, kind?}  // kind: 'auth'|'rate'|'net'|'api'
async pollBatch({accounts, snapshot, settings, now, fetchFn}): {snapshot, polled: [{id, ok, used, error?}], events: [{type, accountId, …}]}
shouldPersist(prev, next, settings, now): boolean
shouldLazyRefresh(snapshot, settings, now): boolean
emptySnapshot(now): UsageSnapshot

// allocator.js
effectiveRemaining(account, usage, settings, now): {limit, budget, used, remaining, state, weightFactor}
buildHostPool({settings, accounts, snapshot, now}): HostInfo[]
allocateHosts({pool, slotIds, settings, seed, now}): string[]       // 与 slotIds 等长；确定性
poolSummary(pool, settings, now): {used, budget, remaining, total, hostsOk, hostsLow, hostsExhausted, hostsStale, resetAt}
makeSeed({mode, ip, token, now, windowMinutes}): string
```

- **GraphQL**：POST `https://api.cloudflare.com/client/v4/graphql`，查询与 edt 一致（`pagesFunctionsInvocationsAdaptiveGroups` + `workersInvocationsAdaptive` 的 `sum{requests}`），时间窗 `datetime_geq` = 当日 UTC 0 点、`datetime_leq` = now。鉴权：Bearer apiToken，或 `X-AUTH-EMAIL/X-AUTH-KEY`。缺 accountId 时先 `GET /accounts` 并回填。
- **burn rate**：同日内两次成功轮询间隔 ≥1 分钟时 `rate = 0.5*rate + 0.5*Δused/Δmin`，Δused<0（异常）忽略。跨日清零。
- **有效剩余**：`budget = limit*(1-safetyMargin)`；`remaining = budget - used - rate*min(ageMin + horizonMinutes, 180)`。
  - `remaining <= floorRemaining` → `exhausted`，weight=0；`remaining < 0.15*budget` → `low`。
  - 轮询失败/过期(`age > staleMinutes`)→ `stale`，weight×0.5（用最后已知值）；从未轮询 → `unknown`，用 `hosts.unmanagedWeight × 受管主机剩余中位数`（无受管主机则 1）。
  - `weight = max(0,remaining)^alpha × account.weight`；`role!=='node'` 或 `!enabled` 的账号不进池。
- **分配**（加权 rendezvous hashing）：对每个 slot、每个 host：`score = -ln(hashUnit(seed|slotId|host)) / weight`，取最小。再按 `maxShare` 封顶：`cap = max(1, ceil(maxShare*N))`，超额的 slot 顺延到次优且未满的 host（按 slot 顺序，确定性）。全部 weight=0 时：取剩余最多的前 5 个 host 等权兜底。
- **种子**：`makeSeed` = `${mode}|${value}|${floor(now/windowMs)}`；`ip` 模式取 IPv4 /24、IPv6 /48 前缀；`none` 模式固定值。
- **质量指标测试**：大样本下各 host 占比 ≈ 权重占比（误差<10% 相对）；权重小幅变化时只有少量 slot 变化；耗尽 host 不被选；maxShare 生效；确定性。
- `parseAccountsText` 每行支持：`host,accountId,apiToken[,name]`、`host|accountId|apiToken`、`host,email,globalKey`（第二列含 `@` 即视为 email），分隔符 `, | Tab 空白`，`#` 开头为注释。accountId=32 位十六进制。

### 4.2 `lib/text.js`、`control/sources.js`、`control/pool.js`、`control/nodes.js`（负责人：S）

```js
// lib/text.js
splitList(text): string[]                 // 等价上游 整理成数组（空白/引号/逗号分隔，去空）
parseAddressLine(line): {address, port, remark}|null   // 上游同款正则：域名/IPv4/[IPv6] + 可选端口 + 可选 #备注
isIPv4(s) / isIPv6(s) / ipv4ToInt / intToIpv4 / cidrContains(cidr, ip)

// sources.js  —— 负责"自定义(优质)"来源
async loadCustomEntries({text, settings, fetchFn, now, cache, uuid}): {entries: CustomEntry[], warnings: string[], fetchedAt, stale}
//   cache 为注入的 Map 型缓存对象 {get,set}，实现 TTL=settings.preferred.custom.refreshSeconds + SWR（过期先返回旧值，后台刷新由调用方 waitUntil）
//   支持的输入行（与上游 请求优选API/本地订阅分支一致，**实现前必须通读上游 5970–6173 与 356–394 行，逐项保留**）：
//     地址行 addr[:port][#备注]；http(s) URL（返回文本地址列表/CSV/订阅/Clash YAML 等）；sub://host[?proxyip=true][#备注]；
//     带 `$socks5|http|https|turn|sstp://账号@主机:端口` 的链式备注；`*` 通配 → 随机字符；`?port=` 默认端口
//   单 URL 超时 3000ms、体积上限 2MB、失败保留旧缓存(≤24h)

// pool.js —— 负责"随机优选(兜底)"
cidrSourceUrl(isp, base): string
parseCidrList(text): string[]
evolveRandomPool({cidrs, settings, isp, now, count}): {ip, port, slot, gen}[]
//   **无状态确定性**：同一 (isp, windowIndex, slot) 在所有 isolate 得到相同结果，不依赖 KV。
//   slot i 在窗口 w 是否轮换：hashUnit(`rot|${i}|${w}`) < rotatePercent/100；IP = 由 (slot, 最近轮换代) 哈希出的 CIDR 内地址；
//   向前最多回溯 48 个窗口找最近轮换点，找不到则取初代。端口从 settings.preferred.random.ports 按 (slot,gen) 确定性选取。
//   命中 blacklist（IP 或 CIDR 前缀）则换盐重试（有界）。
buildRandomNodes({settings, cidrs, isp, uuid, now}): NodeSpec[]    // 名字 `${namePrefix}-${ISP中文}-NN`，含 "CF"

// nodes.js —— 合并
buildNodeSpecs({custom, random, settings, uuid, deps:{base64SecretEncode, parseChainAccount, defaultChainPort}}): NodeSpec[]
//   链式节点：path = `/video/${base64SecretEncode(JSON.stringify({type, ...parseChainAccount(参数, defaultChainPort(type))}), uuid)}` + (zeroRtt ? '?ed=2560' : '')
//   普通节点：path = 完整节点路径(见 DESIGN §5.1)
//   name 全局唯一；按 maxNodes 截断；按 (address,port,path) 去重
```

- 默认 CIDR 来源与上游一致（`raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR.txt` 及 `CF-CIDR/<isp>.txt`，具体拼接以上游 5870–5890 行为准）；`settings.preferred.random.cidrBase` 非空则覆盖。CIDR 获取失败回退 `104.16.0.0/13`。
- 随机优选质量策略：稳定池 + 渐进轮换（默认每窗口换 25%）+ ISP 感知 + 端口可配 + 黑名单。

### 4.3 `control/sub/*`（负责人：G；singbox 由后续批次完成）

```js
// ini.js
parseIni(text): IniModel   // {rulesets:[{group, source:{type:'url'|'inline', value}}], groups:[{name,type,members:[{kind:'ref'|'regex',value}],test?:{url,interval,timeout,tolerance}}], flags:{enableRuleGenerator, overwriteOriginalRules}, errors}
iniHash(text): string
// groups.js
resolveGroups(ini, proxyNames): ResolvedGroup[]   // 展开 []引用 与正则；空 select 组回退 DIRECT；检测环引用
// params.js  —— **所有渲染器共用的节点参数映射**（等价上游 订阅链接构造 404–456 行与 5795 行）
toProxyDescriptor(node: ResolvedNode, ctx: SubContext): ProxyDescriptor
// links.js
renderMixedLinks(nodes, ctx): string                // 明文换行分隔的 vless:// trojan:// ss:// …
renderMixedBase64(nodes, ctx): string
// linkparse.js
parseNodeLink(link): ProxyDescriptor-like|null      // vless/vmess/trojan/ss（hysteria2/tuic 尽力而为）
// rules.js
refreshRuleset({ini, kv, fetchFn, now, maxLists=1}): Promise<{updated:string[], pending:number, errors:string[]}>
getRulesBlock({ini, format, kv|preloaded}): string|null
// clash.js / surge.js
renderClash({nodes, ini, rulesBlock, ctx}): string  // YAML
renderSurge({nodes, ini, rulesBlock, ctx}): string
// index.js
renderSubscription({format, nodes, ctx, ini, rules}): {body, contentType, extraHeaders}
```

- INI 语义对齐 subconverter：`ruleset=组名,URL|[]GEOIP,CN|[]FINAL`；`custom_proxy_group=名`类型`成员…`[测速URL`间隔,超时,容差]`；成员 `[]名` 为引用，其它按**正则**匹配节点名（多个成员为并集）；类型 `select|url-test|fallback|load-balance`。
- Clash 输出必须是**合法 YAML**，且：代理名唯一；每个组的 `proxies` 非空；规则里引用的组都存在；`url-test` 用 `url/interval/tolerance`；ECH 用 `ech-opts`；0-RTT 用 `ws-opts.max-early-data` + `early-data-header-name`；`client-fingerprint`；gRPC 用 `grpc-opts`；XHTTP 用 mihomo 的 `xhttp-opts`（若版本不支持则注明）。
- **规则展开(expand)是默认**：规则列表由 Cron 每次刷新 1 个、规范化为 `TYPE,value[,no-resolve]`，并**预先追加 `,组名`**；拼装块用原生 `split/join/replace`（禁止逐行 JS 回调）。`provider` 模式输出 `rule-providers` + `RULE-SET`，无服务器 CPU。块缺失时自动回退 `provider` 模式并在响应头 `X-NT-Rules: provider-fallback`。
- 订阅 CPU 目标：渲染 80 个节点 + 500KB 规则块 ≤ 5ms（用 `performance.now()` 在 Node 里粗测，作为回归基线）。

### 4.4 `control/auth.js`、`control/notify.js`、`control/logs.js`、`admin/api.js`（负责人：A）

见 `docs/API.md`。要点：

- 鉴权 cookie 与上游一致；登录失败节流（每 IP 5 次/10 分钟，isolate 内）；变更类接口要求头 `X-Requested-With: nt`（CSRF 防护）。
- 日志：内存环形缓冲 + 批量限频写 `nt.log`（`flushMinutes`）；`log.subFetch=false` 时订阅拉取不记录。
- Telegram：`sendTelegram({settings, text, fetchFn, now, state})` 带 `minIntervalSeconds` 限频与同类事件去重；失败吞掉异常。
- 所有 handler 签名：`async (ctx: AppContext) => Response`，`AppContext = {request, url, env, executionCtx, settings, store, now, uuid, secretKey, adminPassword, …}`，便于测试时注入。

### 4.5 `admin/ui.js`（负责人：I）

导出 `adminHtml()`、`loginHtml()` 两个函数，返回完整自包含 HTML（内联 CSS/JS，**无外部资源**，因国内网络访问不了 CDN）。
要求见 §7。

### 4.6 `control/store.js`（负责人：Lead）—— 其他模块只通过它访问 KV

```js
createStore({kv, now, memo?}) → {
  kvBound: boolean,
  getSettings(): Promise<Settings>            // 30s 内存缓存；首次无 nt.settings 时自动 importLegacyEdt 并写入
  saveSettings(s): Promise<void>
  getAccounts(): Promise<Account[]>; saveAccounts(a): Promise<void>
  getUsage(): Promise<UsageSnapshot>; saveUsage(u, {force}): Promise<boolean>   // 内部再次限频，返回是否真的写了
  getLogs(): Promise<object[]>; appendLog(entry): void (内存缓冲); flushLogs({force}): Promise<boolean>; clearLogs(): Promise<void>
  getJson(key, ttlMs), putJson(key, val), getText(key, ttlMs), putText(key, val)   // 通用，计入写预算
  writesToday(): number                       // isolate 内估计值
  invalidate(key?)
}
```

### 4.7 订阅管线（负责人：Lead，`control/pipeline.js`）

`buildSubscription({store, settings, identity, request, now, fetchFn, overrides?, format?, ip?}) → {body, contentType, headers, nodes, summary, hostShare}`。
后台预览（`/admin/api/preview`）通过注入的 `deps.buildSubscription` 调用它，admin 模块不要直接 import 分配/渲染模块。

## 5. 订阅内容细则

### 5.1 完整节点路径（普通节点）

等价上游 5780–5790：`PATH` + 反代参数（`proxyip=…` 或 `socks5=…` 等，按 `settings.proxy`）+ query + `ed=2560`(zeroRtt)。链式节点使用 `/video/<密文>`，忽略 PATH。随机路径开启时，渲染前把 PATH 部分替换为上游 `随机路径()` 同款假路径（实现需通读上游 5417 行）。

### 5.2 节点命名与分组

- 优质(custom)：保留来源备注（gate 为 `日本-住宅-01` 含"住宅"）；无备注用 `优质-<address>`。
- 兜底(random)：`CF-<官方|电信|联通|移动>-NN`，含"CF"。
- 命名与承载域名 host 无关，**保证刷新后同名节点在客户端里仍是同一条目**。

### 5.3 响应头

`Subscription-Userinfo: upload=0; download=<号池已用>; total=<号池预算>; expire=<下一个UTC零点秒>`；`Profile-Update-Interval: <updateHours>`；`Profile-Web-Page-Url`(后台地址)。

## 6. 兼容性清单（上游已有功能，一个都不能少）

协议 VLESS/Trojan/SS；传输 WS/gRPC(gun,multi)/XHTTP；TLS、ECH、TLS 分片(Shadowrocket/Happ)、0-RTT、指纹、ALPN、跳过证书验证、随机路径；
反代 PROXYIP / SOCKS5(全局+白名单) / HTTP / HTTPS / TURN / SSTP / Trojan fallback；
订阅 mixed/Clash/Sing-box/Surge、`sub://` 汇聚、BEST_SUB 优选订阅生成器、ADD.txt、优选 API、UDP/XUDP/TLS13/类型标注/排序/emoji/展开规则；
后台 登录/配置/Telegram/用量/日志/代理检查(`admin/check`)/优选 API 校验(`admin/getADDAPI`)/`locations`；
`version` 接口、`robots.txt`、伪装页(nginx/1101/任意 URL)、`/<KEY>` 快速订阅、`http→https` 跳转。

## 7. 前端要求（后台 UI）

自包含单页（无框架、无外部资源）、中文、响应式（手机优先）、深浅色自适应、简洁美观；
页面：概览（号池额度环/条形图、各 host 状态与占比、订阅链接一键复制）、账号（表格+批量导入）、优选（优质/兜底两组配置与预览）、
订阅与规则（INI、模式）、节点参数（协议/传输/ECH/路径…）、通知与日志、高级。"小白模式"隐藏高级项。

## 8. 开发约束（所有人）

- 只改自己负责的文件；需要改别人的契约就在报告里写明，不要擅自改。
- 不 `git commit/push`；不 `npm install`（网络被封，也不需要）。
- 测试：`cd /home/claude/nicetunnel && npm test` 必须全绿；测试不得访问网络，网络用注入的假 `fetchFn`。
- 遇到"上游行为不确定"：**先读 `/home/claude/cmliu/edgetunnel/_worker.js` 对应行**，以代码为准；仍不确定就在报告里标"未确认"，不要编造。
- 热路径函数避免大对象 `JSON.stringify`/逐行回调；缓存解析结果。
- 报告格式：完成的文件清单 + 测试结果 + 与契约不一致之处 + 未确认项。

## 9. 后续新增（与 §3–§5 有出入时，以本节为准）

### 9.1 额度分配（`allocator.js`）
- 权重 = `max(0, 有效剩余)^alpha × 节奏因子 × account.weight`。
- **节奏因子** `paceFactor`：`有效剩余 / (消耗速度 × 距下一个 UTC 0 点的分钟数)`，夹在 `[1/paceMax, paceMax]`（默认 4）。大于 1：照现在的速度到重置还有剩余 → 加权；小于 1：会提前耗尽 → 降权；没有消耗数据按上限。目标是所有号在重置前同时用到预算。`allocation.pace=false` 可关闭。
- `maxShare` 默认 0.25；每个 slot/host 只做整数配对哈希（`rand.pairUnit`），热路径无字符串哈希。

### 9.2 用量轮询（`usage.js` / `usage-core.js` / `store.js`）
- 每个账号至少每 `usage.cycleMinutes`（默认 15）轮询一次：`autoBatchSize` 按账号数与触发间隔自动放大批量（上限由 45 个子请求预算决定）。
- 快照分"已落盘 `persistedUsage`"与"本实例未落盘 `localUsage`"：`shouldPersist` 对比已落盘版本，只要有账号出现新的轮询结果（`triedAt/polledAt` 变化）且超过 `minWriteIntervalMinutes` 就写；写前重新读 KV，用 `mergeSnapshots` 逐账号取较新者，多个实例并发轮询不互相覆盖。
- `usage-core.js` 放 `usage` 与 `allocator` 共用的基础函数，避免循环依赖（单文件打包要求无环）。

### 9.3 节点来源
| 来源 | 模块 | 说明 |
|---|---|---|
| 优质 | `sources.js` | 自定义地址 / 链接 / `sub://` / 链式备注 `$sstp://…` |
| 优选订阅 | `bestfeed.js` | 多个优选 URL（IP 列表 / 测速 CSV / 生成器）；URL 里 `{isp}` 按访问者运营商替换；Cron 刷新 → KV `nt.best.<isp>`，热路径只读 |
| 兜底随机 | `pool.js` | 无状态确定性；`goodRatio` 取自优选池已知可用地址；每个节点不同 /24；`portBias` 倾向 443 |
| 地区路由 | `regions.js` + `dataplane/pool-route.js` | 见 9.4 |

三者可同时启用，互相独立。

### 9.4 地区路由（可选，默认关闭）
- 适合节点寿命很短、列表高频变化的来源（如 VPN Gate）。订阅里每个"地区+类型"一个条目，名字如 `【家宽】日本`（`nameTemplate` / `kindNames` 可改；顺序固定，不随节点数变化）。
- 条目路径是 `/video/<密文>`，密文是 `{type:'pool', u:[列表URL], r:地区正则, region, kind, i, k, ttl, sticky}`。节点站点收到连接后读取列表（isolate 内存缓存，基线 180 秒 + URL 级固定抖动；**内容指纹不变时 TTL 逐次翻倍，上限 8 倍≈24 分钟**；失败退避，有旧值时 180s→…→15 分钟，无旧值时 15s→…，避免新 isolate 一次抖动就锁死；旧值最长兜底 6 小时），在前 `k` 台（默认 10）里用会合哈希选一台，改写成上游认识的 `{type, hostname, port, username, password}` 链式路径。
- **健康感知**：`reportChainResult(ok, host, port)` 由 edt-core 的拨号成功/失败回调写入 isolate 级 `health` 表；`pick()` 把候选分成「近期成功（10 分钟内）> 未知 > 近期失败（5 分钟冷却）」，只在当前最高优先级那一层里选，不会再落回已知失败节点。前 k 台全在冷却期时把窗口扩到 2k。层内先按协议质量（`socks5`/`http` > `https` > `sstp`/`turn`）稳定排序，再保持列表原有延迟顺序。
- **故障转移**：`resolvePoolRoute` 额外返回 `candidates`（选中的那台排第一，最多 4 台），adapter 转成 `反代上下文.代理候选`；数据面拨号失败时换下一台重试（`CHAIN_FAILOVER`，默认 1，0=关闭），换完仍失败才 `closeSocketQuietly(ws)`。非地区路由没有 `代理候选`，行为与上游逐字一致。
- **SSTP 竞速**（`chain-race@1`）：地区路由时，SSTP 分支同时拨当前候选与下一台未试过的 SSTP 候选，`Promise.any` 取先握手成功者，另一条关闭；胜者成为 `ctx代理参数`（成功由外层上报），输家最终失败时单独上报失败。两台都失败时按原故障转移继续。`CHAIN_RACE`（默认 2，1=关闭）。同一 Worker 请求内完成，不消耗额外请求额度。
- **SSTP 链路修正**（`sstp-keepalive@1`，补丁在 `scripts/assets/vendor/sstp-patches.json`，vendor 时按锚点应用）：应答 SSTP ECHO_REQUEST / PPP LCP Echo-Request（SoftEther 收不到应答约 10~20 秒断开会话）；CALL_DISCONNECT/ABORT、LCP Terminate 立即结束；数据读空闲超时 60 秒 → 5 分钟；SYN 遇 RST 立即失败、数据中遇 RST 立即结束；TCP 序号校验（重复/乱序段丢弃并重发 ACK）；接收窗口按可读流剩余空间通告（4MB 缓冲，读走后发窗口更新）；发送遵守对端窗口（在途为 0 时允许发一段兼作零窗口探测，60 秒无进展报错）；SYN 带 MSS=1400。
- 列表解析 `lib/pool-parse.js`：主站与节点共用；支持 `入口#名称$chain://…` 与无入口的纯链式行；地区由用户正则（第 1 组地区、第 2 组类型）提取，未配置则取名称里第一个 `- _ 空格 数字` 之前的部分。
- 约束：节点站点必须运行本项目的 `_worker.js`；已建立的上游连接在中途掉线时仍会断（只影响新连接的拨号失败）。

### 9.5 订阅渲染（`control/sub/`）
- 格式：mixed / base64 / Clash(mihomo) / Surge / sing-box，均原生生成，不依赖 SUBAPI；Quantumult X / Loon 回退通用订阅（响应头 `X-NT-Format-Fallback`）。
- `sub.testIntervalMin`（默认 600 秒）：INI 里写的测速间隔小于它时按它输出；Clash 测速组带 `lazy: true`。
- **随机优选聚合** `preferred.random.aggregate`（默认开）：CF 随机/优选 IP 节点只出现在测速类组（url-test / fallback / load-balance）里，不在 select 组里逐个列出；只有"至少被一个测速类组引用"的节点才会隐藏，一个 select 组隐藏后变空则保持原样。
- Clash 规则块在 Cron 侧预先缩进成 YAML 列表（`block.yaml`），热路径只做拼接（4 万条规则渲染约 1ms，免费版 CPU 上限 10ms）。

### 9.6 规则与转换配置（`rulesfeed.js`）
- KV 键：`nt.rules.ini`（转换配置文本）、`nt.rules.index`、`nt.rules.list.<hash>`、`nt.rules.<fmt>.<iniHash>`。
- `fetchAndSaveIni`：从远程 URL 获取转换配置，校验像不像 INI，内容变化才写 KV；之后订阅只读缓存，不连远程。`rules.iniAutoRefresh=false` 时 Cron 也不自动拉取。

### 9.7 配置自检（`selfcheck.js`）
纯函数 `selfCheck(...)` → `[{level:'warn'|'info', id, text}]`，由 `GET /admin/api/state` 的 `checks` 字段带出，后台概览顶部显示。覆盖：未绑 KV、主站域名混入分配池、没有节点域名、账号缺凭据、轮询失败、用量过期（可能没配 Cron）、测速下限为 0、更新间隔过短、地区路由/优选订阅未填 URL、转换配置未缓存、Telegram 配置不完整等。

### 9.8 构建（`scripts/build.mjs`）
零运行时依赖（Node 18+）按入口打包单文件 ESM（每个模块包进函数作用域；不支持循环依赖、副作用导入）。`src/index.js` 产出全量包 `_worker.js` / `nicetunnel.zip`；`src/node.js` 产出纯节点包 `_worker.node.js` / `nicetunnel-node.zip`，依赖图只包含数据面、身份推导及其直接依赖。默认使用 Terser 与低开销混淆，`--no-obfuscate` 关闭。

### 9.9 性能基线（Node，参考）
一次订阅请求约 1.4ms（70 个节点、25 个账号）；同一实例内 300 次订阅额外读 KV 为 0 次，新实例冷启动最多读 6 次，热路径写 KV 为 0。

## 10. 主站 ↔ 节点站点：数据面契约

目标：**升级主站时尽量不动节点站点**。节点只依赖下面这些，契约见 `src/dataplane/contract.js`（`DATAPLANE_VERSION`、`POOL_ROUTE_V`、`CAPS`）。

| 契约 | 内容 |
|---|---|
| 身份 | 节点只需要环境变量 `UUID`（与主站一致）。管理员密码缺省时回退取 `UUID`，节点不需要 `ADMIN`、不绑定 KV |
| WS 路径 | `/` + 反代参数（`proxyip= socks5= http= https= turn= sstp=`）+ `?ed=2560`（上游格式，由 `edt-core` 解析） |
| 链式路径 | `/video/<密文>`：UUID 加解密，明文 `{type, hostname, port, username, password}`（上游格式） |
| 地区路由路径 | `/video/<密文>`：明文 `{type:'pool', v, u, r, region, kind, i, k, ttl, sticky}`；**未知字段一律忽略** |
| `/version` 能力位 | `Caps` 里 `pool-route@1` = 认识地区路由路径；`chain-health@1` = 会按拨号结果做健康选路；`chain-failover@1` = 拨号失败会换候选重试（`CHAIN_FAILOVER`）。`sstp-keepalive@1` = SSTP 链路修正；`chain-race@1` = SSTP 竞速（`CHAIN_RACE`）。`Edition` 为 `full` 或 `node`（节点版）。旧节点缺对应位，主站可据此提示升级 |
| XHTTP 混淆头 | 由 UUID 派生（`getLocalMark`） |
| `GET /version?uuid=<UUID>` | 返回 `{Version, Dataplane, Caps, Edition}`，带 CORS；UUID 不对时与普通伪装页逐字节一致（不再带 CORS/no-store 等独有头） |
| 其它请求 | 一律伪装页，不做外部请求 |

向前兼容规则：
1. 主站新增能力优先用"可选字段"表达，旧节点忽略未知字段，不需要升级。
2. 只有确实需要节点配合的新行为，才提高对应版本号（`POOL_ROUTE_V` 或 `DATAPLANE_VERSION`）。节点遇到比自己支持更高的 `v` 时返回 503「节点站点版本过旧，请更新节点 _worker.js」，而不是静默连错。
3. 后台「账号 → 检测节点」在浏览器里直接请求各节点 `/version`，标出域名不可达、UUID 不符、数据面版本落后的节点（每个节点多 1 次请求，不占主站额度）。
4. 节点站点可部署全量包或纯节点包，两者数据面契约相同；旧版全量包也可继续运行，是否升级只由契约版本决定。

纯节点包的目的不是节省请求额度（额度按请求次数计算，与代码大小无关），也不是改变 TLS/WS 流量特征；它只减少节点上的无关主站代码与意外控制面暴露。`test/bundle.test.mjs` 对两种产物的普通节点响应、响应头、响应体及 `/version` 契约字段做一致性回归。
