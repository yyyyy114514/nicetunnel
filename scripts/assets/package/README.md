# site-status

轻量级站点状态监测页，部署在 Cloudflare Workers / Pages 上。

每 5 分钟定时检测一组站点，记录响应时间与可用率，生成一个自包含的状态页面；
历史数据存放在 KV 里，面板密码登录后可查看详情。

## 特性

- **定时检测**：Cron 触发器每 5 分钟跑一轮，检测目标在面板里维护。
- **状态页**：单文件静态页面，展示各目标的当前状态、响应时间与最近事件。
- **历史记录**：检测结果按天聚合写入 KV，免费额度内即可长期保存。
- **多实例**：可以只部署「上报实例」（无 KV，仅接收与展示），由主实例统一聚合。
- **无依赖构建**：一条命令产出可直接上传的发布包。

## 发布包内容

- `_worker.js`：应用主体（Workers / Pages 通用）。
- `index.html`、`favicon.svg`、`robots.txt`、`_headers`：状态页静态资源与响应头。
- `wrangler.toml`：Workers 部署配置示例。
- `DEPLOY.md`：部署步骤与环境变量说明。
- `CHANGELOG.md`：版本记录。
- `LICENSE`、`NOTICE.md`：许可与第三方声明。

## 本地构建

```bash
npm install
npm run build
```

产物位于 `dist/`。`npm run verify` 会比对源码与发布产物的对外响应是否一致。

许可信息见 `LICENSE` 与 `NOTICE.md`。
