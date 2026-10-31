# nicetunnel

面向 Cloudflare Workers / Pages 的边缘流量调度与多账号配额管理工具。

同一个 `_worker.js` 可按环境自动切换两种角色：

- **控制端**：配合 KV 与定时触发器，提供配置、状态查看、内容下发和配额统计。
- **边缘端**：无需 KV，处理接入请求并提供轻量状态页面。

## 发布包内容

- `_worker.js`：经过特征码隐藏的单文件应用（保留注释与可读结构）。
- `wrangler.toml`：Workers 部署配置示例。
- `DEPLOY.md`：部署与环境变量说明。
- `CHANGELOG.md`：版本记录。
- `index.html`、`favicon.svg`、`robots.txt`、`_headers`：Pages 静态门面与安全响应头。
- `LICENSE`、`NOTICE.md`：许可与第三方声明。

## 本地构建

```bash
npm install
npm run build
```

产物位于 `dist/`。需要更小的体积时用 `npm run build -- --no-trailer`；排查构建问题时用 `npm run build -- --no-obfuscate`；`npm run verify` 会比对源码与发布产物的对外响应是否一致。

完整项目说明与配置项见源码仓库文档。许可信息见 `LICENSE` 和 `NOTICE.md`。
