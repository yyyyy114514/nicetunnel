// 发布产物核对：把「源码版」（src/index.js）与「发布版」（dist/_worker.js）的实际响应逐项比对。
// 目的：确认混淆/压缩只改变代码形态，不改变对外行为。
// 用法：node scripts/verify-build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { memKV, fakeFetch } from '../test/helpers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distFile = path.join(root, 'dist', '_worker.js');
if (!fs.existsSync(distFile)) {
  console.error('缺少 dist/_worker.js，请先执行 npm run build');
  process.exit(1);
}

const distCode = fs.readFileSync(distFile, 'utf8');
const buildId = distCode.match(/build ([0-9a-f]{8})/)?.[1] || '';

const rawWorker = (await import(pathToFileURL(path.join(root, 'src', 'index.js')).href)).default;
const distWorker = (await import(pathToFileURL(distFile).href + '?v=' + Date.now())).default;

const UUID = '5d7b401c-1111-4222-8333-444455556666';
const KV_INIT = {
  'nt.settings': {
    schema: 3,
    site: { name: 'nicetunnel' },
    sub: { rateLimitPerMinute: 0, updateHours: 12 },
    preferred: { custom: { text: '1.2.3.4#日本-住宅-01' }, random: { enabled: false, count: 0 } },
    hosts: { unmanaged: ['vp2.example.com'] },
    rules: { configUrl: '' },
  },
};

const PATHS = ['/', '/robots.txt', '/login', '/admin', '/favicon.ico', '/index.html', '/sub?token=bad', `/version?uuid=${UUID}`, '/version'];
const ctx = { waitUntil() {} };

function makeEnv(role) {
  if (role === 'node') return { UUID };
  return { KV: memKV(KV_INIT), ADMIN: 'pw', KEY: 'k', UUID };
}

/** 归一化：把构建号、随机项、时间戳等本来就允许不同的部分抹掉 */
function normalize(text) {
  return String(text)
    .replaceAll(buildId, 'BUILD')
    .replace(/"Build"\s*:\s*"dev"/g, '"Build":"BUILD"')
    .replace(/\b\d{10,13}\b/g, 'TS')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/\b\d+(\.\d+)?ms\b/g, 'MS');
}

async function snapshot(worker, role, pathName) {
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try {
    const res = await worker.fetch(new Request('https://vp.example.com' + pathName), makeEnv(role), ctx);
    const headers = {};
    for (const key of ['content-type', 'location', 'cache-control', 'x-nt-build']) {
      const v = res.headers.get(key);
      if (v) headers[key] = key === 'x-nt-build' ? 'BUILD' : v;
    }
    const body = await res.text();
    return { status: res.status, headers, body: normalize(body) };
  } finally {
    globalThis.fetch = real;
  }
}

let failed = 0;
for (const role of ['main', 'node']) {
  const paths = role === 'node' ? ['/', '/robots.txt', '/favicon.ico', '/index.html'] : PATHS;
  for (const p of paths) {
    const a = await snapshot(rawWorker, role, p);
    const b = await snapshot(distWorker, role, p);
    const same = a.status === b.status
      && JSON.stringify(a.headers) === JSON.stringify(b.headers)
      && a.body === b.body;
    if (same) {
      console.log(`ok   [${role}] ${p} → ${a.status}（响应一致）`);
    } else {
      failed++;
      console.log(`差异 [${role}] ${p}`);
      console.log('  源码版:', a.status, JSON.stringify(a.headers), a.body.slice(0, 200).replace(/\n/g, '\\n'));
      console.log('  发布版:', b.status, JSON.stringify(b.headers), b.body.slice(0, 200).replace(/\n/g, '\\n'));
    }
  }
}
console.log(failed ? `\n发现 ${failed} 处差异` : '\n全部路径的对外行为一致');
process.exit(failed ? 1 : 0);
