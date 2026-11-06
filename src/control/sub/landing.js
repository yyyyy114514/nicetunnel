// 专属订阅的"落地页"：用户在浏览器里打开自己的订阅链接时看到的页面——各客户端一键导入、二维码、复制链接。
// 代理客户端拉同一个链接照常拿订阅（按 UA 区分，见 app.js）。页面自包含，不加载任何外部资源。
import { qrSvg } from '../../lib/qr.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** 各客户端的一键导入链接（只放格式确定的客户端） */
export function importLinks(subUrl, name = '', { home = false } = {}) {
  const u = encodeURIComponent(subUrl);
  const n = encodeURIComponent(name || '订阅');
  const homeLink = home ? [{ id: 'home', label: 'Clash 家宽', note: '住宅宽带出口（mihomo 1.19.25+）', href: `clash://install-config?url=${encodeURIComponent(subUrl + '&target=home')}&name=${encodeURIComponent((name || '订阅') + ' 家宽')}` }] : [];
  return [
    { id: 'clash', label: 'Clash 系', note: 'Clash Verge Rev / FlClash / Clash Meta for Android', href: `clash://install-config?url=${u}&name=${n}` },
    { id: 'singbox', label: 'sing-box', note: 'SFA / SFI / SFM（1.12 及以上）', href: `sing-box://import-remote-profile?url=${u}#${n}` },
    { id: 'shadowrocket', label: 'Shadowrocket', note: 'iOS 小火箭', href: `shadowrocket://add/sub://${b64(subUrl)}?remark=${n}` },
    { id: 'stash', label: 'Stash', note: 'iOS', href: `stash://install-config?url=${u}` },
    { id: 'surge', label: 'Surge', note: 'iOS / macOS', href: `surge:///install-config?url=${u}` },
    { id: 'hiddify', label: 'Hiddify', note: '全平台', href: `hiddify://import/${subUrl}#${n}` },
    ...homeLink,
  ];
}

// 页面脚本：复制链接；设置标识（只能一次，提交前再确认）。单独写成普通字符串，避免模板字符串把 \n 之类转义吃掉。
const PAGE_JS = String.raw`
document.getElementById('c').onclick=function(){var i=document.getElementById('u');var done=function(){document.getElementById('c').textContent='已复制'};if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(done,function(){i.select();document.execCommand('copy');done()})}else{i.select();document.execCommand('copy');done()}};
(function(){var b=document.getElementById('ls');if(!b)return;var m=document.getElementById('lm'),f=document.getElementById('lv');
f.onkeydown=function(e){if(e.key==='Enter')b.click()};
b.onclick=function(){var v=f.value.trim();if(!v){m.textContent='请填写内容';f.focus();return}
if(!confirm('确定把标识设置为「'+v+'」吗？\n只能设置一次，提交后不能自己修改。'))return;b.disabled=true;m.textContent='提交中…';
fetch('/sub/label'+location.search,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:v})}).then(function(r){return r.json()}).then(function(j){
if(j.ok){var s=document.getElementById('lb');s.textContent='标识已设置：'+j.label;s.className='card ok';setTimeout(function(){s.remove()},4000)}
else{m.textContent=j.error||'提交失败';b.disabled=false}}).catch(function(){m.textContent='网络错误，请稍后再试';b.disabled=false})}})();`;

/**
 * @param {{siteName:string, subUrl:string, name?:string, home?:boolean, labelSet?:boolean}} o
 * @returns {string}
 */
export function landingHtml({ siteName, subUrl, name = '', home = false, labelSet = false }) {
  const title = name ? `${name} 的订阅` : '我的订阅';
  let qr = '';
  try { qr = qrSvg(subUrl, { px: 5 }); } catch { qr = ''; }
  const buttons = importLinks(subUrl, name || siteName, { home }).map((l) => `<a class="btn" href="${esc(l.href)}"><b>${esc(l.label)}</b><span>${esc(l.note)}</span></a>`).join('');
  // 标识只在没设置时显示，放最上面
  const labelCard = labelSet ? '' : `<section class="card" id="lb"><div class="ttl">我的标识<span class="mut">方便管理员认出你，例如昵称或联系方式</span></div><div class="row"><input id="lv" maxlength="30" placeholder="最多 30 字" autocomplete="off"><button id="ls" type="button">提交</button></div><div class="mut" id="lm" style="margin-top:6px">只能设置一次，提交后不能自己修改</div></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--fg:#1d2433;--mut:#5c6378;--line:#e4e7ef;--pri:#5b5bf0;--okbg:#e9f8ef;--ok:#17803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--card:#18181b;--fg:#ececef;--mut:#a0a0ab;--line:#2e2e34;--pri:#5650d6;--okbg:#14261c;--ok:#3ecf8e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 40px}h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:16px}
.card.ok{background:var(--okbg);color:var(--ok);border-color:transparent;font-weight:600}
.ttl{font-weight:600;margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}.ttl .mut{font-weight:400}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.btn{display:flex;flex-direction:column;gap:2px;padding:12px;border:1px solid var(--line);border-radius:12px;text-decoration:none;color:var(--fg)}
.btn b{font-size:15px}.btn span{font-size:12px;color:var(--mut)}.btn:active,.btn:hover{border-color:var(--pri)}
.qr{display:flex;justify-content:center}.qr svg{width:220px;height:220px;max-width:100%;border-radius:8px}
.row{display:flex;gap:8px}input{flex:1;min-width:0;padding:10px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);font:13px ui-monospace,monospace}
#lv{font:15px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
button{padding:10px 16px;border:0;border-radius:10px;background:var(--pri);color:#fff;font:inherit;cursor:pointer;white-space:nowrap}button:disabled{opacity:.6;cursor:default}
ol{margin:6px 0 0;padding-left:20px}li{margin:2px 0}
.lay{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"imp" "qr" "cp"}
.a-imp{grid-area:imp}.a-qr{grid-area:qr}.a-cp{grid-area:cp}
@media (min-width:900px){
main{max-width:1080px;padding:32px 24px 48px}
.lay{grid-template-columns:minmax(0,1fr) 300px;grid-template-areas:"imp qr" "cp qr";column-gap:16px;align-items:start}
.grid{grid-template-columns:repeat(3,1fr)}.a-qr{height:calc(100% - 16px)}.a-qr .qr svg{width:240px;height:240px}
#lb .row{max-width:560px}
}
</style></head><body><main>
<h1>${esc(title)}</h1><div class="mut">${esc(siteName)} · 这条链接只给你一个人用，请不要分享</div>
${labelCard}
<div class="lay">
<section class="card a-imp"><div class="mut" style="margin-bottom:10px">已安装客户端：点一下直接导入</div><div class="grid">${buttons}</div></section>
${qr ? `<section class="card a-qr"><div class="mut" style="margin-bottom:10px">用另一台设备的客户端扫码导入</div><div class="qr">${qr}</div></section>` : ''}
<section class="card a-cp"><div class="mut" style="margin-bottom:8px">或者复制订阅链接，在客户端里手动添加</div><div class="row"><input id="u" readonly value="${esc(subUrl)}"><button id="c" type="button">复制</button></div>
<ol class="mut"><li>按钮没反应：说明没装这个客户端，或客户端不支持一键导入，用复制链接的方式添加。</li><li>客户端里记得定期"更新订阅"，节点会自动调整。</li></ol></section>
</div>
</main><script>${PAGE_JS}</script>
</body></html>`;
}
