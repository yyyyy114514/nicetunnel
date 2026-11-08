// 服务端拼 HTML 用的转义（属性值和文本都安全）。Telegram 通知另有只转义 & < > 的版本（notify.js），那是 Telegram 的要求。
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
