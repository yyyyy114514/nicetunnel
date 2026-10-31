# NOTICE

nicetunnel 的数据面（协议处理、WS/gRPC/XHTTP 传输、TLS 客户端、SOCKS5/HTTP/HTTPS/TURN/SSTP 链式代理）
逐字复用自以下开源项目，按 **GNU GPL v2** 授权，本项目整体亦以 GPL-2.0 发布：

- [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) — 作者 cmliu 及贡献者
- [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel) — 原始项目，作者 zizifn
- 其 README 所列的其他致谢项目（3Kmfi6HP/EDtunnel、ToiCF/GrainTCP、Stanley-baby 等）

`src/dataplane/edt-core.js` 由 `scripts/vendor-edt.mjs` 从上游脚本自动生成，文件头记录了所用上游 commit。
订阅、后台、用量统计、额度分配等控制面代码为 nicetunnel 重新编写。

## 随产物分发的上游文件

`dist/_worker.js` 与 `dist/_worker.node.js` 的末尾附有一大段注释块（`scripts/assets/edt-trailer.txt`），
取自 https://github.com/cmliu/edgetunnel （GPL-2.0）发布文件的尾部，仅为注释，不参与运行；版权归原作者所有。
除该注释块外，发布包不再夹带上游仓库的 README / CHANGELOG / workflows 等文件。

`dist/nicetunnel.zip` 与 `dist/nicetunnel-node.zip` 只包含本项目的 `_worker.js`、许可与声明文件、
部署配置和静态门面资源。

## 特征码隐藏

构建时（`--style=edt`，默认）会把项目名、作者标识、协议名等字符串改成
`String.fromCharCode(...)` 运行时表达式，并把注释中的身份词换成中性说法，
使这些明文不出现在发布文件里；运行时取值与源码完全一致，行为不变。
