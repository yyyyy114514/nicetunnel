// 构建号：构建脚本（scripts/build.mjs）把下面的占位符换成"本次打包代码内容的短哈希"，
// 显示在后台左上角、/version 的 Build 字段、订阅响应头 X-NT-Build，用来确认线上跑的到底是哪一版。
// 源码/测试环境里保持占位符，显示为 dev。
export const BUILD_ID = '__NT_BUILD__';
export const buildLabel = () => (BUILD_ID.startsWith('__') ? 'dev' : BUILD_ID);
