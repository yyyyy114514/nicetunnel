# nicetunnel 后台 API 契约

前缀 `/admin/api/`。所有响应 `application/json; charset=utf-8`，错误统一 `{ok:false, error:"中文短句", code:"xxx"}` + 合适状态码。
成功 `{ok:true, ...}`。UI 与 API 的唯一接口，改动须同步本文件。

## 1. 鉴权

- 登录：`POST /login`，表单或 JSON `{password}`。成功 → `Set-Cookie: auth=<md5md5(UA+KEY+ADMIN)>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`，JSON 请求返回 `{ok:true}`，表单请求 302 `/admin`。
- 退出：`GET /logout` 清 cookie，302 `/login`。
- 未登录访问 `/admin*`：页面请求 302 `/login`；`/admin/api/*` 返回 401 `{ok:false,code:"unauthorized"}`。
- 登录节流：同一 IP 10 分钟内失败 ≥5 次 → 429 `{code:"throttled", retryAfter}`（isolate 内近似）。
- 变更类（POST/PUT/DELETE）必须带 `X-Requested-With: nt`，否则 403 `{code:"csrf"}`。
- 未设置管理员密码（ADMIN 等变量全空）时：后台拒绝访问并提示在环境变量设置 `ADMIN`。

## 2. 接口

### GET /admin/api/state
一次拉取后台所需全部数据（减少 KV 读取与请求数）。
```json
{
  "ok": true,
  "version": "1.0.0",
  "role": "main",
  "now": 1730000000000,
  "uuid": "…", "subUrl": "https://vp.xxx/sub?token=…", "host": "vp.xxx",
  "settings": { "...Settings(publicSettings：密钥脱敏)" },
  "accounts": [ { "id","name","hosts","role","enabled","weight","limit","note","auth":{"accountId","hasToken","hasKey","email"} } ],
  "usage": { "day","ts","accounts":{ "<id>":{used,workers,pages,rate,polledAt,ok,err} } },
  "pool": { "summary": {used,budget,remaining,total,hostsOk,hostsLow,hostsExhausted,hostsStale,resetAt},
            "hosts": [ {host,accountId,used,budget,remaining,weight,state,sharePct} ] },
  "kv": { "bound": true, "writesTodayEstimate": 12 },
  "rules": { "mode","lastRefreshAt","lists":[{url,ok,rules,at}] }
}
```

### PUT /admin/api/settings
Body：Settings 的**部分对象**（`applyPatch` 语义：深合并；`notify.telegram.botToken` 空串=保持）。返回 `{ok:true, settings}`（已脱敏）。校验失败 400 并给出字段路径 `{code:"invalid", fields:{"allocation.alpha":"必须在 0~3"}}`。

### GET /admin/api/accounts / PUT /admin/api/accounts
PUT body：`{accounts:[…], mode:"replace"|"merge"}`；auth 子字段空串=保留旧值。返回脱敏后的列表。

### POST /admin/api/accounts/import
Body：`{text:"…", format:"lines"|"usage_panel_json", mode:"merge"|"replace", dryRun:true|false}`。
返回 `{ok, accounts:[…脱敏], errors:[…], added, updated}`；`dryRun` 不落库。

### POST /admin/api/usage/poll
Body：`{ids?:[…]}`（缺省=全部，上限 `batchSize`）。立即轮询并**写入快照**（计入 KV 写预算，服务端限频：1 分钟 1 次）。返回新 `usage` 与 `pool`。

### POST /admin/api/preview
Body：`{format:"b64"|"clash"|"sb"|"surge"|"raw", ip?:"1.2.3.4", settings?:{…覆盖用的临时设置}}`。
用当前（或临时）设置生成订阅但**不计入日志/限频**。返回 `{ok, nodes:[{name,origin,address,port,host,chain?}], summary, rawLength, body(前 20KB), hostShare:{host:count}}`。

### POST /admin/api/test-source
Body：`{kind:"custom"|"cidr", text?:"…"}`。服务端抓取并解析优选来源，返回 `{ok, count, sample:[…20], warnings:[…], ms}`。

### GET /admin/api/logs ; POST /admin/api/logs/clear
`logs?limit=200&type=` → `{ok, logs:[{t,type,ip,ua,loc,msg}]}`。

### POST /admin/api/notify/test
发送一条 TG 测试消息；返回 `{ok, sent:true}` 或错误详情（不含 token）。

### GET /admin/api/export ; POST /admin/api/import
export 返回 `{ok, data:{v:2, settings(含密钥,仅导出时), accounts(含密钥)}}`；import 校验后整体覆盖（`dryRun` 支持）。

### POST /admin/api/rules/refresh
手动刷新规则（一次最多处理 `maxLists`，默认 3；服务端限频）。返回 `{updated, pending, errors}`。

### POST /admin/api/reset
Body：`{scope:"settings"|"usage"|"logs"|"all", confirm:"RESET"}`。

### 兼容旧版接口（保持 edt 前端/脚本可用）
- `GET /admin/check?socks5=…|http=…|proxyip=…|turn=…|sstp=…` → 代理检查（转发 `env.CHECK_PROXY_URL` 或内置 CheckSocks5 协议，返回 JSON）
- `GET /admin/getADDAPI?url=…` → 校验优选 API，返回 `{success, data:[…]}`
- `GET /admin/locations`（可选）
- `GET /admin/config.json`、`POST /admin/config.json` 仅在迁移期保留（读返回新 settings 的旧式视图；写返回 410）

## 3. 页面

| 路径 | 说明 |
|---|---|
| `/` | 伪装页（`camouflage.url` / nginx / 1101）；已登录不跳转 |
| `/login` | 登录页（自包含 HTML） |
| `/admin` | 后台单页（自包含 HTML） |
| `/sub?token=…` | 订阅 |
| `/<KEY>` | 快速订阅，302 到 `/sub?token=…`（KEY 为 env.KEY） |
| `/version` | `{version}`（需 `uuid` 参数时返回详细，同上游） |
| `/robots.txt` | `User-agent: *\nDisallow: /` |

## 4. AppContext（handler 公共入参）

```js
{
  request, url, env, executionCtx,        // 运行时
  now,                                    // 毫秒
  identity: { uuid, secretKey, adminPassword, subToken, host },
  store,                                  // control/store.js 暴露的 getSettings/saveSettings/getAccounts/…
  fetchFn,                                // 默认 fetch，可注入
  ip, ua, loc,                            // 来自请求头 / request.cf
}
```

## 5. 后续新增接口（2026-10）

- `GET /admin/api/state` 新增字段：`checks:[{level:'warn'|'info', id, text}]`（配置自检）；`rules.ini:{url,fetchedAt,bytes,groups,rulesets,errors}`（已保存的转换配置）；`pool.hosts[]` 新增 `rate`（次/分）与 `pace`（节奏因子，null=未知/耗尽）。
- `GET /admin/api/netinfo`：访问者网络信息检测，返回 `{ip, prefix, country, region, city, asn, asOrganization, colo, httpProtocol, tlsVersion, isp, ispName, adaptiveIsp, adaptiveIspName, ua}`。
- `POST /admin/api/rules/ini/fetch`：Body `{url?, rebuild?}`。从远程 URL 获取转换配置并保存到 KV（校验像不像 INI；内容变化才写），变化时顺手刷新规则列表；10 秒限频。返回 `{ok, url, changed, bytes, groups, rulesets, errors, hash, rules:{updated,pending,errors}|null}`。
- `POST /admin/api/test-source` 新增 `kind`：
  - `best`：`{urls?, isp?}` 测试优选订阅 URL；
  - `regions`：`{urls?, regex?}` 测试地区路由列表，返回 `{count, regions:[{name,nodes}], entries, warnings, ms}`。
- 设置新增（`PUT /admin/api/settings`）：`preferred.best.*`、`preferred.regions.*`（`enabled urls regex kinds nameTemplate kindNames pickK stickyMinutes ttlSeconds refreshSeconds`）、`preferred.random.{aggregate,goodRatio,portBias}`、`allocation.{pace,paceMax}`、`usage.cycleMinutes`、`rules.iniAutoRefresh`；`sub.testIntervalMin` 默认 600。

## 6. 脚本接入（Bearer 鉴权）与账号接口

### 鉴权
除了浏览器登录（cookie），`/admin/api/*` 也接受请求头：

```
Authorization: Bearer <ADMIN 密码>
```

- 不需要 cookie，也**不需要** `X-Requested-With: nt`（Bearer 不依赖 cookie，不受 CSRF 影响）；浏览器 cookie 登录的变更类请求仍然需要这个头。
- 令牌错误返回 401；**同一 IP 连续错误 5 次后 429（`Retry-After`），锁定 10 分钟**（防止拿 API 暴力猜密码；计数在单个运行实例内近似）。
- 一定要用 HTTPS。令牌就是管理员密码，权限等同后台全部功能。

### POST /admin/api/accounts/upsert（新增或更新，幂等）
Body：
```json
{
  "accounts": [
    {"host": "vp2.example.com", "accountId": "0123456789abcdef0123456789abcdef", "apiToken": "cfut_xxx", "name": "二号"}
  ],
  "text": "vp3.example.com,0123456789abcdef0123456789abcdef,cfut_yyy,三号\n# 注释行",
  "overwrite": false,
  "poll": true
}
```
- `accounts` 和 `text` 可以同时给（至少一个）；单次最多 500 个。`text` 每行格式同批量导入：`域名,AccountID,APIToken[,名称]` 或 `域名,邮箱,GlobalAPIKey[,名称]`，分隔符可用 `, | Tab 空格`，`#` 开头是注释。
- 账号对象字段：`host`（或 `hosts` 数组/逗号分隔）、`accountId`、`apiToken`、`email`、`globalKey`、`name`、`role`（`node`/`main`/`off`）、`enabled`、`weight`、`limit`、`note`。凭据字段也可以放在 `auth` 对象里。
- 按 **id / host / accountId / email** 匹配已有账号：匹配上就是更新，否则新增。更新时：空的凭据字段**保留旧值**；`hosts` 取并集；`name` 非空才覆盖；`role/enabled/weight/limit/note` 默认**不覆盖**，`overwrite:true` 才覆盖。
- `poll:true`：保存后立刻轮询涉及的账号（≤40 个），返回每个账号能否取到用量，用来马上发现令牌无效 / 权限不足（令牌需要 Account Analytics: Read）。5 秒内不能重复 `poll`（429）。
- 返回：`{ok, added, updated, total, parseErrors:[…], accounts:[脱敏后的涉及账号], polled?:[{id,host,ok,used,error?,kind?}]}`。**响应里永远没有令牌明文**。

### POST /admin/api/accounts/delete
Body：`{"hosts":["vp2.example.com"], "ids":["a1b2c3"]}`（至少给一个；host 会规整：去协议 / 路径 / 端口、小写）。返回 `{ok, removed, total}`；重复删除不报错（`removed:0`）。

### 其它已有接口（同样可用 Bearer）
`GET /admin/api/accounts`（脱敏列表）、`PUT /admin/api/accounts`（整体替换/合并）、`POST /admin/api/accounts/import`（批量导入，**注意 `dryRun` 默认 true**）、`POST /admin/api/usage/poll`、`GET /admin/api/state`。

### curl 示例
```bash
curl -sS https://主站域名/admin/api/accounts/upsert \
  -H "Authorization: Bearer $NT_PASSWORD" -H "Content-Type: application/json" \
  -d '{"text":"vp2.example.com,0123456789abcdef0123456789abcdef,cfut_xxx,二号","poll":true}'
```

### 命令行脚本
`scripts/nt-accounts.mjs`（零依赖，Node 18+）封装了上面的接口：
```bash
export NT_URL=https://主站域名 NT_PASSWORD=你的管理员密码
node scripts/nt-accounts.mjs add --file accounts.txt --poll     # 批量新增/更新并验证令牌
node scripts/nt-accounts.mjs list                               # 列出（不显示令牌）
node scripts/nt-accounts.mjs delete --host vp2.example.com      # 按域名删除
```
退出码：0 成功；1 参数/网络/鉴权错误；2 提交成功但 `--poll` 发现有账号令牌无效。
