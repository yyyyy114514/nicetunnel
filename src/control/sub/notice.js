// 提示订阅：被封禁的专属链接再来拉订阅时，不只回一个 403（客户端一般只显示"更新失败"，用户不知道原因），
// 而是返回一份合法的配置，里面只有一个名字就是提示语的占位节点——用户在节点列表里一眼就能看到。
// 规则一律直连：不会因为这份配置把用户的网络整个搞断。浏览器打开则给一个提示页。

import { escHtml as esc } from '../../lib/html.js';
import { base64Utf8 as b64 } from './links.js';
/** 节点名里不能有换行、逗号、等号（Surge）、引号 */
const nodeName = (s) => String(s || '').replace(/[\r\n,="']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || '此链接已停用';

/**
 * @param {'mixed'|'base64'|'clash'|'singbox'|'surge'} format
 * @param {string} message 提示语
 * @returns {{body:string, contentType:string}}
 */
export function noticeConfig(format, message) {
  const name = '⛔ ' + nodeName(message);
  if (format === 'clash') {
    const yaml = [
      'mixed-port: 7890', 'allow-lan: false', 'mode: rule', 'log-level: info',
      'proxies:', `  - ${JSON.stringify({ name, type: 'socks5', server: '127.0.0.1', port: 1 })}`,
      'proxy-groups:', `  - ${JSON.stringify({ name: '订阅状态', type: 'select', proxies: [name, 'DIRECT'] })}`,
      'rules:', '  - MATCH,DIRECT', '',
    ].join('\n');
    return { body: yaml, contentType: 'text/yaml; charset=utf-8' };
  }
  if (format === 'singbox') {
    const cfg = {
      log: { level: 'info' },
      outbounds: [
        { type: 'selector', tag: '订阅状态', outbounds: [name, 'direct'] },
        { type: 'socks', tag: name, server: '127.0.0.1', server_port: 1 },
        { type: 'direct', tag: 'direct' },
      ],
      route: { final: 'direct' },
    };
    return { body: JSON.stringify(cfg, null, 2), contentType: 'application/json; charset=utf-8' };
  }
  if (format === 'surge') {
    const body = ['[General]', 'loglevel = notify', '', '[Proxy]', `${name} = socks5, 127.0.0.1, 1`, '', '[Proxy Group]', `订阅状态 = select, ${name}, DIRECT`, '', '[Rule]', 'FINAL,DIRECT', ''].join('\n');
    return { body, contentType: 'text/plain; charset=utf-8' };
  }
  const link = `vless://00000000-0000-4000-8000-000000000000@127.0.0.1:1?encryption=none&security=none&type=tcp#${encodeURIComponent(name)}`;
  return { body: format === 'mixed' ? link + '\n' : b64(link + '\n'), contentType: 'text/plain; charset=utf-8' };
}

/** 浏览器打开被封禁的链接时的提示页 */
export function noticeHtml({ siteName, message }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>链接已停用</title>
<style>:root{--bg:#f6f7fb;--card:#fff;--fg:#1d2433;--mut:#5c6378;--line:#e4e7ef}@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--card:#18181b;--fg:#ececef;--mut:#a0a0ab;--line:#2e2e34}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:480px;margin:18vh auto 0;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;text-align:center}
.icon{font-size:40px;line-height:1}h1{font-size:20px;margin:10px 0 6px}.mut{color:var(--mut);font-size:13px}</style></head>
<body><main><div class="card"><div class="icon">⛔</div><h1>${esc(message)}</h1><div class="mut">${esc(siteName)}</div></div></main></body></html>`;
}
