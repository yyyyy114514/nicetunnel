// 打包产物冒烟测试：dist/_worker.js 存在时运行（先 npm run build）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { memKV, fakeFetch } from './helpers.mjs';

const file = fileURLToPath(new URL('../dist/_worker.js', import.meta.url));
const nodeFile = fileURLToPath(new URL('../dist/_worker.node.js', import.meta.url));
const has = fs.existsSync(file);
const nodeHas = fs.existsSync(nodeFile);

test('dist/_worker.js：订阅 / 后台 / 伪装页 / 节点模式', { skip: has ? false : '未构建，跳过' }, async () => {
  const code = fs.readFileSync(file, 'utf8');
  assert.ok(!code.includes('__NT_VERSION__'), '版本号已替换');
  assert.ok(!/^\s*import\s/m.test(code), '无残留 import');
  const { default: w } = await import(pathToFileURL(file).href);
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try {
    const kv = memKV({ 'nt.settings': { schema: 2, preferred: { custom: { text: '1.2.3.4#日本-住宅-01' }, random: { enabled: true, count: 2 } }, hosts: { unmanaged: ['vp2.example.com'] }, rules: { configUrl: '' } } });
    const env = { KV: kv, ADMIN: 'pw', KEY: 'k' };
    const ctx = { waitUntil() {} };
    // /<KEY> 直接返回订阅（不再 302 跳转，主站每次更新只算 1 次请求）
    const sub = await w.fetch(new Request('https://vp.example.com/k', { headers: { 'User-Agent': 'clash-verge', 'CF-Connecting-IP': '1.1.1.1' } }), env, ctx);
    assert.equal(sub.status, 200);
    const yaml = await sub.text();
    assert.ok(yaml.includes('"name":"日本-住宅-01"') && yaml.includes('"servername":"vp2.example.com"'));
    const login = await w.fetch(new Request('https://vp.example.com/login'), env, ctx);
    assert.match(await login.text(), /管理员密码/);
    // 节点模式（无 KV）：只回伪装页，不做外部请求
    const f = fakeFetch({});
    globalThis.fetch = f;
    const n = await w.fetch(new Request('https://vp9.example.com/sub?token=x'), {}, ctx);
    assert.ok(!(await n.text()).includes('vless://'));
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = real; }
});

test('dist/_worker.js：发布产物已隐藏特征码（disguise 伪装风格）', { skip: has ? false : '未构建，跳过' }, () => {
  const code = fs.readFileSync(file, 'utf8');
  // 特征码：与上游 cmliu/edgetunnel 一样，身份类关键词不出现在文件里
  assert.ok(!/edgetunnel/i.test(code), '无上游项目名明文');
  assert.ok(!/cmliu/i.test(code), '无作者标识明文');
  assert.ok(!/yyyyy114514/i.test(code), '无镜像账号明文');
  assert.ok(!/nicetunnel/i.test(code), '无本项目名明文');
  assert.ok(!code.includes('vless://') && !code.includes('trojan://') && !code.includes('socks5://'), '协议明文字符串已表达式化');
  assert.ok(!code.includes('// ---- src/'), '无源码模块路径标记');
  // disguise 伪装风格：保留注释与可读结构，域词汇转义，形态与正常 i18n 项目一致
  for (const kw of ['反代', '代理', '链式', '订阅', '伪装', '隧道', '拨号', '优选', '上行', '下行', 'tunnel']) {
    assert.ok(!new RegExp(kw, 'i').test(code), `域词汇「${kw}」已隐藏`);
  }
  const commentLines = code.split('\n').filter((l) => /^\s*\/\//.test(l)).length;
  assert.ok(commentLines > 100, `注释被保留（${commentLines} 行）`);
  assert.ok(Buffer.byteLength(code) > 4_000_000, '含尾部注释块，体积与上游发布文件相当');
});

// ---- zip：_worker.js + 本项目的发布文件 ----
import zlib from 'node:zlib';
function readZip(buf) {
  // 解析中央目录（不依赖外部 unzip 命令）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(lh, lh + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (data.length !== size) throw new Error(name + ' 大小不符');
    if (zlib.crc32 && zlib.crc32(data) !== crc) throw new Error(name + ' CRC 不符');
    out.set(name, data);
    p += 46 + nl + el + cl;
  }
  return out;
}

test('nicetunnel.zip：只含本项目的 worker、文档、配置和静态门面，内容无损', { skip: has ? false : '未构建，跳过' }, () => {
  const zipFile = fileURLToPath(new URL('../dist/nicetunnel.zip', import.meta.url));
  const files = readZip(fs.readFileSync(zipFile));
  assert.ok(files.has('_worker.js'));
  assert.ok(files.get('_worker.js').equals(fs.readFileSync(file)), 'zip 里的 _worker.js 与 dist/_worker.js 一致');
  if (files.size === 1) return; // --no-extras 构建
  const packageFiles = ['CHANGELOG.md', 'DEPLOY.md', 'NOTICE.md', 'README.md', '_headers', 'favicon.svg', 'index.html', 'robots.txt', 'wrangler.toml'];
  const expected = [...packageFiles, 'LICENSE'];
  assert.deepEqual([...files.keys()].filter((k) => k !== '_worker.js').sort(), expected.slice().sort());
  for (const name of packageFiles) {
    const source = fileURLToPath(new URL('../scripts/assets/package/' + name, import.meta.url));
    assert.ok(files.get(name).equals(fs.readFileSync(source)), name + ' 与发布素材逐字节一致');
  }
  assert.ok(files.get('LICENSE').equals(fs.readFileSync(fileURLToPath(new URL('../LICENSE', import.meta.url)))), 'LICENSE 与项目文件逐字节一致');
  assert.ok(![...files.keys()].some((name) => name.startsWith('.github/')), '不夹带上游 workflows');
  assert.match(files.get('index.html').toString('utf8'), /site-status/);
  assert.match(files.get('robots.txt').toString('utf8'), /Disallow: \//);
});

test('纯节点包：与全量包的 node 角色响应一致，且无主站定时入口', { skip: nodeHas && has ? false : '未构建，跳过' }, async () => {
  const full = (await import(pathToFileURL(file).href + '?node-compare-full=' + Date.now())).default;
  const node = (await import(pathToFileURL(nodeFile).href + '?node-compare=' + Date.now())).default;
  assert.equal(typeof node.fetch, 'function');
  assert.equal(node.scheduled, undefined);
  const UUID = '5d7b401c-1111-4222-8333-444455556666';
  const env = { UUID };
  const ctx = { waitUntil() {} };
  const real = globalThis.fetch;
  const f = fakeFetch({});
  globalThis.fetch = f;
  try {
    for (const p of ['/', '/robots.txt', '/admin', '/login', '/sub?token=x', '/version', '/version?uuid=bad', '/video/not-a-valid-secret']) {
      const a = await full.fetch(new Request('https://vp.example.com' + p), env, ctx);
      const b = await node.fetch(new Request('https://vp.example.com' + p), env, ctx);
      assert.equal(b.status, a.status, p + ' 状态一致');
      assert.deepEqual(Object.fromEntries(b.headers), Object.fromEntries(a.headers), p + ' 响应头一致');
      assert.equal(await b.text(), await a.text(), p + ' 响应体一致');
    }
    assert.equal(f.calls.length, 0, '未授权普通请求不触发任何外拉');
    const va = await full.fetch(new Request('https://vp.example.com/version?uuid=' + UUID), env, ctx);
    const vb = await node.fetch(new Request('https://vp.example.com/version?uuid=' + UUID), env, ctx);
    const ja = await va.json(), jb = await vb.json();
    assert.equal(jb.Version, ja.Version);
    assert.equal(jb.Dataplane, ja.Dataplane);
    assert.deepEqual(jb.Caps, ja.Caps);
    assert.match(jb.Build, /^[0-9a-f]{8}$/);
    assert.equal(ja.Edition, 'full');
    assert.equal(jb.Edition, 'node', '节点版自报 Edition=node，后台可区分');
  } finally { globalThis.fetch = real; }
});

test('nicetunnel-node.zip：Pages 上传用的极简形态（对齐上游 cfnew：只含 worker 与 LICENSE）', { skip: nodeHas ? false : '未构建，跳过' }, () => {
  const zipFile = fileURLToPath(new URL('../dist/nicetunnel-node.zip', import.meta.url));
  const files = readZip(fs.readFileSync(zipFile));
  assert.ok(files.has('_worker.js'));
  assert.ok(files.get('_worker.js').equals(fs.readFileSync(nodeFile)));
  if (files.size === 1) return; // --no-extras 构建
  assert.deepEqual([...files.keys()].sort(), ['LICENSE', '_worker.js'].sort(), '节点包只含 _worker.js 与 LICENSE，不放门面/文档（Pages 高级模式下它们不会被服务）');
  // worker 内不应出现代理域关键词与平台 API 明文之外的身份证词
  const code = files.get('_worker.js').toString('utf8');
  for (const kw of ['edgetunnel', 'cmliu', 'nicetunnel', 'vless://', 'trojan://', 'socks5://', '反代', '代理', '订阅', '伪装', 'cloudflare:sockets', 'WebSocketPair']) {
    assert.ok(!new RegExp(kw, 'i').test(code), `节点包 worker 不含「${kw}」明文`);
  }
});
