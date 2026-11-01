// 构建全量包 src/index.js → dist/_worker.js / nicetunnel.zip，
// 以及纯节点包 src/node.js → dist/_worker.node.js / nicetunnel-node.zip。
//
// 三种发布风格（--style=disguise 默认 / edt / obf）：
//   disguise  伪装风格：标识符改名（消除 `SOCKS5白名单`、`所有反代数组` 这类词）+ 全域关键词
//             转义（身份/协议/隧道域词，含中文）+ 注释中性化 + 尾部注释块。
//             发布文件与 zip 文档里不出现任何代理/隧道相关词汇，外观是普通的状态页项目。
//   edt       上游形态：保留可读结构与中文标识符，只隐藏身份/协议词；产物形态贴近上游发布文件。
//   obf       Terser AST 压缩 + javascript-obfuscator（标识符改名、Base64 字符串表），体积最小。
// 用法：npm run build [-- --style=disguise|edt|obf] [-- --no-trailer] [-- --no-obfuscate] [-- --no-extras]
//   --no-obfuscate  只打包，不做任何隐藏（排查构建问题时使用）
//   --no-trailer    产物不追加尾部注释块
//   --no-extras     zip 里只放 _worker.js
//
// 产物文件头不加任何注释（第一行就是代码）；版权/许可信息只在尾部注释块与 zip 的 LICENSE、NOTICE.md 里。
//
// 打包方式：每个模块包进一个函数作用域（互不冲突），import 改写为从已求值模块对象解构，export 汇总为返回对象。
// 只支持本项目用到的 ESM 语法子集（顶层 import/export 必须在行首）；不支持的写法会直接报错，不会静默产出坏文件。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { obfuscateWorker, mangleIdentifiers } from './obfuscate.mjs';
import { hideSignatures, EDT_KEYWORDS, DISGUISE_KEYWORDS, COMMENT_REPLACEMENTS, COMMENT_REPLACEMENTS_DISGUISE } from './sig-hide.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ID = '[\\p{L}\\p{N}_$]+';
const argv = process.argv.slice(2);
const STYLE = (argv.find((a) => a.startsWith('--style=')) || '--style=disguise').split('=')[1];
if (!['disguise', 'edt', 'obf'].includes(STYLE)) throw new Error(`未知的 --style=${STYLE}（可选 disguise / edt / obf）`);

// ---------------- 解析与依赖图 ----------------
const modules = new Map(); // abs -> {id, abs, code, deps:[abs]}
const rel = (abs) => path.relative(root, abs).replace(/\\/g, '/');

function load(abs) {
  if (modules.has(abs)) return modules.get(abs);
  const src = fs.readFileSync(abs, 'utf8');
  const mod = { id: modules.size, abs, src, deps: [], imports: [] };
  modules.set(abs, mod);
  const re = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gmu;
  for (const m of src.matchAll(re)) {
    if (!m[2].startsWith('.')) throw new Error(`${rel(abs)}：不支持的外部导入 ${m[2]}`);
    const dep = path.resolve(path.dirname(abs), m[2]);
    mod.imports.push({ text: m[0], clause: m[1].trim(), dep });
    if (!mod.deps.includes(dep)) mod.deps.push(dep);
  }
  if (/^import\s+['"]/m.test(src)) throw new Error(`${rel(abs)}：不支持副作用导入`);
  for (const d of mod.deps) load(d);
  return mod;
}

function topo(entry) {
  const order = [], state = new Map();
  const visit = (abs, stack) => {
    const st = state.get(abs);
    if (st === 2) return;
    if (st === 1) throw new Error('检测到循环依赖：' + [...stack, abs].map(rel).join(' → '));
    state.set(abs, 1);
    for (const d of modules.get(abs).deps) visit(d, [...stack, abs]);
    state.set(abs, 2);
    order.push(modules.get(abs));
  };
  visit(entry, []);
  return order;
}

// ---------------- 改写 ----------------
const varOf = (abs) => `__nt_m${modules.get(abs).id}`;

function importToConst(clause, dep) {
  const v = varOf(dep);
  if (clause.startsWith('* as ')) return `const ${clause.slice(5).trim()} = ${v};`;
  const m = clause.match(/^\{([\s\S]*)\}$/);
  if (!m) throw new Error(`不支持的导入写法：import ${clause}`);
  const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [a, b] = s.split(/\s+as\s+/);
    if (a === 'default') throw new Error('不支持 default 导入');
    return b ? `${a}: ${b}` : a;
  });
  return `const { ${parts.join(', ')} } = ${v};`;
}

function transform(mod) {
  // 剥掉模块源码的文件头注释（vendor 声明、@ts-nocheck、模块说明等）：
  // 产物里不带任何「本文件由 xxx 生成 / 来源 xxx」类文字；模块体内其余注释照常保留。
  let code = stripLeadingComments(mod.src);
  for (const im of mod.imports) code = code.replace(im.text, importToConst(im.clause, im.dep));
  const exportsMap = []; // [exported, local]
  code = code.replace(new RegExp(`^export\\s+((?:async\\s+)?function\\*?|class|const|let|var)\\s+(${ID})`, 'gmu'), (all, kw, name) => {
    exportsMap.push([name, name]);
    return `${kw} ${name}`;
  });
  code = code.replace(/^export\s*\{([\s\S]*?)\};?/gm, (all, inner) => {
    for (const s of inner.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [a, b] = s.split(/\s+as\s+/);
      exportsMap.push([b || a, a]);
    }
    return '';
  });
  code = code.replace(/^export\s+default\s+/m, () => { exportsMap.push(['default', '__nt_default']); return 'const __nt_default = '; });
  if (/^export\s/m.test(code)) throw new Error(`${rel(mod.abs)}：存在未处理的 export 写法`);
  if (/^import\s/m.test(code)) throw new Error(`${rel(mod.abs)}：存在未处理的 import 写法`);
  const ret = exportsMap.map(([e, l]) => (e === l ? e : `${JSON.stringify(e)}: ${l}`)).join(', ');
  // 模块分隔注释：只留序号，不暴露源码目录结构（上游发布文件没有路径标记）
  return `// ---- 模块 ${modules.get(mod.abs).id} ----\nconst ${varOf(mod.abs)} = (() => {\n${code}\nreturn { ${ret} };\n})();\n`;
}

// ---------------- 产出 ----------------
// 剥掉产物最前面的注释（// 行注释、/* */ 块注释）与空白，保证文件第一行就是代码。
// 文件头不加任何注释；版权/许可信息只在尾部注释块（edt 风格）与 zip 的 LICENSE、NOTICE.md 里。
function stripLeadingComments(code) {
  let s = code.replace(/^\s+/, '');
  for (;;) {
    if (s.startsWith('//')) s = s.replace(/^\/\/[^\n]*\n?/, '');
    else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) break;
      s = s.slice(end + 2);
    } else break;
    s = s.replace(/^\s+/, '');
  }
  return s;
}

async function buildCode({ entryName, workerName, label, requireScheduled }) {
  modules.clear();
  const entry = path.join(root, entryName);
  load(entry);
  const order = topo(entry);
  let code = stripLeadingComments(order.map(transform).join('\n') + `\nexport default ${varOf(entry)}.default;\n`);
  code = code.replace(/__NT_VERSION__/g, pkg.version);
  // 构建号 = 代码内容（替换占位符之前）的 sha256 前 8 位：同样的代码得到同样的构建号，线上/本地可以对照
  const buildId = crypto.createHash('sha256').update(code).digest('hex').slice(0, 8);
  code = code.replace(/__NT_BUILD__/g, buildId);

  // 默认压缩并混淆；--no-obfuscate 仅用于本地排查。构建号仍取混淆前源码，避免随机种子影响版本对照。
  const rawBytes = Buffer.byteLength(code);
  const withObfuscation = !argv.includes('--no-obfuscate');
  let obfuscateStats = null;
  let sigStats = null;
  let trailerBytes = 0;

  if (STYLE === 'disguise') {
    // 伪装风格：先改名（terser 会按值重排字面量，转义必须放在后面），再全域关键词转义。
    if (withObfuscation) {
      code = await mangleIdentifiers(code);
      const hidden = hideSignatures(code, { keywords: DISGUISE_KEYWORDS, commentReplacements: COMMENT_REPLACEMENTS_DISGUISE });
      if (hidden.error) console.error('特征码隐藏跳过：' + hidden.error);
      else { code = hidden.code; sigStats = { hits: hidden.hits, commentHits: hidden.commentHits ?? 0 }; }
    }
  } else if (STYLE === 'edt') {
    // 上游形态：保留注释与可读结构，只隐藏身份/协议特征码。
    if (withObfuscation) {
      const hidden = hideSignatures(code, { keywords: EDT_KEYWORDS, commentReplacements: COMMENT_REPLACEMENTS });
      if (hidden.error) console.error('特征码隐藏跳过：' + hidden.error);
      else { code = hidden.code; sigStats = { hits: hidden.hits, commentHits: hidden.commentHits ?? 0 }; }
    }
  } else {
    if (withObfuscation) {
      const obfuscated = await obfuscateWorker(code, { seed: Number.parseInt(buildId, 16) });
      obfuscateStats = obfuscated.stats;
      code = obfuscated.code;
    }
  }
  // 尾部大段注释：纯注释不影响运行；默认附带（--no-trailer 跳过，免费版 Workers 压缩上限 1MB 时需要）
  const trailerFile = path.join(root, 'scripts', 'assets', 'edt-trailer.txt');
  if (STYLE !== 'obf' && !argv.includes('--no-trailer')) {
    if (!fs.existsSync(trailerFile)) throw new Error('缺少 scripts/assets/edt-trailer.txt（或加 --no-trailer 跳过）');
    const trailer = fs.readFileSync(trailerFile, 'utf8');
    if (!trailer.startsWith('/*') || !trailer.trimEnd().endsWith('*/') || trailer.slice(2, -3).includes('*/')) throw new Error('edt-trailer.txt 不是一个完整的单个 /* … */ 注释');
    code += '\n' + trailer;
    trailerBytes = Buffer.byteLength(trailer);
  }

  fs.mkdirSync(distDir, { recursive: true });
  const out = path.join(distDir, workerName);
  fs.writeFileSync(out, code);

  // 基本检查：不能残留 node: 导入；必须能在 Node 里加载并导出 fetch（全量包还必须有 scheduled）。
  if (/from\s*["']node:/.test(code) || /require\(["']node:/.test(code)) throw new Error('产物包含 node: 依赖，Workers 无法运行');
  const mod = await import(pathToFileURL(out).href + '?t=' + Date.now());
  if (typeof mod.default?.fetch !== 'function') throw new Error(`${workerName} 缺少 default.fetch`);
  if (requireScheduled && typeof mod.default?.scheduled !== 'function') throw new Error(`${workerName} 缺少 default.scheduled`);
  return { out, code, buildId, rawBytes, withObfuscation, obfuscateStats, sigStats, trailerBytes, moduleCount: order.length };
}

// ---------------- zip（store 之外用 deflate；零依赖） ----------------
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
async function emitTarget({ entryName, workerName, zipName, label, requireScheduled = false, fullPackage = false }) {
  const built = await buildCode({ entryName, workerName, label, requireScheduled });
  const { code, out, buildId, rawBytes, withObfuscation, obfuscateStats, sigStats, trailerBytes, moduleCount } = built;
  // zip 只使用本项目文件，不夹带上游仓库的 workflows 或大体积占位注释。
  const zipFiles = [{ name: '_worker.js', data: Buffer.from(code, 'utf8') }];
  const withExtras = !argv.includes('--no-extras');
  if (withExtras && fullPackage) {
    // 全量包（Workers 主站部署用）：worker + 发布素材（状态页门面与文档，来自 scripts/assets/package/）+ LICENSE。
    // NOTICE.md / wrangler.toml 也在 package/ 里，内容与伪装形象一致；不再从项目根目录取。
    const extrasDir = path.join(root, 'scripts', 'assets', 'package');
    if (!fs.existsSync(extrasDir)) throw new Error('缺少 scripts/assets/package（或加 --no-extras 跳过）');
    const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), prefix + e.name + '/') : [{ name: prefix + e.name, data: fs.readFileSync(path.join(dir, e.name)) }]));
    const extras = walk(extrasDir);
    extras.push({ name: 'LICENSE', data: fs.readFileSync(path.join(root, 'LICENSE')) });
    extras.sort((a, b) => (a.name < b.name ? -1 : 1));
    zipFiles.push(...extras);
  } else if (withExtras) {
    // 节点包（Pages 上传部署用）：对齐上游极简内核的发布形态（byjoey/cfnew 的 Pages.zip 只有 _worker.js）。
    // Pages 高级模式下 _worker.js 接管全部请求，门面/文档不会被服务，放进包里只会构成
    // 「包内容与站点行为不符」的暴露面；只保留 LICENSE 满足 GPL 随分发要求。
    zipFiles.push({ name: 'LICENSE', data: fs.readFileSync(path.join(root, 'LICENSE')) });
  }
  const zipPath = path.join(distDir, zipName);
  fs.writeFileSync(zipPath, makeZip(zipFiles));

  const gz = zlib.gzipSync(Buffer.from(code, 'utf8'), { level: 9 }).length;
  console.log(`[${label}] 构建号：${buildId}（style=${STYLE}）`);
  console.log(`已生成 dist/${workerName}：${(Buffer.byteLength(code) / 1024).toFixed(1)} KB（gzip 约 ${(gz / 1024).toFixed(0)} KB），${moduleCount} 个模块`);
  if (!withObfuscation) {
    console.log(`[${label}] 隐藏：已跳过（--no-obfuscate）`);
  } else if (STYLE === 'disguise') {
    console.log(`[${label}] 伪装：标识符改名 + 关键词转义 ${sigStats?.hits ?? 0} 处 + 注释中性化 ${sigStats?.commentHits ?? 0} 处${trailerBytes ? '，含尾部注释 ' + (trailerBytes / 1024).toFixed(0) + ' KB' : ''}`);
  } else if (STYLE === 'edt') {
    console.log(`[${label}] 隐藏：特征码转义 ${sigStats?.hits ?? 0} 处 + 注释中性化 ${sigStats?.commentHits ?? 0} 处（注释与结构保留）${trailerBytes ? '，含尾部注释 ' + (trailerBytes / 1024).toFixed(0) + ' KB' : ''}`);
  } else {
    console.log(`[${label}] 混淆：AST 压缩 + 标识符改名 + Base64 字符串表（原始 ${(rawBytes / 1024).toFixed(1)} KB → 压缩 ${(obfuscateStats.minifiedBytes / 1024).toFixed(1)} KB → 混淆 ${(obfuscateStats.obfuscatedBytes / 1024).toFixed(1)} KB）`);
  }
  console.log(`已生成 dist/${zipName}：${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB（Pages 上传用；${zipFiles.length} 个文件）`);
  return { ...built, zipPath };
}

await emitTarget({ entryName: 'src/index.js', workerName: '_worker.js', zipName: 'nicetunnel.zip', label: 'full', requireScheduled: true, fullPackage: true });
await emitTarget({ entryName: 'src/node.js', workerName: '_worker.node.js', zipName: 'nicetunnel-node.zip', label: 'node' });
