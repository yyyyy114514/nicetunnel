// 生成后台演示站（纯静态，可直接部署到 Cloudflare Pages / 任意静态托管）：
//   dist/demo/            —— 上传这个文件夹（或下面的 zip）
//   dist/nicetunnel-demo.zip
// 页面就是真实的后台 HTML；demo/mock.js 在浏览器里模拟后台接口，改动只存在访问者自己的浏览器（localStorage）。
// 用法：node scripts/build-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'demo');
const { adminHtml } = await import(pathToFileURL(path.join(root, 'src/admin/ui.js')).href);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1) mock.js 及它 import 到的模块（按原相对路径复制；浏览器原生加载 ES 模块，不需要打包）
const copied = [];
const copy = (from, to) => {
  if (copied.includes(to)) return;
  copied.push(to);
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  const src = fs.readFileSync(from, 'utf8');
  fs.writeFileSync(path.join(out, to), src);
  for (const m of src.matchAll(/^\s*(?:import|export)\s[\s\S]*?\sfrom\s+['"](\.[^'"]+)['"]/gm)) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(to), m[1]));
    copy(path.join(root, rel.startsWith('src/') ? rel : rel), rel);
  }
};
copy(path.join(root, 'demo/mock.js'), 'mock.js');
// mock.js 里写的是 ./src/...，上面的 copy 已按项目里的同名路径取文件
if (copied.some((f) => /edt-core/.test(f))) throw new Error('演示不应引入数据面核心（edt-core.js）');

// 2) 页面：真实后台 HTML + 引导脚本（请求先排队，mock 加载后统一处理）+ 演示横幅
const boot = `<script>
(function () {
  var real = window.fetch.bind(window), resolve;
  var ready = new Promise(function (r) { resolve = r; });
  window.__ntDemoReady = resolve;
  window.fetch = function (u, o) { return ready.then(function (h) { return h(u, o || {}, real); }); };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href="/logout"]');
    if (a) { e.preventDefault(); alert('演示模式：没有登录状态，不需要退出。'); }
    var r = e.target.closest && e.target.closest('#demoReset');
    if (r) { e.preventDefault(); if (confirm('把演示数据恢复成初始状态？你在演示里做的改动会清空。')) window.__ntDemoReset && window.__ntDemoReset(); }
  }, true);
})();
</script>
<style>
.demo-banner{position:relative;z-index:30;padding:8px 16px;text-align:center;font-size:13px;color:#fff;background:linear-gradient(135deg,#5b5bf0,#8b5cf6)}
.demo-banner a{color:#fff;text-decoration:underline;margin-left:6px;white-space:nowrap}
</style>`;
const banner = '<div class="demo-banner">演示模式：数据只保存在你的浏览器里，不连接任何服务器，按钮都可以随便点。<a href="#" id="demoReset">恢复初始演示数据</a></div>';

let html = adminHtml({ version: pkg.version, siteName: 'nicetunnel 演示', loginPath: '/login' });
const must = (cond, msg) => { if (!cond) throw new Error('后台 HTML 结构变了：' + msg); };
must(html.includes('</head>'), '</head>');
must(/<body[^>]*>/.test(html), '<body>');
must(html.includes('</body>'), '</body>');
html = html
  .replace(/<title>[^<]*<\/title>/, '<title>nicetunnel 后台演示</title>')
  .replace('</head>', boot + '</head>')
  .replace(/<body([^>]*)>/, (m) => m + banner)
  .replace('</body>', '<script type="module" src="./mock.js"></script></body>');
html = html.replace('<meta name="robots" content="noindex">', '<meta name="robots" content="noindex"><meta name="description" content="nicetunnel 后台的交互演示，数据只保存在浏览器里">');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-cache\n');
fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

// 3) zip（store + deflate，Pages 直接上传用）
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const files = [];
const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push(r); } };
walk(out);
const parts = [], central = [];
let offset = 0;
for (const name of files.sort()) {
  const data = fs.readFileSync(path.join(out, name));
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  parts.push(local, nameBuf, comp);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
  central.push(cen, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cenBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
const zipPath = path.join(root, 'dist', 'nicetunnel-demo.zip');
fs.writeFileSync(zipPath, Buffer.concat([...parts, cenBuf, end]));

const size = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' KB';
console.log(`已生成 dist/demo/（${files.length} 个文件：${files.join('、')}）`);
console.log(`已生成 dist/nicetunnel-demo.zip：${size(zipPath)}`);
