// 后台页面：完整自包含 HTML（内联 CSS/JS，无任何外部资源——国内网络访问不了 CDN）。
// 客户端脚本写成普通函数，通过 Function.prototype.toString 内联进页面，免去手工转义。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f9;--bg2:#eceef5;--card:#ffffffcc;--card-s:#fff;--fg:#14161f;--mut:#6a7185;--line:#e2e5ee;--pri:#5b5bf0;--pri2:#8b5cf6;--pri-fg:#fff;--ok:#12a46a;--warn:#e08a00;--bad:#e5484d;--soft:#eeeefe;--r:16px;--sh:0 1px 2px #1b1f3a0a,0 8px 28px #1b1f3a10;--glow:radial-gradient(900px 420px at 85% -10%,#8b5cf622,transparent 60%),radial-gradient(700px 380px at -5% 0%,#5b5bf01c,transparent 55%)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c12;--bg2:#10121b;--card:#151826cc;--card-s:#151826;--fg:#eceef6;--mut:#8f97ad;--line:#242840;--pri:#7c7cff;--pri2:#a78bfa;--soft:#1b1e38;--sh:0 1px 2px #0006,0 12px 36px #0007;--glow:radial-gradient(900px 420px at 85% -10%,#8b5cf630,transparent 60%),radial-gradient(700px 380px at -5% 0%,#5b5bf02a,transparent 55%)}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Inter","SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{background-image:var(--glow);background-attachment:fixed;min-height:100vh}
a{color:var(--pri);text-decoration:none}code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,monospace;font-size:12.5px}
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
aside{position:sticky;top:0;height:100vh;padding:22px 14px;display:flex;flex-direction:column;gap:6px;border-right:1px solid var(--line);background:linear-gradient(180deg,var(--card),transparent);backdrop-filter:blur(14px)}
.brand{display:flex;align-items:center;gap:10px;padding:2px 10px 18px;font-weight:700;font-size:16px;letter-spacing:.2px}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--pri),var(--pri2));box-shadow:0 6px 18px #5b5bf055;display:grid;place-items:center;color:#fff;font-size:15px}
.brand small{display:block;font-weight:500;font-size:11px;color:var(--mut);letter-spacing:0}
nav{display:flex;flex-direction:column;gap:2px}
nav button{display:flex;align-items:center;gap:10px;border:0;background:none;color:var(--mut);padding:9px 12px;border-radius:11px;cursor:pointer;font:inherit;text-align:left;transition:.15s}
nav button svg{width:17px;height:17px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
nav button:hover{background:var(--soft);color:var(--fg)}
nav button.on{background:linear-gradient(135deg,var(--pri),var(--pri2));color:#fff;font-weight:600;box-shadow:0 8px 22px #5b5bf044}
.side-foot{margin-top:auto;padding:10px;color:var(--mut);font-size:12px;display:flex;align-items:center;justify-content:space-between}
main{padding:28px clamp(14px,3vw,40px) 80px;max-width:1180px;width:100%}
.top{display:flex;align-items:center;gap:12px;margin-bottom:20px}.top h1{margin:0;font-size:22px;letter-spacing:-.2px;flex:1}.top .sub-h{color:var(--mut);font-size:13px}
.card{background:var(--card);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:var(--r);padding:20px;margin-bottom:16px;box-shadow:var(--sh)}
.card h2{font-size:14px;font-weight:650;margin:0 0 14px;display:flex;align-items:center;gap:8px;letter-spacing:.2px}.card h2 .sp{flex:1}
.card h2 i{width:6px;height:16px;border-radius:3px;background:linear-gradient(180deg,var(--pri),var(--pri2));display:inline-block}
.card h2{flex-wrap:wrap;row-gap:8px}.card h2 .btn,.btn.sm{padding:5px 12px;font-size:12.5px}
.card h2 .hint{font-weight:500;font-size:12px;color:var(--mut)}
.card .desc{margin:-6px 0 14px;color:var(--mut);font-size:13px}
.out:empty{display:none}.out{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line)}.out h3{font-size:13px;margin:0 0 8px}.out h3+*{margin-top:0}
.pagenote{margin:4px 2px 16px}
.toc{position:sticky;top:var(--stick,0px);z-index:15;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:-10px -6px 14px;padding:8px 6px;background:linear-gradient(var(--bg) 78%,transparent)}
.toc::-webkit-scrollbar{display:none}
.toc a{flex:none;padding:5px 12px;border-radius:999px;font-size:12.5px;font-weight:550;white-space:nowrap;color:var(--mut);background:var(--card-s);border:1px solid var(--line);transition:.15s}
.toc a:hover{color:var(--pri);border-color:var(--pri)}
.toc a.on{color:#fff;background:linear-gradient(135deg,var(--pri),var(--pri2));border-color:transparent}
.savebar{position:sticky;bottom:16px;z-index:10;display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:14px;background:var(--card-s);border:1px solid var(--pri);box-shadow:var(--sh),0 0 0 4px #5b5bf01a}
.savebar[hidden]{display:none}.savebar .sp{flex:1}#dirtyN{font-weight:600}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.f{display:flex;flex-direction:column;gap:5px}.f label{font-size:12.5px;color:var(--mut);font-weight:500}.f .h{font-size:12px;color:var(--mut)}.f.wide{grid-column:1/-1}
input,select,textarea{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:11px;background:var(--bg2);color:var(--fg);font:inherit;transition:.15s;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--pri);box-shadow:0 0 0 3px #5b5bf02e}
textarea{min-height:112px;resize:vertical}
.chk{display:flex;align-items:center;gap:10px;padding:9px 0;cursor:pointer;color:var(--fg)!important;font-size:13.5px!important}
.chk input{appearance:none;-webkit-appearance:none;width:38px;height:22px;border-radius:99px;background:var(--line);position:relative;cursor:pointer;flex:none;padding:0;border:0;transition:.2s}
.chk input::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0004;transition:.2s}
.chk input:checked{background:linear-gradient(135deg,var(--pri),var(--pri2))}.chk input:checked::after{left:19px}
.btn{border:1px solid var(--line);background:var(--card-s);color:var(--fg);padding:8px 16px;border-radius:11px;cursor:pointer;font:inherit;font-weight:550;white-space:nowrap;transition:.15s}
.btn:hover{border-color:var(--pri);color:var(--pri)}.btn.p{background:linear-gradient(135deg,var(--pri),var(--pri2));border:0;color:#fff;box-shadow:0 8px 20px #5b5bf044}.btn.p:hover{filter:brightness(1.07);color:#fff}
.btn.d{color:var(--bad)}.btn.d:hover{border-color:var(--bad);color:var(--bad)}.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.tw{overflow-x:auto;margin:0 -4px;padding:0 4px}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:10px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mut);font-weight:550;font-size:12px;letter-spacing:.4px}tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--soft)}
.tag{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;background:var(--soft);color:var(--pri);font-weight:550}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.p-ok{color:var(--ok);background:#12a46a1c}.p-low{color:var(--warn);background:#e08a001c}.p-exhausted{color:var(--bad);background:#e5484d1c}.p-stale,.p-unknown{color:var(--mut);background:var(--soft)}
.bar{height:7px;background:var(--line);border-radius:99px;overflow:hidden;min-width:90px;flex:1}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--pri),var(--pri2));border-radius:99px;transition:width .5s}
.hero{display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:center}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.kpi b{display:block;font-size:22px;letter-spacing:-.4px;font-weight:700}.kpi span{color:var(--mut);font-size:12px}
pre{background:var(--bg2);border:1px solid var(--line);padding:12px;border-radius:12px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-all}
#toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);background:var(--fg);color:var(--bg);padding:10px 18px;border-radius:999px;opacity:0;transition:.25s;pointer-events:none;z-index:99;max-width:90vw;box-shadow:var(--sh);font-weight:550}
#toast.on{opacity:.96;transform:translate(-50%,0)}.mut{color:var(--mut)}body.simple .adv{display:none}
.sub{display:flex;gap:8px;align-items:center}.sub input{flex:1}
.kv{display:grid;grid-template-columns:130px 1fr;gap:8px 16px;margin:0}.kv dt{color:var(--mut)}.kv dd{margin:0;font-weight:550;word-break:break-all}
.note{padding:12px 14px;border-radius:12px;background:var(--soft);font-size:13px;margin-bottom:14px}
@media (max-width:860px){
.shell{grid-template-columns:1fr}
aside{position:sticky;top:0;z-index:20;height:auto;flex-direction:row;align-items:center;padding:8px 10px;border-right:0;border-bottom:1px solid var(--line);background:var(--card-s);gap:6px;overflow:hidden}
.brand{padding:0 6px 0 2px}.brand small,.side-foot,.brand .t{display:none}
nav{flex-direction:row;overflow-x:auto;gap:4px;scrollbar-width:none}nav::-webkit-scrollbar{display:none}
nav button{padding:8px 12px;white-space:nowrap}
main{padding:16px 12px 80px}.card{padding:16px;border-radius:14px}.hero{grid-template-columns:1fr;justify-items:center}.top h1{font-size:19px}
.kv{grid-template-columns:100px 1fr}}
`;

/** 浏览器端主程序（toString 后内联） */
/* eslint-disable no-undef */
function clientMain() {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => (n == null || isNaN(n) ? '-' : Number(n) >= 1e4 ? (Number(n) / 1e4).toFixed(2) + ' 万' : String(Math.round(n)));
  const fmtT = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-');
  let S = null; // state
  let tab = 'overview';
  try { tab = localStorage.getItem('nt.tab') || 'overview'; } catch {}
  let dirty = false; // 当前设置页有未保存的改动

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }
  async function api(path, method = 'GET', body) {
    const opt = { method, headers: { 'X-Requested-With': 'nt' }, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch('/admin/api/' + path, opt);
    // 登录失效：401；设置了 LOGIN_PATH 时未登录的 API 请求拿到的是伪装页（HTML），同样视为未登录
    if (r.status === 401 || /text\/html/i.test(r.headers.get('content-type') || '')) { location.href = document.body.dataset.login || '/login'; throw new Error('未登录'); }
    let j; try { j = await r.json(); } catch { j = { ok: false, error: 'HTTP ' + r.status }; }
    if (!j.ok) {
      const f = j.fields ? '：' + Object.entries(j.fields).map(([k, v]) => k + ' ' + v).join('；') : '';
      throw new Error((j.error || '请求失败') + f);
    }
    return j;
  }
  const run = (fn) => async (ev) => {
    const b = ev?.currentTarget; if (b) b.disabled = true;
    try { await fn(ev); } catch (e) { toast(e.message || String(e)); } finally { if (b) b.disabled = false; }
  };
  const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach((k) => { a = a[k] = a[k] || {}; }); a[ks[ks.length - 1]] = v; };

  // ---------------- 设置表单（声明式） ----------------
  // 设置卡片（声明式）。每页一组卡片，全部常开（不折叠）；字段 [路径, 标签, 类型, 选项, 高级?, 说明]，高级项在小白模式下隐藏。
  // t=标题，d=卡片说明，act=标题栏按钮（[id, 文字]），out=该卡片的结果区（按钮的输出显示在卡片内）
  const SECTIONS = {
    quota: [
      { t: "Workers Paid（付费版）", d: '付费版每个连接 CPU 上限 30 秒（免费版 10ms），地区路由的链式连接最需要它。只在这里设置，节点站点不用改。', f: [
        ['paid.main', '主号已开通 Workers Paid', 'bool', null, 0, '勾选后地区条目改走主站域名，链式连接不再被掐断；普通节点仍然用免费账号分摊'],
        ['paid.regionOnly', '地区条目只分配给付费域名（主站 + 勾了"付费"的账号）', 'bool', null, 0, '没有任何付费域名时自动回退为分配给全部节点'],
        ['paid.mainHosts', '主站承载地区条目的域名（每行一个；留空 = 生成订阅时访问的主站域名）', 'list', null, 1],
        ['paid.dailyBudget', '付费账号的每日预算（请求数，用于分配权重）', 'num', null, 1, '默认 330000 ≈ 每月含的 1000 万次 ÷ 30。账号自己填了每日额度时以账号为准'],
      ] },
      { t: "用量轮询", d: '定时查询各账号今日的请求数，用来计算剩余额度。主站在 Pages 上没有 Cron 时，由订阅请求触发后台刷新。', f: [
        ['usage.enabled', '启用', 'bool'],
        ['usage.limitPerAccount', '每号每日额度', 'num'],
        ['usage.safetyMargin', '安全余量（0~1）', 'num'],
        ['usage.floorRemaining', '剩余低于此值视为耗尽', 'num'],
        ['usage.horizonMinutes', '预测窗口（分钟）', 'num', null, 1],
        ['usage.batchSize', '每次轮询最少账号数', 'num', null, 1],
        ['usage.cycleMinutes', '每个账号至少每隔多少分钟轮询一次', 'num', null, 0, '账号多时每次轮询的数量会自动放大，保证所有号都轮得到'],
        ['usage.staleMinutes', '数据过期（分钟）', 'num'],
        ['usage.lazyRefresh', '无 Cron 时懒刷新', 'bool', null, 1],
        ['usage.minWriteIntervalMinutes', '快照最小写入间隔（分钟）', 'num', null, 1],
      ] },
      { t: "额度分配", d: '订阅里的节点按各账号的剩余额度分到不同域名上，避免某个号先被用完。', f: [
        ['allocation.enabled', '按剩余额度分配', 'bool'],
        ['allocation.alpha', '权重指数 alpha', 'num'],
        ['allocation.maxShare', '单域名最大占比（0~1）', 'num'],
        ['allocation.pace', '节奏感知（让所有号在重置前同时用到预算）', 'bool', null, 0, '按每个号的消耗速度调权：会剩额度的多分、会提前耗尽的少分，避免死薅几个号'],
        ['allocation.paceMax', '节奏调权幅度上限（倍）', 'num', null, 1],
        ['allocation.seedMode', '分配种子', 'sel', ['ip', 'token', 'none']],
        ['allocation.windowMinutes', '分配窗口（分钟）', 'num'],
      ] },
      { t: "未纳入账号管理的节点域名", f: [
        ['hosts.unmanaged', '域名（每行一个；额度未知，按固定权重参与分配）', 'list'],
        ['hosts.unmanagedWeight', '权重倍率', 'num', null, 1],
      ] },
    ],
    sources: [
      { t: "优质节点（自定义 / gate / 汇聚订阅）", act: [['testCustom', '测试']], out: 'outCustom', f: [
        ['preferred.custom.enabled', '启用', 'bool'],
        ['preferred.custom.text', '来源（每行：地址[:端口][#备注]、http(s) 链接、sub://… ；备注里可带 $sstp://… 链式）', 'area'],
        ['preferred.custom.maxNodes', '最多节点数（0=不限）', 'num'],
        ['preferred.custom.refreshSeconds', '缓存刷新间隔（秒）', 'num', null, 1],
      ] },
      { t: "优选订阅（多个优选 URL / 优选订阅生成器）", f: [
        ['preferred.best.enabled', '启用（与优质、兜底可同时开启）', 'bool'],
        ['preferred.best.urls', '优选 URL（每行一个：IP 列表 / CloudflareSpeedTest CSV / sub://生成器 / 节点订阅；{isp} 会按访问者运营商自动替换为 ct/cu/cmcc/cf）', 'list'],
        ['preferred.best.maxPerUrl', '每个 URL 最多取', 'num'],
        ['preferred.best.maxNodes', '优选节点总数上限', 'num'],
        ['preferred.best.refreshSeconds', '刷新间隔（秒）', 'num', null, 1],
        ['preferred.best.namePrefix', '名称前缀', 'text', null, 1],
      ] },
      { t: "兜底节点（随机优选 CF IP）", act: [['testCidr', '测试 CIDR']], out: 'outCidr', f: [
        ['preferred.random.enabled', '启用', 'bool'],
        ['preferred.random.aggregate', '只显示一个随机优选（节点只出现在测速组里，不在手动选择列表逐个列出）', 'bool', null, 0, '客户端里只看到一个"随机优选"自动选择组，由它自动挑最快的 CF IP。仅 Clash / Surge / sing-box 生效'],
        ['preferred.random.count', '数量', 'num'],
        ['preferred.random.goodRatio', '取自"已知可用地址"的比例（0~1，需启用优选订阅）', 'num', null, 0, '随机节点里这部分直接用优选订阅里的测速结果，其余从运营商 CIDR 抽取，减少超时 IP'],
        ['preferred.random.portBias', '端口倾向 443 的概率（0~0.95）', 'num', null, 1],
        ['preferred.random.isp', '运营商', 'sel', ['auto', 'ct', 'cu', 'cmcc', 'cf']],
        ['preferred.random.ports', '端口（逗号分隔）', 'nums'],
        ['preferred.random.namePrefix', '名称前缀', 'text', null, 1],
        ['preferred.random.stable.enabled', '稳定池（渐进轮换）', 'bool', null, 1],
        ['preferred.random.stable.rotatePercent', '每窗口轮换比例 %', 'num', null, 1],
        ['preferred.random.stable.windowMinutes', '窗口（分钟）', 'num', null, 1],
        ['preferred.random.cidrBase', 'CIDR 来源（留空=内置）', 'text', null, 1],
        ['preferred.random.blacklist', '黑名单 IP/CIDR（每行一个）', 'list', null, 1],
      ] },
      { t: "地区路由（可选，默认关闭）", act: [['testRegions', '测试地区列表']], out: 'outRegions', f: [
        ['preferred.regions.enabled', '启用：订阅里只放"地区"，节点在连接时才选', 'bool', null, 0, '适合节点寿命很短、列表高频变化的来源（如 VPN Gate）。订阅不用跟着列表频繁更新，条目更少、客户端测速也更省额度。⚠ 开启后所有节点站点必须运行本项目的 _worker.js；它与"优质来源"相互独立，同一份列表不要两处都填。'],
        ['preferred.regions.urls', '节点列表 URL（每行一个；行格式：入口地址#名称$sstp://用户:密码@主机:端口，支持 socks5/http/https/turn）', 'list'],
        ['preferred.regions.regex', '地区规则（正则：第 1 组=地区，可选第 2 组=类型；留空=取名称里第一个 - _ 空格或数字之前的部分）', 'text', null, 0, '例：^(.+?)-(住宅|机房)-\\d+$ 会得到"日本-住宅""日本-机房"两类地区'],
        ['preferred.regions.kinds', '只保留这些类型（每行一个，如 住宅；留空=全部）', 'list', null, 0, '每个「地区+类型」一个条目。只要住宅的话，这里填 住宅 可让条目减半'],
        ['preferred.regions.kindNames', '类型显示名（每行 原类型=显示名，如 住宅=家宽）', 'list', null, 0, '客户端条目显示成 【家宽】日本、【机房】美国。没写映射的类型按原名显示'],
        ['preferred.regions.nameTemplate', '条目名称模板（{kind}=类型显示名，{region}=地区）', 'text', null, 1, '默认 【{kind}】{region}。列表里没有类型时只显示地区'],
        ['preferred.regions.pickK', '在列表前 K 台里挑（列表按质量排序时越小越好）', 'num', null, 1],
        ['preferred.regions.stickyMinutes', '同一用户多久内固定同一台（分钟；0=每条连接随机）', 'num', null, 1],
        ['preferred.regions.ttlSeconds', '节点站点读取列表的缓存时间（秒）', 'num', null, 1],
        ['preferred.regions.refreshSeconds', '主站刷新地区结构的间隔（秒）', 'num', null, 1],
      ] },
    ],
    node: [
      { t: "协议与传输", f: [
        ['node.protocol', '协议', 'sel', ['vless', 'trojan', 'ss']],
        ['node.transport', '传输', 'sel', ['ws', 'grpc', 'xhttp'], 0, 'WS 每条连接只计 1 次请求，最省额度'],
        ['node.grpcMode', 'gRPC 模式', 'sel', ['gun', 'multi'], 1],
        ['node.grpcUserAgent', 'gRPC User-Agent', 'text', null, 1],
        ['node.path', '路径 PATH', 'text'],
        ['node.randomPath', '随机路径', 'bool'],
        ['node.zeroRtt', '0-RTT（?ed=2560）', 'bool'],
        ['node.fingerprint', 'TLS 指纹', 'sel', ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized']],
        ['node.alpn', 'ALPN（逗号分隔，留空自动）', 'text', null, 1],
        ['node.skipCertVerify', '跳过证书验证', 'bool', null, 1],
        ['node.tlsFragment', 'TLS 分片', 'sel', ['', 'Shadowrocket', 'Happ'], 1],
        ['node.ech.enabled', '启用 ECH', 'bool', null, 1],
        ['node.ech.dns', 'ECH DNS', 'text', null, 1],
        ['node.ech.sni', 'ECH SNI', 'text', null, 1],
        ['node.ss.method', 'SS 加密', 'sel', ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'none'], 1],
        ['node.ss.tls', 'SS 使用 TLS', 'bool', null, 1],
      ] },
      { t: "反代（PROXYIP / SOCKS5 等）", f: [
        ['proxy.mode', '反代方式', 'sel', ['proxyip', 'socks5', 'http', 'https', 'turn', 'sstp']],
        ['proxy.proxyip', 'PROXYIP（auto=自动）', 'text'],
        ['proxy.chain.account', '链式代理账号（user:pass@host:port）', 'text'],
        ['proxy.chain.global', '全局走链式代理（只走代理，连不上直接断开）', 'bool', null, 0, '勾选：所有流量都走链式代理，代理连不上就断开，绝不回落直连——出口 IP 不会变成 Cloudflare 的（用住宅 IP 登录敏感账号时选这个）。不勾：先直连，直连失败（例如套了 CF 的网站）才走代理'],
        ['proxy.socks5Whitelist', 'SOCKS5 白名单（每行一个）', 'list', null, 1],
      ] },
      { t: "伪装页", f: [
        ['camouflage.url', '主站伪装页（nginx / 1101 / https://…）', 'text', null, 0, '非订阅、非后台的访问看到的页面。主站设了环境变量 URL 时以它为准；节点站点只看自己的环境变量 URL，不受这里影响'],
      ] },
    ],
    sub: [
      { t: "订阅内容", f: [
        ['site.name', '订阅名称'],
        ['sub.updateHours', '客户端更新间隔（小时）', 'num'],
        ['sub.rateLimitPerMinute', '同 IP 每分钟最多拉取（0=不限）', 'num', null, 1],
        ['sub.userinfo', '在客户端显示号池额度', 'bool'],
        ['sub.udp', 'UDP', 'bool', null, 1],
        ['sub.xudp', 'XUDP', 'bool', null, 1],
        ['sub.appendType', '名称前加协议类型', 'bool', null, 1],
        ['sub.sort', '按名称排序', 'bool', null, 1],
      ] },
      { t: "客户端测速", d: '默认完全按 INI 里每个测速组写的间隔（随机优选通常 300 秒、故障转移 180 秒），坏掉或变慢的节点能及时被换掉。客户端每次测速 = 每个节点 1 次节点 Worker 请求（不占主站额度）。', f: [
        ['sub.testIntervalAuto', '额度吃紧时自动放慢测速', 'bool', null, 0, '号池余量低于平均节奏时，各组间隔从 INI 值逐步拉长，最长到下面的"放慢上限"；余量正常时不改动。订阅响应头 X-NT-Opts 里出现 tight= 表示正在放慢'],
        ['sub.tolerance', 'url-test 默认容差（毫秒，0=不加）', 'num', null, 0, 'INI 没写容差时使用。新节点比当前节点快不到这个值就不切换；太大会让客户端停在变慢的节点上'],
        ['sub.testIntervalMin', '测速间隔下限（秒，0=完全按 INI）', 'num', null, 1, '所有测速组至少隔这么久才测一次。设得太大，变慢或失效的节点要很久才会被换掉，表现为卡、慢'],
        ['sub.testIntervalCeil', '放慢上限（秒）', 'num', null, 1],
      ] },
      { t: "规则（订阅转换 INI）", f: [
        ['rules.configUrl', 'INI 地址', 'text'],
        ['rules.iniAutoRefresh', '自动更新转换配置（关闭后只在点"获取并保存"时更新）', 'bool', null, 0, '转换配置保存在 KV 里，订阅只读缓存、不会去连远程；这个开关只决定 Cron 是否每隔「规则刷新间隔」重新拉取一次'],
        ['rules.configText', 'INI 内容（非空时优先于地址）', 'area', null, 1],
        ['rules.mode', '规则模式', 'sel', ['expand', 'provider'], 0, 'expand=服务器展开（默认）；provider=客户端自己下载规则集'],
        ['rules.providerMirror', 'provider 镜像前缀', 'text', null, 1],
        ['rules.refreshHours', '规则刷新间隔（小时）', 'num', null, 1],
      ] },
    ],
    notify: [
      { t: "Telegram 通知", act: [['tgTest', '发送测试消息']], f: [
        ['notify.telegram.enabled', '启用', 'bool'],
        ['notify.telegram.botToken', 'Bot Token（留空=不修改）', 'secret'],
        ['notify.telegram.chatId', 'Chat ID', 'text'],
        ['notify.telegram.events.adminLogin', '后台登录', 'bool'],
        ['notify.telegram.events.configSave', '保存配置', 'bool'],
        ['notify.telegram.events.subFetch', '订阅拉取', 'bool'],
        ['notify.telegram.events.lowQuota', '额度告警', 'bool'],
        ['notify.telegram.events.accountError', '账号异常', 'bool'],
        ['notify.telegram.minIntervalSeconds', '最小间隔（秒）', 'num', null, 1],
      ] },
      { t: "日志", f: [
        ['log.enabled', '记录日志', 'bool'],
        ['log.subFetch', '记录订阅拉取', 'bool'],
        ['log.maxEntries', '最多条数', 'num', null, 1],
        ['log.flushMinutes', '写入间隔（分钟）', 'num', null, 1],
      ] },
    ],
    system: [
      { t: "界面", f: [
        ['ui.simpleMode', '小白模式（隐藏高级项）', 'bool'],
      ] },
      { t: "多用户专属链接", d: '开启后左侧多一个「用户」页：批量生成每人一条的订阅链接，可封禁、设置并行客户端数、查看在线和用量。原有的订阅链接不变。节点账号需要 KV 和 Analytics Engine 两个绑定（「用户」页可自动配置）。', f: [
        ['users.enabled', '开启多用户', 'bool'],
        ['users.defaultLimit', '默认并行客户端数（同时在线的不同 IP；0 = 不限）', 'num'],
      ] },
    ],
  };

  function field([path, label, type = 'text', opts, adv, help]) {
    const v = get(S.settings, path);
    const id = 'f_' + path.replace(/\./g, '_');
    const cls = 'f' + (type === 'area' || type === 'list' ? ' wide' : '') + (adv ? ' adv' : '');
    const hp = help ? `<span class="h">${h(help)}</span>` : '';
    if (type === 'bool') return `<div class="${cls}"><label class="chk"><input type="checkbox" id="${id}" data-p="${path}" data-t="bool" ${v ? 'checked' : ''}> ${h(label)}</label>${hp}</div>`;
    let input;
    if (type === 'sel') input = `<select id="${id}" data-p="${path}" data-t="sel">${opts.map((o) => `<option value="${h(o)}" ${String(v ?? '') === o ? 'selected' : ''}>${h(o || '关闭')}</option>`).join('')}</select>`;
    else if (type === 'area') input = `<textarea class="mono" id="${id}" data-p="${path}" data-t="text">${h(v)}</textarea>`;
    else if (type === 'list') input = `<textarea class="mono" id="${id}" data-p="${path}" data-t="list">${h((v || []).join('\n'))}</textarea>`;
    else if (type === 'nums') input = `<input id="${id}" data-p="${path}" data-t="nums" value="${h((v || []).join(','))}">`;
    else if (type === 'secret') input = `<input id="${id}" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore data-p="${path}" data-t="secret" placeholder="${h(v || '未设置')}">`;
    else input = `<input id="${id}" ${type === 'num' ? 'type="number" step="any"' : ''} data-p="${path}" data-t="${type === 'num' ? 'num' : 'text'}" value="${h(v)}">`;
    return `<div class="${cls}"><label for="${id}">${h(label)}</label>${input}${hp}</div>`;
  }
  // 一张设置卡片：标题栏（标题 + 按钮）→ 说明 → 字段 → 结果区。所有卡片同一个样式、都不折叠
  function cardHtml(c) {
    const simple = !!S.settings.ui?.simpleMode;
    const hidden = simple ? c.f.filter((x) => x[4]).length : 0;
    const acts = (c.act || []).map(([id, label]) => `<button class="btn sm" id="${id}">${h(label)}</button>`).join('');
    return `<section class="card"><h2><i></i>${h(c.t)}<span class="sp"></span>${hidden ? `<span class="hint" title="在「系统」页关闭小白模式即可显示">已隐藏 ${hidden} 项高级设置</span>` : ''}${acts}</h2>`
      + (c.d ? `<p class="desc">${h(c.d)}</p>` : '')
      + `<div class="grid">${c.f.map(field).join('')}</div>`
      + (c.out ? `<div id="${c.out}" class="out"></div>` : '')
      + '</section>';
  }
  // 设置页：卡片 + 底部保存栏（有改动时才出现，撤销 / 保存；只提交改动过的项）
  function sectionHtml(key) {
    return SECTIONS[key].map(cardHtml).join('')
      + `<div class="savebar" id="saveBar" hidden><span id="dirtyN">有改动未保存</span><span class="sp"></span><button class="btn" id="undoSave">撤销</button><button class="btn p" data-save="${key}">保存</button></div>`;
  }
  function collectPatch(root) {
    const patch = {};
    root.querySelectorAll('[data-p]').forEach((el) => {
      const p = el.dataset.p, t = el.dataset.t, old = get(S.settings, p);
      let v;
      if (t === 'bool') { if (old === undefined) return; v = el.checked; }
      else if (t === 'num') v = el.value === '' ? old : Number(el.value);
      else if (t === 'list') v = el.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      else if (t === 'nums') v = el.value.split(/[\s,]+/).map(Number).filter((n) => n > 0);
      else if (t === 'secret') { if (!el.value) return; v = el.value; }
      else if (t === 'sel' && p === 'node.tlsFragment') v = el.value || null;
      else v = el.value;
      if (JSON.stringify(v) !== JSON.stringify(old)) setPath(patch, p, v);
    });
    return patch;
  }
  // 「额度 → 主号额度」卡片里的输入（data-main）：有改动时返回要保存的完整账号列表，否则 null。与本页设置共用一个保存栏
  const mainAccount = () => S.accounts.find((a) => a.role === 'main') || null;
  function collectMain(root) {
    const els = root.querySelectorAll('[data-main]');
    if (!els.length) return null;
    const v = (k) => ($(`[data-main="${k}"]`, root)?.value || '').trim();
    const token = v('apiToken'), accountId = v('accountId');
    const limitRaw = v('limit'), limit = limitRaw === '' ? null : Math.round(Number(limitRaw));
    const m = mainAccount();
    const oldLimit = m && Number(m.limit) > 0 ? Number(m.limit) : null;
    if (!token && (!accountId || accountId === (m?.auth?.accountId || '')) && limit === oldLimit) return null;
    const base = m || { id: 'main', name: '主站', hosts: [], role: 'main', enabled: true, weight: 1, auth: {} };
    const next = { ...base, limit, auth: { ...base.auth, ...(token ? { apiToken: token } : {}), ...(accountId ? { accountId } : {}) } };
    return m ? S.accounts.map((a) => (a === m ? next : a)) : S.accounts.concat([next]);
  }
  async function saveSettings(root) {
    const patch = collectPatch(root);
    const mainList = collectMain(root);
    if (!Object.keys(patch).length && !mainList) return toast('没有改动');
    if (Object.keys(patch).length) {
      const r = await api('settings', 'PUT', patch);
      S.settings = r.settings;
      document.body.classList.toggle('simple', !!S.settings.ui?.simpleMode);
    }
    if (mainList) { const r = await api('accounts', 'PUT', { accounts: mainList, mode: 'replace' }); S.accounts = r.accounts; }
    toast('已保存'); dirty = false;
    if (mainList) await reload(); else render();
  }

  // ---------------- 各页 ----------------
  function ring(used, budget) {
    const p = budget > 0 ? Math.min(1, used / budget) : 0;
    const C = 2 * Math.PI * 42, col = p > 0.9 ? 'var(--bad)' : p > 0.7 ? 'var(--warn)' : 'var(--ok)';
    return `<svg width="120" height="120" viewBox="0 0 100 100" role="img" aria-label="号池已用 ${Math.round(p * 100)}%"><circle cx="50" cy="50" r="42" fill="none" stroke="var(--line)" stroke-width="10"/><circle cx="50" cy="50" r="42" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C * p} ${C}" transform="rotate(-90 50 50)"/><text x="50" y="55" text-anchor="middle" font-size="16" fill="var(--fg)" font-weight="600">${Math.round(p * 100)}%</text></svg>`;
  }
  const STATE_CN = { ok: '正常', low: '偏低', exhausted: '耗尽', stale: '过期', unknown: '未知' };
  const stateTip = (st) => ({
    ok: '额度充足',
    low: '剩余不足预算的 15%，分配权重相应降低',
    exhausted: '剩余额度低于下限，不再给它分配新节点',
    stale: '过期：最近一次轮询失败，或超过 ' + (S.settings.usage?.staleMinutes ?? 60) + ' 分钟没有更新。按最后一次的数据估算，分配权重减半（不是被排除）。到「账号」页看具体原因',
    unknown: '从未成功轮询过（没填 API 凭据，或一直失败）：按其它账号的中位数估算它的权重',
  }[st] || '');
  const ago = (t) => { const m = Math.max(0, Math.round((S.now - t) / 60000)); return m < 1 ? '刚刚' : m < 120 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'; };
  // 账号页"轮询状态"：失败显示原因，过期显示多久没更新
  const pollStatus = (a) => {
    const u = S.usage?.accounts?.[a.id] || {};
    if (!(a.auth?.hasToken || a.auth?.hasKey)) return '<span class="pill p-unknown" title="没有填 API Token（或邮箱+Global Key），额度未知">无凭据</span>';
    if (!u.polledAt && !u.triedAt) return '<span class="pill p-unknown" title="还没有轮询过：点「立即轮询」，或等待订阅请求触发">未轮询</span>';
    const last = u.polledAt ? ' <span class="mut">· 上次成功 ' + ago(u.polledAt) + '，用量 ' + fmtN(u.used) + '</span>' : '';
    if (u.ok === false) return '<span class="pill p-exhausted">失败</span> <span title="' + h(u.err) + '">' + h(String(u.err || '未知错误').slice(0, 60)) + (u.errKind ? '（' + h(u.errKind) + '）' : '') + (u.fails > 1 ? ' ×' + u.fails : '') + '</span>' + last;
    const stale = S.settings.usage?.staleMinutes ?? 60;
    if (u.polledAt && (S.now - u.polledAt) / 60000 > stale) return '<span class="pill p-stale" title="' + h(stateTip('stale')) + '">过期</span> <span class="mut">' + ago(u.polledAt) + ' 更新，用量 ' + fmtN(u.used) + '</span>';
    return '<span class="pill p-ok">正常</span> <span class="mut">' + fmtN(u.used) + ' · ' + ago(u.polledAt) + '</span>';
  };
  const paidHost = (host) => S.accounts.some((a) => a.paid && (a.hosts || []).includes(host));
  const mainLine = () => { const m = mainAccount(); const u = m ? S.usage?.accounts?.[m.id] : null; if (!m || !u?.polledAt) return '<br>主号（主站）用量：' + (m ? '还没轮询到' : '没有设置') + '，到「额度 → 主号额度」查看。'; const { limit } = mainLimitOf(m); return '<br>主号（主站）今日已用 ' + fmtN(u.used) + ' / ' + fmtN(limit) + '（' + Math.round((u.used / limit) * 100) + '%）· ' + ago(u.polledAt) + '更新。'; };
  function pgOverview() {
    const sm = S.pool?.summary || {}, hosts = (S.pool?.hosts || []).slice().sort((a, b) => a.host.localeCompare(b.host, 'en', { numeric: true }));
    const sub = S.subUrl || '';
    const links = [['通用（base64）', sub], ['Clash / mihomo', sub + '&clash'], ['sing-box', sub + '&sb'], ['Surge', sub + '&surge']];
    // 一键导入（与专属订阅落地页同一套客户端链接格式，见 control/sub/landing.js importLinks）
    const enc = encodeURIComponent, siteN = enc(S.settings.site?.name || '订阅');
    const b64u = (s) => btoa(unescape(encodeURIComponent(s)));
    const imports = sub ? [
      ['Clash 系', 'Clash Verge Rev / FlClash / CMFA', `clash://install-config?url=${enc(sub)}&name=${siteN}`],
      ['sing-box', 'SFA / SFI / SFM', `sing-box://import-remote-profile?url=${enc(sub)}#${siteN}`],
      ['Shadowrocket', 'iOS 小火箭', `shadowrocket://add/sub://${b64u(sub)}?remark=${siteN}`],
      ['Stash', 'iOS', `stash://install-config?url=${enc(sub)}`],
      ['Surge', 'iOS / macOS', `surge:///install-config?url=${enc(sub)}`],
      ['Hiddify', '全平台', `hiddify://import/${sub}#${siteN}`],
    ] : [];
    const paceTxt = (p) => (p == null ? '<span class="mut">-</span>' : p >= 1.15 ? `<span class="pill p-ok">加量 ×${p}</span>` : p <= 0.85 ? `<span class="pill p-low">减量 ×${p}</span>` : `<span class="pill p-stale">均衡</span>`);
    const checks = (S.checks || []).length ? `<div class="card"><h2><i></i>配置自检<span class="sp"></span><span class="mut" style="font-weight:500">${S.checks.filter((c) => c.level === 'warn').length} 项需要处理 · ${S.checks.filter((c) => c.level === 'info').length} 项提示</span></h2>${S.checks.map((c) => `<div class="note" style="display:flex;gap:10px;align-items:flex-start"><span class="pill ${c.level === 'warn' ? 'p-low' : 'p-stale'}" style="flex:none">${c.level === 'warn' ? '需处理' : '提示'}</span><span>${h(c.text)}</span></div>`).join('')}</div>` : '';
    return checks + `<div class="card"><h2><i></i>号池额度<span class="sp"></span><button class="btn" id="poll">立即轮询</button></h2>
      <div class="hero">${ring(sm.used || 0, sm.budget || 0)}<div class="kpis">
        <div class="kpi"><b>${fmtN(sm.used)}</b><span>今日已用</span></div><div class="kpi"><b>${fmtN(sm.budget)}</b><span>可用预算</span></div>
        <div class="kpi"><b>${fmtN(sm.remaining)}</b><span>有效剩余</span></div>
        <div class="kpi"><b>${sm.accounts ?? 0}</b><span>参与分配的账号</span></div>
        <div class="kpi"><b><span style="color:var(--ok)">${sm.hostsOk ?? 0}</span> · <span style="color:var(--warn)">${sm.hostsLow ?? 0}</span> · <span style="color:var(--bad)">${sm.hostsExhausted ?? 0}</span></b><span>正常 · 偏低 · 耗尽</span></div>
        <div class="kpi"><b>${S.kv?.bound ? (S.kv.writesTodayEstimate ?? 0) + (S.settings.paid?.main ? ' / 每月 100 万' : ' / 1000') : '未绑定'}</b><span>KV 今日写入（本实例估计）</span></div>
      </div></div><p class="mut" style="margin:14px 0 0">额度于 UTC 0 点（北京时间 8 点）重置${sm.resetAt ? '，下次 ' + fmtT(sm.resetAt) : ''}。${mainLine()}</p></div>
    <div class="card"><h2><i></i>订阅链接</h2>${sub ? links.map(([n, u]) => `<div class="f" style="margin-bottom:10px"><label>${h(n)}</label><div class="sub"><input readonly value="${h(u)}"><button class="btn" data-copy="${h(u)}">复制</button></div></div>`).join('') : '<p class="mut">未生成</p>'}
      <p class="mut" style="margin:6px 0 0">所有用户共用同一个链接即可：格式按客户端 UA 自适应，节点按访问者运营商与 IP 段自动分配。</p></div>
    ${sub ? `<div class="card"><h2><i></i>一键导入</h2><p class="mut" style="margin:0 0 10px">在装了客户端的设备上打开后台点一下直接导入；另一台设备用客户端扫右边的二维码。</p>
      <div class="row" style="align-items:flex-start;gap:16px;flex-wrap:wrap"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;flex:1;min-width:240px">${imports.map(([n, d, u]) => `<a class="btn" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-decoration:none" href="${h(u)}"><b>${h(n)}</b><span class="mut" style="font-size:12px">${h(d)}</span></a>`).join('')}</div>
      <img src="/admin/api/sub/qr" alt="订阅二维码" width="200" height="200" style="border-radius:10px;background:#fff;flex:none"></div></div>` : ''}
    <div class="card"><h2><i></i>节点站点（互联）</h2>
      <div class="f" style="margin-bottom:10px"><label>UUID（所有节点站点必须与主站一致）· 来源：${S.uuidSource === 'derived' ? '由 ADMIN + KEY 推导（没有设置合法的 UUID 环境变量）' : '环境变量 UUID'}</label><div class="sub"><input readonly value="${h(S.uuid || '')}"><button class="btn" data-copy="${h(S.uuid || '')}">复制</button></div></div>
      <p class="mut" style="margin:0">每个节点站点只需要：① 上传同一份 <code>_worker.js</code>（可以是旧版本，只要数据面版本不低于 v${S.dataplane?.version ?? 1}）；② 环境变量 <code>UUID</code> 填上面这个（不需要 ADMIN）；③ <b>不要绑定 KV</b>；④ 绑定自己的域名并在「账号」页添加。主站升级通常不需要重新部署节点——在「账号」页点「检测节点」可以看到每个节点的数据面版本。</p></div>
    <div class="card"><h2><i></i>节点域名状态</h2><div class="tw"><table><thead><tr><th>域名</th><th>状态</th><th>已用 / 预算</th><th>消耗速度</th><th>节奏</th><th style="min-width:160px">分配占比</th></tr></thead><tbody>
      ${hosts.map((x) => `<tr><td>${h(x.host)}${paidHost(x.host) ? ' <span class="tag" title="Workers Paid：承载地区条目">付费</span>' : ''}${/(^|\.)(pages|workers)\.dev$/i.test(x.host) ? ' <span class="pill p-low" title="Cloudflare 默认分配的域名，中国大陆普遍被干扰（卡、慢、断）。建议绑定自定义域名">默认域名</span>' : ''}</td><td><span class="pill p-${h(x.state)}" title="${h(stateTip(x.state))}">${STATE_CN[x.state] || h(x.state)}</span></td><td>${fmtN(x.used)} / ${fmtN(x.budget)}</td><td>${x.rate ? Math.round(x.rate) + ' /分' : '<span class="mut">-</span>'}</td><td>${paceTxt(x.pace)}</td><td><div class="row" style="flex-wrap:nowrap"><div class="bar"><i style="width:${Math.min(100, (x.sharePct || 0) * 2.5)}%"></i></div><span style="min-width:44px">${(x.sharePct || 0).toFixed(1)}%</span></div></td></tr>`).join('') || '<tr><td colspan="6" class="mut">还没有节点域名：请在「账号」页添加</td></tr>'}
    </tbody></table></div></div>`;
  }
  function pgNet() {
    return `<div class="card"><h2><i></i>网络信息检测<span class="sp"></span><button class="btn p" id="netGo">检测</button></h2>
      <div class="note">显示 Cloudflare 看到的你当前的网络信息，以及订阅会据此自适应的结果（运营商决定随机优选使用哪份 CIDR / 优选池）。</div>
      <dl class="kv" id="netOut"><dt>状态</dt><dd class="mut">点击「检测」</dd></dl></div>
    <div class="card"><h2><i></i>反代 / 链式代理检测</h2>
      <div class="grid"><div class="f"><label>类型</label><select id="chkType"><option>socks5</option><option>http</option><option>https</option><option>turn</option><option>sstp</option></select></div>
      <div class="f wide"><label>地址（user:pass@host:port 或 host:port）</label><input id="chkVal" placeholder="user:pass@1.2.3.4:1080"></div></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="chkGo">检测代理</button></div><div id="chkOut"></div></div>
    <div class="card"><h2><i></i>优选 URL 检测</h2>
      <div class="f"><label>每行一个 URL（留空 = 使用已保存的优选订阅）</label><textarea class="mono" id="bestUrls" placeholder="https://example.com/ip.txt&#10;https://example.com/{isp}.csv"></textarea></div>
      <div class="row" style="margin-top:12px"><select id="bestIsp" style="width:auto"><option value="cf">官方 cf</option><option value="ct">电信 ct</option><option value="cu">联通 cu</option><option value="cmcc">移动 cmcc</option></select><button class="btn" id="bestGo">检测优选 URL</button></div><div id="bestOut"></div></div>`;
  }
  // 账号页多选模式（点「多选」才出现复选框与批量操作条）
  let accMulti = false;
  const accPicked = new Set();
  // Account ID 不再单独占一列：轮询时用 Token 自动发现并回填。只有自动发现失败（Token 读不到账户列表）时才在该行露出输入框
  // 也包括"填过的 ID 与 Token 不属于同一账户"（未找到账户数据），否则隐藏后就没法改了
  const needAccId = (a) => { const u = S.usage?.accounts?.[a.id] || {}; return u.ok === false && /账户获取失败|未找到账户/.test(String(u.err || '')); };
  function pgAccounts() {
    const rows = S.accounts.map((a, i) => {
      if (a.role === 'main') return ''; // 主号在「额度 → 主号额度」里设置
      const tags = (a.role === 'main' ? ' <span class="tag" title="旧版迁移的主站账号：只监控用量，不承载节点">主站</span>' : '');
      const accIdBox = needAccId(a) ? `<div style="margin-top:6px"><input data-k="accountId" value="${h(a.auth?.accountId || '')}" placeholder="自动获取失败：填 32 位 Account ID" style="min-width:220px"></div>` : '';
      return `<tr data-i="${i}">${accMulti ? `<td><input type="checkbox" data-pick="${i}" ${accPicked.has(i) ? 'checked' : ''}></td>` : ''}<td title="${h(a.auth?.accountId ? 'Account ID：' + a.auth.accountId : 'Account ID：首次轮询自动获取')}"><input data-k="name" value="${h(a.name)}" style="min-width:90px">${tags}</td>
        <td><input data-k="hosts" value="${h((a.hosts || []).join(','))}" style="min-width:180px"></td>
        <td style="white-space:normal;min-width:200px">${pollStatus(a)}${accIdBox}</td>
        <td><input type="checkbox" data-k="enabled" ${a.enabled !== false && a.role !== 'off' ? 'checked' : ''}></td>
        <td><input type="checkbox" data-k="paid" ${a.paid ? 'checked' : ''} title="该账号开通了 Workers Paid：地区条目只分配给付费账号的域名（Workers Paid 设置在「额度」页）"></td>
        <td><input data-k="weight" type="number" step="any" value="${h(a.weight)}" style="width:70px"></td>
        <td><input data-k="apiToken" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${a.auth?.hasToken ? '已设置（留空保持）' : a.auth?.hasKey ? '用 Global Key（留空保持）' : '未设置'}" style="min-width:130px"></td>
        <td><button class="btn d" data-del="${i}">删除</button></td></tr>`;
    }).join('');
    const cols = accMulti ? 9 : 8;
    const bar = accMulti ? `<div class="row" style="margin-bottom:10px;gap:8px"><label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="pickAll" ${S.accounts.some((a) => a.role !== 'main') && accPicked.size === S.accounts.filter((a) => a.role !== 'main').length ? 'checked' : ''}>全选</label><span class="mut">已选 ${accPicked.size} 个</span><span class="sp"></span><button class="btn" id="bEnable">启用</button><button class="btn" id="bDisable">禁用</button><button class="btn" id="bPoll">轮询所选</button><button class="btn d" id="bDel">删除</button></div>` : '';
    return `<div class="card"><h2><i></i>账号<span class="sp"></span><button class="btn" id="addAcc">添加</button><button class="btn${accMulti ? ' p' : ''}" id="multiAcc">${accMulti ? '退出多选' : '多选'}</button><button class="btn" id="pollAcc">轮询</button><button class="btn p" id="saveAcc">保存</button></h2>
      ${bar}<div class="tw"><table><thead><tr>${accMulti ? '<th></th>' : ''}<th>名称</th><th>节点域名（逗号分隔）</th><th>轮询状态</th><th>启用</th><th title="该账号开通了 Workers Paid">付费</th><th>权重</th><th>API Token</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="${cols}" class="mut">暂无账号</td></tr>`}</tbody></table></div>
      <p class="mut">每个账号默认都是节点账号：启用后它的域名参与节点分配，并监控用量；不启用 = 停用。API Token 需要「Account Analytics: Read」权限；Account ID 不用填，首次轮询会用 Token 自动获取并保存（换 Token 后会重新获取）。批量操作（启用 / 禁用 / 删除）立即生效，不需要再点保存。</p>
      <p class="mut" style="margin-top:6px"><b>轮询失败怎么办：</b>① 「账户获取失败 / 未找到账户」是 Token 读不到账户列表——该行会出现 Account ID 输入框，填上 32 位 ID 即可；② 「401/403（auth）」是 Token 无效或没有 Account Analytics: Read 权限；「400」多半是凭据填错（例如浏览器把密码自动填进了 Token 栏），重新粘贴 Token；③ 「过期」是超过 ${S.settings.usage?.staleMinutes ?? 60} 分钟没更新（Pages 没有 Cron：点「轮询」或用脚本定时调用 <code>POST /admin/api/usage/poll</code>）。手动轮询每分钟最多 1 次。</p></div>
    <div class="card"><h2><i></i>检测节点<span class="sp"></span><button class="btn" id="nodeCheck">检测全部节点</button></h2>
      <p class="mut" style="margin:0 0 10px">在你的浏览器里直接访问每个节点的 <code>/version</code>，检查：域名是否生效、UUID 是否与主站一致、数据面版本是否落后。每个节点会多 1 次请求（不占主站额度）。</p><div id="nodeOut"></div></div>
    <div class="card"><h2><i></i>批量导入</h2><div class="f"><label>每行：域名,AccountID,APIToken[,名称] 或 域名,邮箱,GlobalKey；也可粘贴旧用量面板的 usage_config.json</label><textarea class="mono" id="impText" placeholder="vp2.example.com,0123456789abcdef0123456789abcdef,token…,二号"></textarea></div>
      <div class="row" style="margin-top:8px"><select id="impFmt" style="width:auto"><option value="lines">按行</option><option value="usage_panel_json">用量面板 JSON</option></select>
      <select id="impMode" style="width:auto"><option value="merge">合并</option><option value="replace">替换全部</option></select>
      <button class="btn" id="impDry">预览</button><button class="btn p" id="impGo">导入</button></div><div id="impOut"></div></div>`;
  }
  // 主号：主站所在的 Cloudflare 账号（role=main，只监控用量，不承载节点）
  const mainLimitOf = (m) => {
    const dflt = S.settings.paid?.main ? (S.settings.paid?.dailyBudget || 330000) : (S.settings.usage?.limitPerAccount || 100000);
    return { limit: m && Number(m.limit) > 0 ? Number(m.limit) : dflt, dflt };
  };
  function mainCard() {
    const m = mainAccount();
    const u = m ? (S.usage?.accounts?.[m.id] || {}) : {};
    const paid = !!S.settings.paid?.main;
    const { limit, dflt } = mainLimitOf(m);
    const used = Number(u.used) || 0;
    const known = !!u.polledAt;
    const kpi = (v, label) => `<div class="kpi"><b>${v}</b><span>${label}</span></div>`;
    const accIdBox = m && needAccId(m) ? `<div class="f"><label>Account ID（自动获取失败，请手动填 32 位 ID）</label><input data-main="accountId" value="${h(m.auth?.accountId || '')}"></div>` : '';
    return `<section class="card"><h2><i></i>主号额度<span class="sp"></span><button class="btn" id="mainPoll">轮询主号</button></h2>
      <p class="desc">主站所在的 Cloudflare 账号：全部订阅拉取、后台访问${paid ? '，以及走主站的地区条目' : ''}都算在它上面。填上 API Token 就能看到它今天用了多少；它只被监控，不参与节点分配。</p>
      <div class="hero">${ring(used, limit)}<div class="kpis">
        ${kpi(known ? fmtN(used) : '-', '今日已用')}
        ${kpi(fmtN(limit), '每日额度' + (paid ? '（付费版预算）' : ''))}
        ${kpi(known ? fmtN(Math.max(0, limit - used)) : '-', '剩余')}
        ${kpi(u.rate ? Math.round(u.rate) + ' /分' : '-', '消耗速度')}
        ${kpi(known ? fmtN(u.workers) + ' · ' + fmtN(u.pages) : '-', 'Workers · Pages')}
      </div></div>
      <p class="mut" style="margin:12px 0 14px">轮询状态：${m ? pollStatus(m) : '<span class="mut">还没设置主号</span>'}</p>
      <div class="grid">
        <div class="f"><label>API Token（需要 Account Analytics: Read）</label><input data-main="apiToken" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${m?.auth?.hasToken ? '已设置（留空保持）' : '未设置'}"></div>
        <div class="f"><label>每日额度（留空 = ${paid ? '付费版预算' : '免费版'} ${fmtN(dflt)}）</label><input data-main="limit" type="number" step="1" value="${h(m && Number(m.limit) > 0 ? m.limit : '')}"></div>
        ${accIdBox}
      </div></section>`;
  }
  function pgQuota() { return mainCard() + sectionHtml('quota'); }
  function pgSources() {
    return sectionHtml('sources').replace('<div class="savebar"', `<section class="card"><h2><i></i>预览订阅<span class="sp"></span><button class="btn sm" id="pv">预览</button></h2><p class="desc">按本页当前填写的内容（包括还没保存的改动）生成一份订阅，看看会有哪些节点、分到哪些域名。</p><div id="pvOut" class="out"></div></section><div class="savebar"`);
  }
  function pgSub() {
    const lists = S.rules?.lists || [];
    const ini = S.rules?.ini;
    const status = `<section class="card"><h2><i></i>转换配置（INI）缓存<span class="sp"></span><button class="btn sm" id="iniFetch">获取并保存</button></h2>
      ${ini ? `<dl class="kv"><dt>来源</dt><dd>${h(ini.url)}</dd><dt>保存时间</dt><dd>${fmtT(ini.fetchedAt)}</dd><dt>内容</dt><dd>${ini.groups} 个代理组 · ${ini.rulesets} 条规则集 · ${(ini.bytes / 1024).toFixed(1)} KB</dd>${ini.errors?.length ? `<dt>提示</dt><dd class="mut">${h(ini.errors.slice(0, 3).join('；'))}</dd>` : ''}</dl>` : '<p class="desc">还没有保存过：点击「获取并保存」，会从上面的 INI 地址下载并存进 KV。</p>'}
      <div id="iniOut" class="out"></div></section>
    <section class="card"><h2><i></i>规则列表缓存<span class="sp"></span><button class="btn sm" id="rulesRefresh">立即刷新</button></h2><div class="tw"><table><thead><tr><th>地址</th><th>状态</th><th>条数</th><th>更新时间</th></tr></thead><tbody>
      ${lists.map((l) => `<tr><td title="${h(l.url)}">${h(String(l.url).replace(/^https?:\/\//, '').slice(0, 60))}</td><td><span class="pill ${l.ok ? 'p-ok' : 'p-exhausted'}">${l.ok ? '正常' : h(l.err || '失败')}</span></td><td>${l.n ?? '-'}</td><td>${fmtT(l.fetchedAt)}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">尚未缓存（Cron 每 5 分钟刷新 1 个；也可手动刷新）</td></tr>'}
      </tbody></table></div></section>`;
    return sectionHtml('sub').replace('<div class="savebar"', status + '<div class="savebar"');
  }
  function pgNode() {
    return sectionHtml('node').replace('<div class="savebar"', '<p class="desc pagenote">节点数据面的底层参数（并发拨号、链路超时、DEBUG 等）只能在各节点站点的环境变量里设置，见 README「环境变量」。</p><div class="savebar"');
  }
  function pgNotify() {
    return sectionHtml('notify').replace('<div class="savebar"', `<section class="card"><h2><i></i>查看日志<span class="sp"></span><button class="btn sm" id="logLoad">刷新</button><button class="btn sm d" id="logClear">清空</button></h2><div id="logOut" class="tw"><p class="desc">点击「刷新」加载</p></div></section><div class="savebar"`);
  }
  function pgSystem() {
    return sectionHtml('system').replace('<div class="savebar"', `<section class="card"><h2><i></i>备份与重置</h2><p class="desc">备份包含设置与账号（含凭据），请妥善保存。</p><div class="row">
      <button class="btn" id="exp">导出备份</button><label class="btn">导入备份<input type="file" id="impFile" accept=".json" hidden></label>
      <span class="sp"></span><select id="rsScope" style="width:auto"><option value="usage">重置用量</option><option value="logs">清空日志</option><option value="settings">恢复默认设置</option><option value="all">全部重置</option></select>
      <button class="btn d" id="rs">执行重置</button></div></section><div class="savebar"`);
  }
  // ---------------- 用户（多用户专属链接） ----------------
  // 数据不在 state 里：进入本页时单独拉 /admin/api/users（分页），在线统计点按钮才查（每个账号 2 次 AE 查询）
  const U = { q: '', offset: 0, limit: 100, data: null, stats: null, picked: new Set(), made: '' };
  function pgUsers() {
    return '<div id="usersRoot"><div class="card"><p class="mut">加载中…</p></div></div>';
  }
  function usersHtml() {
    const d = U.data;
    if (!d) return '<div class="card"><p class="mut">加载中…</p></div>';
    const acc = d.accounts.map((a) => {
      const m = a.meta || {};
      const st = m.blocked ? '<span class="pill p-exhausted">项目已被封禁</span>'
        : a.ready ? (a.pushed ? '<span class="pill p-ok">就绪</span>' : '<span class="pill p-low">已绑定，待下发</span>')
        : m.nsId && m.bound ? '<span class="pill p-low">已绑定，待重新部署</span>'
        : m.nsId ? '<span class="pill p-low">缺绑定</span>' : '<span class="pill p-stale">未配置</span>';
      const aeNote = m.aeMissing ? ' <span class="pill p-low" title="' + h('这个账号不能用 Analytics Engine（' + (m.aeErr || '未开通或 Token 缺 Account Analytics: Read') + '）：封禁照常生效，在线统计和并行限制对它不生效') + '">无在线统计</span>' : '';
      const err = (m.err || a.error) ? '<div class="mut" style="white-space:normal;color:var(--bad)">' + h(m.err || a.error) + '</div>' : '';
      // 没自动绑定上、或绑定上了但重新部署没成功：都可以手动完成后勾选
      const manual = m.nsId && !m.blocked && !(m.bound && m.redeployed) ? '<label class="chk" style="margin-left:6px"><input type="checkbox" data-mbound="' + h(a.id) + '" ' + (m.manualBound ? 'checked' : '') + '> ' + (m.bound ? '已手动重新部署' : '已手动绑定并部署') + '</label>' : '';
      return '<tr><td>' + h(a.name) + (a.enabled ? '' : ' <span class="tag">未启用</span>') + '</td><td class="mono">' + h(a.cfId ? a.cfId.slice(0, 8) + '…' : '未知') + '</td><td style="white-space:normal;min-width:220px">' + st + (m.project ? ' <span class="mut">Pages：' + h(m.project) + '</span>' : '') + aeNote + manual + err + '</td>'
        + '<td><button class="btn sm" data-setup="' + h(a.id) + '">' + (a.ready ? '重新配置' : '自动配置') + '</button> <button class="btn sm" data-msetup-reset="' + h(a.id) + '">重置</button></td></tr>';
    }).join('');
    const readyN = d.accounts.filter((a) => a.ready).length;
    const rows = d.users.map((u) => {
      const s = U.stats?.stats?.[u.id];
      const lim = u.effLimit ? u.effLimit + (u.limit == null ? '<span class="mut">（默认）</span>' : '') : '不限';
      const online = s ? (s.online ? '<b>' + s.online + '</b>' : '0') + (u.effLimit && s.online > u.effLimit ? ' <span class="pill p-exhausted">超限</span>' : '') : '<span class="mut">-</span>';
      return '<tr><td><input type="checkbox" data-upick="' + u.id + '" ' + (U.picked.has(u.id) ? 'checked' : '') + '></td><td class="mono">' + u.id + '</td><td><input data-uname="' + u.id + '" value="' + h(u.name) + '" style="min-width:90px"></td>'
        + '<td>' + (u.banned ? '<span class="pill p-exhausted">已封禁</span>' : '<span class="pill p-ok">正常</span>') + '</td><td>' + lim + '</td><td>' + online + '</td><td>' + (s && s.conns != null ? fmtN(s.conns) : '<span class="mut">-</span>') + '</td><td>' + (s && s.lastSeen ? fmtT(s.lastSeen) : '<span class="mut">-</span>') + '</td>'
        + '<td><div class="row" style="flex-wrap:nowrap;gap:4px"><input class="mono" readonly value="' + h(u.sub) + '" style="min-width:160px"><button class="btn sm" data-copy="' + h(u.sub) + '">复制</button><a class="btn sm" href="' + h(u.sub) + '" target="_blank" rel="noopener noreferrer" title="用户在浏览器里打开链接看到的页面：各客户端一键导入、二维码">导入页</a></div></td></tr>';
    }).join('');
    const pages = Math.max(1, Math.ceil(d.matched / d.limit));
    const page = Math.floor(d.offset / d.limit) + 1;
    const statsNote = U.stats ? '统计范围：' + U.stats.accounts + ' 个账号' + (Object.keys(U.stats.errors || {}).length ? '，' + Object.keys(U.stats.errors).length + ' 个查询失败：' + h(Object.values(U.stats.errors)[0]) : '') : '点「刷新在线」查询（每个已配置账号 2 次 Analytics Engine 查询）';
    return '<div class="card"><h2><i></i>节点账号配置<span class="sp"></span><button class="btn sm" id="uSync">立即同步</button></h2>'
      + '<p class="mut" style="margin:0 0 10px">每个节点账号要有 KV 绑定 <code>NT_MU</code>（命名空间 nicetunnel-mu）和 Analytics Engine 绑定 <code>NT_AE</code>（数据集 nicetunnel_mu），加完重新部署一次。「自动配置」用账号的 Token 完成这些，Token 需要 <b>Workers KV Storage: Edit</b>、<b>Cloudflare Pages: Edit</b>、<b>Account Analytics: Read</b> 权限。自动配置失败时按上面的名字在 Pages 项目「设置 → 绑定」里手动加，再勾「已手动绑定」。'
      + '主站 Worker 建议再加一个每分钟的 Cron 触发器 <code>* * * * *</code>（保留原来的 <code>*/5 * * * *</code>）。封禁约 1~2 分钟生效；并行超限约 2~7 分钟（超限名单最快 5 分钟下发一次，省 KV 写入额度）。不加触发器则最慢 5 分钟同步一次。原来的共享订阅仍然有效，不受这里的封禁和并行限制。</p>'
      + '<div class="tw"><table><thead><tr><th>账号</th><th title="Cloudflare Account ID">CF 账号</th><th>状态</th><th></th></tr></thead><tbody>' + (acc || '<tr><td colspan="4" class="mut">还没有节点账号</td></tr>') + '</tbody></table></div>'
      + '<p class="mut">' + readyN + ' / ' + d.accounts.length + ' 个账号就绪。用户订阅只分配到就绪的账号；一个都没有时用主站自己。' + (d.sync ? '上次同步 ' + fmtT(d.sync.at) + '，超限用户 ' + d.sync.over + ' 个' + (d.sync.errors ? '，' + d.sync.errors + ' 个账号出错' : '') + '。' : '') + '</p></div>'
      + '<div class="card"><h2><i></i>批量生成</h2><div class="row" style="gap:8px;align-items:flex-end">'
      + '<div class="f"><label>数量（1~500）</label><input id="uCount" type="number" value="10" min="1" max="500" style="width:100px"></div>'
      + '<div class="f"><label>名称前缀（可空）</label><input id="uPrefix" placeholder="例如 客户A-" style="width:160px"></div>'
      + '<div class="f"><label>并行上限（空 = 默认 ' + d.defaultLimit + '，0 = 不限）</label><input id="uLimit" type="number" min="0" max="50" style="width:100px"></div>'
      + '<button class="btn p" id="uCreate">生成</button></div>'
      + (U.made ? '<div class="f wide" style="margin-top:10px"><label>新生成的订阅链接（每行一个）</label><textarea class="mono" readonly style="min-height:120px">' + h(U.made) + '</textarea><div><button class="btn sm" data-copy="' + h(U.made) + '">全部复制</button></div></div>' : '')
      + '<p class="mut">链接永久有效。每条链接对应一个用户：节点用他自己的凭据，封禁或删除后立即失效（约 1~2 分钟内到达各节点）。原有的订阅链接不受影响。</p></div>'
      + '<div class="card"><h2><i></i>用户（' + d.total + '）<span class="sp"></span><input id="uQ" value="' + h(U.q) + '" placeholder="搜索 ID / 名称" style="width:160px"><button class="btn sm" id="uSearch">搜索</button><button class="btn sm" id="uStats">刷新在线</button></h2>'
      + '<div class="row" style="gap:8px;margin-bottom:10px"><label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="uPickAll" ' + (d.users.length && d.users.every((u) => U.picked.has(u.id)) ? 'checked' : '') + '>全选本页</label><span class="mut">已选 ' + U.picked.size + ' 个</span><span class="sp"></span>'
      + '<button class="btn sm" id="uBan">封禁</button><button class="btn sm" id="uUnban">解封</button><input id="uSetLimit" type="number" min="0" max="50" placeholder="并行数" style="width:80px"><button class="btn sm" id="uApplyLimit">设并行</button><button class="btn sm" id="uDefLimit">恢复默认</button><button class="btn sm" id="uCopySel">复制链接</button><button class="btn sm d" id="uDel">删除</button></div>'
      + '<div class="tw"><table><thead><tr><th></th><th>ID</th><th>名称</th><th>状态</th><th>并行上限</th><th title="最近 5 分钟有连接的不同 IP 数">在线 IP</th><th>24 小时连接</th><th>最后在线</th><th>订阅链接</th></tr></thead><tbody>' + (rows || '<tr><td colspan="9" class="mut">' + (d.total ? '没有匹配的用户' : '还没有用户：在上面批量生成') + '</td></tr>') + '</tbody></table></div>'
      + '<div class="row" style="margin-top:8px;gap:8px"><span class="mut">' + statsNote + '</span><span class="sp"></span><button class="btn sm" id="uPrev" ' + (page <= 1 ? 'disabled' : '') + '>上一页</button><span class="mut">' + page + ' / ' + pages + '</span><button class="btn sm" id="uNext" ' + (page >= pages ? 'disabled' : '') + '>下一页</button></div>'
      + '<p class="mut">并行上限按"同时在线的不同 IP"计（IPv6 按 /64）：超过后，先连上的设备保留，多出来的新连接被拒绝。同一台设备同时有 IPv4 和 IPv6 会算 2 个，手机切换网络时旧 IP 约 5 分钟后释放，所以一个人建议设 2。</p></div>';
  }
  async function usersLoad() {
    const qs = 'users?offset=' + U.offset + '&limit=' + U.limit + (U.q ? '&q=' + encodeURIComponent(U.q) : '');
    U.data = await api(qs);
    usersPaint();
  }
  function usersPaint() {
    const root = $('#usersRoot'); if (!root) return;
    root.innerHTML = usersHtml();
    usersBind(root);
  }
  function usersInit(root) {
    if (U.data) usersPaint();
    usersLoad().catch((e) => { const r = $('#usersRoot'); if (r) r.innerHTML = '<div class="card"><p class="mut">加载失败：' + h(e.message) + '</p></div>'; });
  }
  function usersBind(root) {
    const on = (id, fn) => { const el = $('#' + id, root); if (el) el.addEventListener('click', run(fn)); };
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('已复制'), () => toast('复制失败，请手动选择'));
    }));
    const pushMsg = (r) => (r.push && r.push.errors && Object.keys(r.push.errors).length ? '（' + Object.keys(r.push.errors).length + ' 个账号下发失败，看上面的状态）' : '');
    const sel = () => { if (!U.picked.size) { toast('先勾选用户'); return null; } return [...U.picked]; };
    const upd = async (body, msg) => { const ids = sel(); if (!ids) return; const r = await api('users/update', 'POST', { ids, ...body }); toast(msg + ' ' + r.updated + ' 个' + pushMsg(r)); await usersLoad(); };
    on('uCreate', async () => {
      const lim = $('#uLimit', root).value.trim();
      const r = await api('users/create', 'POST', { count: Number($('#uCount', root).value), prefix: $('#uPrefix', root).value, limit: lim === '' ? null : Number(lim) });
      U.made = r.created.map((u) => (u.name ? u.name + ' ' : '') + u.sub).join('\n');
      U.offset = 0; toast('已生成 ' + r.created.length + ' 个' + pushMsg(r)); await usersLoad();
    });
    on('uSearch', async () => { U.q = $('#uQ', root).value.trim(); U.offset = 0; await usersLoad(); });
    const q = $('#uQ', root); if (q) q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#uSearch', root).click(); } });
    on('uStats', async () => { U.stats = await api('users/stats', 'POST', {}); usersPaint(); });
    on('uSync', async () => { const r = await api('users/sync', 'POST', {}); toast('已同步：在线 ' + r.online + '，超限 ' + r.over + (Object.keys(r.errors || {}).length ? '，' + Object.keys(r.errors).length + ' 个账号出错' : '')); await usersLoad(); });
    on('uPrev', async () => { U.offset = Math.max(0, U.offset - U.limit); await usersLoad(); });
    on('uNext', async () => { U.offset += U.limit; await usersLoad(); });
    on('uBan', () => upd({ banned: true }, '已封禁'));
    on('uUnban', () => upd({ banned: false }, '已解封'));
    on('uApplyLimit', () => { const v = $('#uSetLimit', root).value.trim(); if (v === '') return toast('先填并行数（0 = 不限）'); return upd({ limit: Number(v) }, '已设置'); });
    on('uDefLimit', () => upd({ limit: null }, '已恢复默认'));
    on('uDel', async () => { const ids = sel(); if (!ids) return; if (!confirm('删除选中的 ' + ids.length + ' 个用户？他们的链接会立即失效，且无法恢复。')) return; const r = await api('users/delete', 'POST', { ids }); U.picked.clear(); toast('已删除 ' + r.removed + ' 个' + pushMsg(r)); await usersLoad(); });
    on('uCopySel', () => {
      const ids = sel(); if (!ids) return;
      const set = new Set(ids);
      const text = U.data.users.filter((u) => set.has(u.id)).map((u) => (u.name ? u.name + ' ' : '') + u.sub).join('\n');
      if (!text) return toast('选中的用户不在本页');
      return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('已复制本页选中的链接'), () => toast('复制失败'));
    });
    root.querySelectorAll('[data-upick]').forEach((c) => c.addEventListener('change', () => { if (c.checked) U.picked.add(c.dataset.upick); else U.picked.delete(c.dataset.upick); usersPaint(); }));
    const all = $('#uPickAll', root);
    if (all) all.addEventListener('change', () => { U.data.users.forEach((u) => (all.checked ? U.picked.add(u.id) : U.picked.delete(u.id))); usersPaint(); });
    root.querySelectorAll('[data-uname]').forEach((i) => i.addEventListener('change', run(async () => { await api('users/update', 'POST', { ids: [i.dataset.uname], name: i.value }); toast('已改名'); })));
    root.querySelectorAll('[data-setup]').forEach((b) => b.addEventListener('click', run(async () => {
      toast('配置中…（建 KV、加绑定、重新部署）');
      const r = await api('users/setup', 'POST', { id: b.dataset.setup });
      toast(r.ready ? '已就绪' + (r.meta.redeployed ? '，节点正在重新部署（约 1 分钟）' : '') : '未完成：' + (r.meta.err || '见状态'));
      await usersLoad();
    })));
    root.querySelectorAll('[data-msetup-reset]').forEach((b) => b.addEventListener('click', run(async () => {
      if (!confirm('清除这个账号的配置记录？（不会删除 Cloudflare 上的 KV 和绑定）')) return;
      await api('users/setup', 'POST', { id: b.dataset.msetupReset, reset: true }); await usersLoad();
    })));
    root.querySelectorAll('[data-mbound]').forEach((c) => c.addEventListener('change', run(async () => {
      await api('users/setup', 'POST', { id: c.dataset.mbound, manualBound: c.checked }); toast(c.checked ? '已标记为手动绑定' : '已取消'); await usersLoad();
    })));
  }
  const ICONS = {
    users: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/><path d="M17.5 4.5l1.5 1.5 3-3"/>',
    overview: '<path d="M3 12l9-8 9 8M5 10v10h14V10"/>',
    accounts: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a3 3 0 100-6M21 20c0-2.6-1.7-4.8-4-5.6"/>',
    quota: '<path d="M12 3a9 9 0 109 9h-9z"/><path d="M15 3.5A9 9 0 0120.5 9H15z"/>',
    sources: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    node: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    sub: '<path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/>',
    notify: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 19a2 2 0 004 0"/>',
    tools: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    system: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  };
  // 页面顺序：日常（概览 / 账号 / 额度）→ 节点与订阅（来源 / 参数 / 订阅规则）→ 运维（通知日志 / 检测工具 / 系统）
  const PAGES = { overview: ['概览', pgOverview], accounts: ['账号', pgAccounts], users: ['用户', pgUsers], quota: ['额度', pgQuota], sources: ['节点来源', pgSources], node: ['节点参数', pgNode], sub: ['订阅与规则', pgSub], notify: ['通知与日志', pgNotify], tools: ['检测工具', pgNet], system: ['系统', pgSystem] };
  const OLD_TABS = { pref: 'sources', net: 'tools', adv: 'system' }; // 旧版记住的页名

  function render() {
    tab = OLD_TABS[tab] || tab;
    // 「用户」页只在系统设置里开启多用户后出现
    const shown = (k) => k !== 'users' || !!S.settings.users?.enabled;
    if (!PAGES[tab] || !shown(tab)) tab = 'overview';
    $('nav').innerHTML = Object.entries(PAGES).filter(([k]) => shown(k)).map(([k, [n]]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg><span>${n}</span></button>`).join('');
    const main = $('main');
    main.innerHTML = `<div class="top"><h1>${PAGES[tab][0]}</h1><span class="sub-h">${h(S.host || '')}</span></div>` + PAGES[tab][1]();
    buildToc(main);
    bind(main);
  }

  // ---------------- 页内索引 ----------------
  // 每页标题下一排小标签，对应本页的每张卡片：点击滚到那张卡片，滚动时高亮当前所在的卡片。
  // 吸顶显示；手机上顶部导航也吸顶，索引贴在它下面，标签可横向滑动，当前标签自动滑进可见区域。卡片少于 3 张时不显示。
  const tocTitle = (card) => {
    const t = card.querySelector('h2')?.cloneNode(true);
    if (!t) return '';
    t.querySelectorAll('.btn, .hint, .sp, label, select, input').forEach((x) => x.remove());
    return t.textContent.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  };
  function buildToc(main) {
    const cards = [...main.querySelectorAll(':scope > .card')];
    if (cards.length < 3) return;
    cards.forEach((c, i) => { c.id = 'sec-' + i; });
    // 用 div 而不是 nav：全局的 nav 样式（侧栏用，纵向排列）会套到索引上
    const toc = document.createElement('div');
    toc.className = 'toc';
    toc.setAttribute('role', 'navigation');
    toc.setAttribute('aria-label', '本页索引');
    toc.innerHTML = cards.map((c, i) => `<a href="#sec-${i}" data-sec="${i}">${h(tocTitle(c) || '第 ' + (i + 1) + ' 项')}</a>`).join('');
    main.querySelector('.top').after(toc);
    toc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-sec]'); if (!a) return;
      e.preventDefault();
      const card = cards[Number(a.dataset.sec)];
      tocLock = Date.now() + 700; // 平滑滚动期间不按滚动位置改高亮，避免高亮来回跳
      markToc(Number(a.dataset.sec));
      window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - tocOffset(), behavior: 'smooth' });
    });
    syncToc();
  }
  let tocLock = 0;
  /** 吸顶区域的总高度：手机上的顶部导航（吸顶）+ 索引本身 + 一点间距 */
  function tocOffset() {
    const aside = $('aside'), toc = $('.toc');
    const asideH = aside && getComputedStyle(aside).position === 'sticky' && innerWidth <= 860 ? aside.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--stick', asideH + 'px');
    return asideH + (toc ? toc.getBoundingClientRect().height : 0) + 12;
  }
  function markToc(i) {
    const toc = $('.toc'); if (!toc) return;
    toc.querySelectorAll('a').forEach((a) => a.classList.toggle('on', Number(a.dataset.sec) === i));
    const on = toc.querySelector('a.on');
    // 只横向滚动索引条本身（scrollIntoView 会顺带滚动整页）
    if (on && (on.offsetLeft < toc.scrollLeft || on.offsetLeft + on.offsetWidth > toc.scrollLeft + toc.clientWidth)) toc.scrollTo({ left: on.offsetLeft - 16, behavior: 'smooth' });
  }
  function syncToc() {
    const toc = $('.toc'); if (!toc || Date.now() < tocLock) return;
    const cards = [...document.querySelectorAll('main > .card[id^="sec-"]')];
    const line = tocOffset() + 8;
    let cur = 0;
    cards.forEach((c, i) => { if (c.getBoundingClientRect().top <= line) cur = i; });
    // 滚到底了：最后一张卡片可能顶不到索引线。只在页面确实能滚动、并且已经往下滚过时才这样算（整页一屏放得下时保持高亮第一项）
    const docH = document.documentElement.scrollHeight;
    if (docH > innerHeight + 4 && window.scrollY > 0 && window.scrollY + innerHeight >= docH - 4) cur = cards.length - 1;
    markToc(cur);
  }
  // 滚动时节流更新高亮（最多每 80ms 一次，停下后再补一次）
  let tocAt = 0, tocTimer = 0;
  window.addEventListener('scroll', () => {
    const now = Date.now();
    clearTimeout(tocTimer);
    if (now - tocAt >= 80) { tocAt = now; syncToc(); }
    tocTimer = setTimeout(syncToc, 100);
  }, { passive: true });
  window.addEventListener('resize', () => syncToc());

  function bind(root) {
    if ($('#usersRoot', root)) usersInit(root);
    // 改动追踪：设置页有未保存的改动时才显示底部保存栏（显示改了几项）；离开页面前提醒
    dirty = false;
    const bar = $('#saveBar', root);
    if (bar) {
      const countLeaves = (o) => Object.values(o).reduce((n, v) => n + (v && typeof v === 'object' && !Array.isArray(v) ? countLeaves(v) : 1), 0);
      const refresh = () => { const n = countLeaves(collectPatch(root)) + (collectMain(root) ? 1 : 0); dirty = n > 0; bar.hidden = !dirty; $('#dirtyN', root).textContent = '有 ' + n + ' 项改动未保存'; };
      root.addEventListener('input', (e) => { if (e.target.closest('[data-p], [data-main]')) refresh(); });
      root.addEventListener('change', (e) => { if (e.target.closest('[data-p], [data-main]')) refresh(); });
      $('#undoSave', root).addEventListener('click', () => { dirty = false; render(); toast('已撤销改动'); });
    }
    root.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', run(() => saveSettings(root))));
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('已复制'), () => { const i = b.previousElementSibling; i.select(); document.execCommand('copy'); toast('已复制'); });
    }));
    const on = (id, fn) => { const el = $('#' + id, root); if (el) el.addEventListener('click', run(fn)); };
    on('poll', async () => { const r = await api('usage/poll', 'POST', {}); S.usage = r.usage; S.pool = r.pool; toast('已轮询 ' + (r.polled || []).length + ' 个账号'); render(); });
    // 账号
    const readRows = () => S.accounts.map((a, i) => {
      const tr = $(`tr[data-i="${i}"]`, root); if (!tr) return a;
      const g = (k) => $(`[data-k="${k}"]`, tr);
      // 角色不再让用户选：一律是节点账号（旧版迁移的 main 保持不变；off 转成"不启用"）。Account ID 留空 = 保持已保存的 / 自动获取
      return { ...a, name: g('name').value, hosts: g('hosts').value.split(/[\s,]+/).filter(Boolean), role: a.role === 'main' ? 'main' : 'node', enabled: g('enabled').checked, paid: !!g('paid')?.checked,
        weight: Number(g('weight').value) || 1, auth: { accountId: (g('accountId')?.value || '').trim(), apiToken: g('apiToken').value.trim(), email: a.auth?.email || '', globalKey: '' } };
    });
    const saveRows = async (list, msg) => { const r = await api('accounts', 'PUT', { accounts: list, mode: 'replace' }); S.accounts = r.accounts; accPicked.clear(); toast(msg); await reload(); };
    const doPoll = async (ids) => {
      const r = await api('usage/poll', 'POST', ids ? { ids } : {});
      S.usage = r.usage; S.pool = r.pool;
      const fails = (r.polled || []).filter((p) => !p.ok).length;
      toast('已轮询 ' + (r.polled || []).length + ' 个账号' + (fails ? '，失败 ' + fails + ' 个（看「轮询状态」）' : ''));
      await reload();
    };
    on('pollAcc', () => doPoll());
    on('mainPoll', () => { const m = mainAccount(); if (!m || !(m.auth?.hasToken || m.auth?.hasKey)) return toast('先填主号的 API Token 并保存'); return doPoll([m.id]); });
    on('multiAcc', () => { S.accounts = readRows(); accMulti = !accMulti; accPicked.clear(); render(); });
    root.querySelectorAll('[data-pick]').forEach((c) => c.addEventListener('change', () => { const i = Number(c.dataset.pick); if (c.checked) accPicked.add(i); else accPicked.delete(i); S.accounts = readRows(); render(); }));
    const pickAll = $('#pickAll', root);
    if (pickAll) pickAll.addEventListener('change', () => { S.accounts = readRows(); accPicked.clear(); if (pickAll.checked) S.accounts.forEach((a, i) => { if (a.role !== 'main') accPicked.add(i); }); render(); });
    const needPick = () => { if (!accPicked.size) { toast('先勾选账号'); return false; } return true; };
    on('bEnable', () => needPick() && saveRows(readRows().map((a, i) => (accPicked.has(i) ? { ...a, enabled: true } : a)), '已启用 ' + accPicked.size + ' 个'));
    on('bDisable', () => needPick() && saveRows(readRows().map((a, i) => (accPicked.has(i) ? { ...a, enabled: false } : a)), '已禁用 ' + accPicked.size + ' 个'));
    on('bDel', () => { if (!needPick()) return; const n = accPicked.size; if (!confirm('删除选中的 ' + n + ' 个账号？此操作立即生效。')) return; return saveRows(readRows().filter((_, i) => !accPicked.has(i)), '已删除 ' + n + ' 个'); });
    on('bPoll', () => { if (!needPick()) return; const ids = [...accPicked].map((i) => S.accounts[i]?.id).filter(Boolean); if (!ids.length) return toast('所选账号还没保存，先点保存'); return doPoll(ids); });
    on('nodeCheck', async () => {
      const paidMain = S.settings.paid?.main ? (S.settings.paid.mainHosts?.length ? S.settings.paid.mainHosts : [S.host].filter(Boolean)) : [];
      const hosts = [...new Set(S.accounts.filter((a) => a.role === 'node' && a.enabled !== false).flatMap((a) => a.hosts || []).concat(S.settings.hosts?.unmanaged || [], paidMain))];
      if (!hosts.length) return toast('还没有节点域名');
      const want = S.dataplane?.version ?? 1;
      const out = $('#nodeOut', root);
      const rows = new Array(hosts.length);
      let next = 0;
      // 节点自报的运行统计（只反映本次检测落到的那个 isolate，看趋势与最近错误）
      const statLine = (st, sk) => { const sock = sk ? '<div class="mut" style="font-size:12px">出站连接：' + (sk.using === 'fetcher' ? 'request.fetcher' + (sk.sockets ? '（备用 sockets 可用）' : '') : sk.using === 'sockets' ? 'cloudflare:sockets' + (sk.fetcher ? '' : '（本环境没有 request.fetcher，已自动改用）') : '无') + '</div>' : ''; return sock + statBody(st); }; const statBody = (st) => { if (!st) return ''; const conn = st.ws + st.post; if (!conn && !st.fails && !st.guardBlocked) return '<div class="mut" style="font-size:12px">本次检测落到一个空闲实例（还没处理过代理连接），统计为空不代表异常；多检测几次或用一阵再看</div>'; const bits = ['本实例近 ' + (st.upMin < 1 ? '不到 1' : st.upMin) + ' 分钟：连接 ' + conn]; if (st.guardBlocked) bits.push('拦截 ' + st.guardBlocked); if (st.authFail) bits.push('UUID/密码错 ' + st.authFail); if (st.regionErr) bits.push('地区路由失败 ' + st.regionErr); if (st.chainOk + st.chainFail) bits.push('链路 成功 ' + st.chainOk + ' / 失败 ' + st.chainFail); if (st.fails) bits.push('失败日志 ' + st.fails); const last = st.recent && st.recent.length ? st.recent[st.recent.length - 1] : null; return '<div class="mut" style="font-size:12px">' + h(bits.join('，')) + (last ? '<br>最近错误（' + last.ago + ' 秒前）：' + h(last.m) : '') + '</div>'; };
      const attempt = async (host) => {
        const t0 = performance.now();
        const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
        try {
          const r = await fetch('https://' + host + '/version?uuid=' + encodeURIComponent(S.uuid) + '&stats=1', { cache: 'no-store', signal: ac.signal });
          const ms = Math.round(performance.now() - t0);
          const text = await r.text();
          let j = null; try { j = JSON.parse(text); } catch {}
          if (!j || j.Version === undefined) return { host, state: 'bad', ms, note: 'UUID 与主站不一致，或设置 UUID 后没有重新部署（Pages 改环境变量要重新部署才生效），或这不是节点站点（返回了伪装页）' };
          // edgetunnel 原版节点：没有 Dataplane 字段。当普通节点完全可用，只是不认识地区路由路径——单独标出，不算"落后"
          if (j.Dataplane === undefined) return { host, state: 'edt', ms, note: 'edgetunnel 原版：可作普通节点；不支持地区路由，开启地区路由前请换成本项目的 _worker.js' };
          const dp = j.Dataplane;
          // 出站 TCP 能力（节点自报）：两种都没有 = 所有代理连接必失败（客户端测速却可能显示正常，因为只测到 CF 入口）
          if (j.Socket && j.Socket.using === 'none') return { host, state: 'bad', ms, dp, st: j.Stats, sk: j.Socket, caps: (j.Caps || []).join(' '), ed: j.Edition || '', note: '无法建立出站连接：运行环境既没有 request.fetcher 也没有 cloudflare:sockets，所有代理连接都会失败。到该 Pages 项目「设置 → 运行时」把兼容性日期改成最新，然后重新部署' };
          if (dp < want) return { host, state: 'old', ms, dp, st: j.Stats, sk: j.Socket, caps: (j.Caps || []).join(' '), ed: j.Edition || '', note: '数据面版本落后，需要更新节点 _worker.js' };
          // 契约版本够、但缺少主站已有的能力（例如 SSTP 保活修正）：照常可用，只是缺少改进，标出来提示更新
          const missing = (S.dataplane?.caps || []).filter((c) => !(j.Caps || []).includes(c));
          return { host, state: missing.length ? 'old' : 'ok', ms, dp, st: j.Stats, sk: j.Socket, caps: (j.Caps || []).join(' '), ed: j.Edition || '', note: missing.length ? '可用，但缺少新能力：' + missing.join(' ') + '（建议更新节点 _worker.js）' : '' };
        } catch (e) {
          const ms = Math.round(performance.now() - t0);
          if (e.name === 'AbortError') return { host, state: 'down', ms, note: '超时（15 秒）：网络太慢 / 域名未生效 / 被拦截 / 节点未部署' };
          // 读不到响应有两种可能：真的连不上，或者连上了但响应没有跨域头（浏览器拦截）。no-cors 请求只要服务器有响应就会成功（得到不透明响应）
          try {
            await fetch('https://' + host + '/version?uuid=' + encodeURIComponent(S.uuid), { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(10000) });
            return { host, state: 'cors', ms, note: '能连上，但读不到版本信息。常见原因：① 节点是 edgetunnel 原版/旧版（没有跨域头） ② 设置 UUID 后没有重新部署（Pages 改环境变量要重新部署才生效） ③ UUID 与主站不一致。点右侧"打开"看原始返回' };
          } catch { return { host, state: 'down', ms, note: '无法连接：域名未生效（DNS/CNAME）/ 被拦截 / 节点未部署' }; }
        } finally { clearTimeout(timer); }
      };
      const one = async (host) => {
        const r = await attempt(host);
        if (r.state !== 'down') return r;
        await new Promise((res) => setTimeout(res, 800));
        const r2 = await attempt(host);
        return r2.state === 'down' ? { ...r2, note: r2.note + '（已重试 1 次）' } : r2;
      };
      const draw = () => {
        const done = rows.filter(Boolean);
        const cnt = (s) => done.filter((x) => x.state === s).length;
        out.innerHTML = '<p>已检测 ' + done.length + ' / ' + hosts.length + '：<span class="pill p-ok">正常 ' + cnt('ok') + '</span> <span class="pill p-low">版本落后 ' + cnt('old') + '</span> <span class="pill p-stale">edt 原版 ' + cnt('edt') + '</span> <span class="pill p-low">读不到 ' + cnt('cors') + '</span> <span class="pill p-exhausted">异常 ' + (cnt('bad') + cnt('down')) + '</span></p><div class="tw"><table><thead><tr><th>域名</th><th>结果</th><th>延迟</th><th>数据面</th><th>说明</th></tr></thead><tbody>' + hosts.map((hst, i) => { const x = rows[i]; if (!x) return '<tr><td>' + h(hst) + '</td><td colspan="4" class="mut">检测中…</td></tr>'; const p = { ok: ['p-ok', '正常'], old: ['p-low', '版本落后'], edt: ['p-stale', 'edt 原版'], cors: ['p-low', '读不到'], bad: ['p-exhausted', 'UUID 不符'], down: ['p-exhausted', '不可达'] }[x.state]; return '<tr><td>' + h(x.host) + '</td><td><span class="pill ' + p[0] + '">' + p[1] + '</span></td><td>' + x.ms + ' ms</td><td>' + (x.dp !== undefined ? 'v' + x.dp + (x.ed ? ' · ' + (x.ed === 'node' ? '节点版' : '完整版') : '') : '-') + '</td><td class="mut">' + h(x.note || '') + statLine(x.st, x.sk) + (x.state === 'ok' ? '' : ' <a href="https://' + h(x.host) + '/version?uuid=' + encodeURIComponent(S.uuid) + '" target="_blank" rel="noopener">打开</a>') + '</td></tr>'; }).join('') + '</tbody></table></div>';
      };
      draw();
      const worker = async () => { while (next < hosts.length) { const i = next++; rows[i] = await one(hosts[i]); draw(); } };
      await Promise.all(Array.from({ length: Math.min(6, hosts.length) }, worker));
      // 把检测结果交给主站：坏节点不再分配给订阅，不支持地区路由的节点不承载地区条目（一次请求、一次 KV 写）
      try {
        const results = rows.filter(Boolean).map((x) => ({ host: x.host, state: x.state, caps: x.caps ? x.caps.split(' ').filter(Boolean) : undefined }));
        const r = await api('hosts/checks', 'POST', { results });
        const note = document.createElement('p');
        note.className = 'mut';
        note.textContent = '已同步到分配（3 天内有效，重新检测即更新）：' + (r.excluded.length ? '不再分配 ' + r.excluded.length + ' 台（不可达 / UUID 不符）：' + r.excluded.join('、') + '；' : '没有需要排除的节点；') + (r.noRegion.length ? '不承载地区节点 ' + r.noRegion.length + ' 台（不支持地区路由）：' + r.noRegion.join('、') : '');
        out.appendChild(note);
      } catch (e) { toast('检测结果同步失败：' + (e.message || e)); }
    });
    on('addAcc', () => { S.accounts = readRows().concat([{ id: '', name: '新账号', hosts: [], role: 'node', enabled: true, weight: 1, limit: null, note: '', auth: {} }]); render(); });
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { const rows = readRows(); rows.splice(Number(b.dataset.del), 1); S.accounts = rows; accPicked.clear(); render(); toast('已删除，记得保存'); }));
    on('saveAcc', async () => { const r = await api('accounts', 'PUT', { accounts: readRows(), mode: 'replace' }); S.accounts = r.accounts; toast('已保存'); await reload(); });
    const imp = async (dryRun) => {
      const r = await api('accounts/import', 'POST', { text: $('#impText', root).value, format: $('#impFmt', root).value, mode: $('#impMode', root).value, dryRun });
      $('#impOut', root).innerHTML = `<p>${dryRun ? '预览' : '已导入'}：新增 ${r.added}，更新 ${r.updated}，共 ${r.accounts.length} 个账号</p>` + (r.errors.length ? `<pre>${h(r.errors.join('\n'))}</pre>` : '');
      if (!dryRun) { S.accounts = r.accounts; toast('导入完成'); }
    };
    on('impDry', () => imp(true));
    on('impGo', () => imp(false));
    // 节点来源：每个测试按钮的结果显示在自己卡片的结果区
    const showOut = (id, html) => { const el = $('#' + id, root); if (el) el.innerHTML = html; };
    const testSrc = async (kind, outId) => {
      const body = { kind };
      if (kind === 'custom') body.text = $('[data-p="preferred.custom.text"]', root).value;
      const r = await api('test-source', 'POST', body);
      showOut(outId, `<h3>测试结果：${r.count} 条（${r.ms}ms）</h3>${r.warnings?.length ? `<pre>${h(r.warnings.join('\n'))}</pre>` : ''}<pre>${h((r.sample || []).join('\n'))}</pre>`);
    };
    on('testCustom', () => testSrc('custom', 'outCustom'));
    on('testRegions', async () => {
      const urls = $('[data-p="preferred.regions.urls"]', root).value.split('\n').map((s) => s.trim()).filter(Boolean);
      const r = await api('test-source', 'POST', { kind: 'regions', urls, regex: $('[data-p="preferred.regions.regex"]', root).value });
      showOut('outRegions', `<h3>地区列表：${r.regions.length} 个地区 / ${r.count} 个节点（${r.ms}ms）</h3>${r.warnings?.length ? `<pre>${h(r.warnings.join('\n'))}</pre>` : ''}<div class="row">${r.regions.map((g) => `<span class="tag">${h(g.name)} × ${g.nodes}</span>`).join('') || '<span class="mut">没有解析到任何地区，请检查列表格式与地区规则</span>'}</div><p class="mut" style="margin:10px 0 0">入口地址：${r.entries} 个${r.entries ? '' : '（列表里没有入口地址，将使用随机优选池的地址作为入口）'}</p>`);
    });
    on('testCidr', () => testSrc('cidr', 'outCidr'));
    on('pv', async () => {
      const r = await api('preview', 'POST', { format: 'raw', settings: collectPatch(root) });
      const share = Object.entries(r.hostShare || {}).sort((a, b) => b[1] - a[1]);
      showOut('pvOut', `<h3>预览：${r.nodes.length} 个节点</h3>
        <div class="tw"><table><thead><tr><th>名称</th><th>来源</th><th>地址</th><th>承载域名</th></tr></thead><tbody>${r.nodes.map((n) => `<tr><td>${h(n.name)}</td><td>${n.origin === 'random' ? '兜底' : n.origin === 'best' ? '优选' : '优质'}</td><td>${h(n.address || '')}${n.port ? ':' + n.port : ''}</td><td>${h(n.host || '')}</td></tr>`).join('')}</tbody></table></div>
        <h3>域名分配</h3><div class="row">${share.map(([k, v]) => `<span class="tag">${h(k)} × ${v}</span>`).join('')}</div>`);
    });
    // 网络检测
    on('netGo', async () => {
      const r = await api('netinfo');
      const rows = [['IP 地址', r.ip], ['IP 段（分配用）', r.prefix || '-'], ['位置', [r.country, r.region, r.city].filter(Boolean).join(' · ') || '-'], ['ASN', r.asn ? `AS${r.asn} ${r.asOrganization}` : '-'],
        ['接入点', r.colo || '-'], ['协议', [r.httpProtocol, r.tlsVersion].filter(Boolean).join(' / ') || '-'], ['识别运营商', r.ispName], ['订阅自适应使用', r.adaptiveIspName], ['客户端 UA', r.ua]];
      $('#netOut', root).innerHTML = rows.map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`).join('');
    });
    on('chkGo', async () => {
      const t = $('#chkType', root).value, v = $('#chkVal', root).value.trim();
      if (!v) return toast('请填写代理地址');
      const r = await fetch('/admin/check?' + t + '=' + encodeURIComponent(v), { credentials: 'same-origin' }).then((x) => x.json());
      $('#chkOut', root).innerHTML = `<pre>${h(JSON.stringify(r, null, 2))}</pre>`;
    });
    on('bestGo', async () => {
      const urls = $('#bestUrls', root).value.split('\n').map((s) => s.trim()).filter(Boolean);
      const r = await api('test-source', 'POST', { kind: 'best', urls: urls.length ? urls : undefined, isp: $('#bestIsp', root).value });
      $('#bestOut', root).innerHTML = `<p>解析到 <b>${r.count}</b> 条（${r.ms}ms）</p>` + (r.warnings?.length ? `<pre>${h(r.warnings.join('\n'))}</pre>` : '') + `<pre>${h((r.sample || []).join('\n'))}</pre>`;
    });
    on('iniFetch', async () => {
      const url = $('[data-p="rules.configUrl"]', root).value.trim();
      const r = await api('rules/ini/fetch', 'POST', url ? { url } : {});
      $('#iniOut', root).innerHTML = `<p style="margin:12px 0 0">${r.changed ? '已获取并保存' : '内容没有变化（已确认最新）'}：${r.groups} 个代理组 · ${r.rulesets} 条规则集${r.rules ? `；规则列表更新 ${r.rules.updated.length} 个，待刷新 ${r.rules.pending} 个（Cron 会继续刷新）` : ''}</p>` + (r.errors?.length ? `<pre>${h(r.errors.join('\n'))}</pre>` : '');
      toast(r.changed ? '已保存' : '已是最新');
      await reload();
    });
    // 规则
    on('rulesRefresh', async () => { const r = await api('rules/refresh', 'POST', { maxLists: 3 }); toast(`更新 ${r.updated.length}，待刷新 ${r.pending}` + (r.errors.length ? '，失败 ' + r.errors.length : '')); await reload(); });
    // 通知与日志
    on('tgTest', async () => { const t = {}; const tok = $('[data-p="notify.telegram.botToken"]', root).value; if (tok) t.botToken = tok; t.chatId = $('[data-p="notify.telegram.chatId"]', root).value; await api('notify/test', 'POST', { telegram: t }); toast('已发送'); });
    on('logLoad', async () => {
      const r = await api('logs?limit=200');
      $('#logOut', root).innerHTML = `<table><thead><tr><th>时间</th><th>类型</th><th>IP</th><th>位置</th><th>说明</th><th>UA</th></tr></thead><tbody>${r.logs.map((l) => `<tr><td>${fmtT(l.t)}</td><td>${h(l.type)}</td><td>${h(l.ip)}</td><td>${h(l.loc)}</td><td>${h(l.msg || '')}</td><td title="${h(l.ua)}">${h(String(l.ua || '').slice(0, 40))}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">暂无日志</td></tr>'}</tbody></table>`;
    });
    on('logClear', async () => { if (!confirm('确定清空日志？')) return; await api('logs/clear', 'POST', {}); $('#logOut', root).innerHTML = '<p class="mut">已清空</p>'; });
    // 高级
    on('exp', async () => {
      const r = await api('export');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }));
      a.download = 'nicetunnel-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    });
    const f = $('#impFile', root);
    if (f) f.addEventListener('change', run(async () => {
      const data = JSON.parse(await f.files[0].text());
      if (!confirm('导入会覆盖当前设置与账号，确定？')) return;
      await api('import', 'POST', { data }); toast('已导入'); await reload();
    }));
    on('rs', async () => {
      const scope = $('#rsScope', root).value;
      if (prompt('危险操作，请输入 RESET 确认') !== 'RESET') return;
      await api('reset', 'POST', { scope, confirm: 'RESET' }); toast('已重置'); await reload();
    });
  }

  async function reload() {
    S = await api('state');
    document.body.classList.toggle('simple', !!S.settings.ui?.simpleMode);
    $('#ver').textContent = (S.version ? 'v' + S.version : '') + (S.build ? ' · ' + S.build : '');
    render();
  }

  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    if (b.dataset.tab === tab) return;
    if (dirty && !confirm('这一页有改动还没保存，离开会丢失。确定离开？')) return;
    tab = b.dataset.tab; try { localStorage.setItem('nt.tab', tab); } catch {}
    window.scrollTo(0, 0); render(); // 先回到顶部再渲染：页内索引的高亮按新页面的位置计算
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  reload().catch((e) => { $('main').innerHTML = `<div class="card"><h2><i></i>加载失败</h2><p>${h(e.message)}</p></div>`; });
}

/**
 * @param {{version?:string, siteName?:string, loginPath?:string}} [o]  loginPath：登录页地址（设置了 LOGIN_PATH 时是隐藏入口）
 */
export function adminHtml({ version = '', siteName = 'nicetunnel', loginPath = '/login' } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%236366f1'/%3E%3C/svg%3E"><title>${esc(siteName)} · 后台</title><style>${CSS}</style></head>
<body data-login="${esc(loginPath)}"><div class="shell"><aside><div class="brand"><div class="logo">N</div><div class="t">${esc(siteName)}<small id="ver">${esc(version ? 'v' + version : '')}</small></div></div>
<nav></nav><div class="side-foot"><span>多账号额度调度</span><a href="/logout">退出</a></div></aside>
<main><div class="card"><p class="mut">加载中…</p></div></main></div><div id="toast" role="status"></div>
<script>(${clientMain.toString()})();</script></body></html>`;
}

/**
 * @param {{siteName?:string, error?:string, action?:string}} [o]  action：表单提交地址（设置了 LOGIN_PATH 时是隐藏入口）
 */
export function loginHtml({ siteName = 'nicetunnel', error = '', action = '/login' } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%236366f1'/%3E%3C/svg%3E"><title>${esc(siteName)} · 登录</title><style>${CSS}
.login{max-width:392px;margin:0 auto;padding:16vh 16px 0}.login .card{padding:24px}.login h1{font-size:18px;margin:0 0 16px}.err{color:var(--bad);min-height:1.6em;margin:8px 0}</style></head>
<body><div class="login"><form class="card" method="post" action="${esc(action)}"><h1>${esc(siteName)}</h1>
<div class="f"><label for="pw">管理员密码</label><input id="pw" type="password" name="password" autocomplete="current-password" autofocus required></div>
<div class="err" id="err">${esc(error)}</div><button class="btn p" style="width:100%">登录</button></form></div>
<script>if(!document.getElementById('err').textContent&&/[?&]error=/.test(location.search))document.getElementById('err').textContent='密码错误';</script>
</body></html>`;
}
