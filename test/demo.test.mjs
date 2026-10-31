// 后台演示站：能生成、不带数据面核心、页面结构完整（引导脚本在后台脚本之前、mock 以模块加载）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('npm run demo：生成静态演示站，结构完整、不含 edt-core', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-demo.mjs')], { cwd: root, stdio: 'pipe' });
  const dir = path.join(root, 'dist/demo');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(fs.existsSync(path.join(dir, 'mock.js')));
  assert.ok(fs.existsSync(path.join(root, 'dist/nicetunnel-demo.zip')));
  assert.ok(!fs.existsSync(path.join(dir, 'src/dataplane/edt-core.js')), '演示站不应带数据面核心');
  // mock.js import 的每个模块都已复制
  for (const m of fs.readFileSync(path.join(dir, 'mock.js'), 'utf8').matchAll(/from '(\.\/[^']+)'/g)) assert.ok(fs.existsSync(path.join(dir, m[1])), m[1]);
  const boot = html.indexOf('window.__ntDemoReady = resolve'), main = html.indexOf('function clientMain') >= 0 ? html.indexOf('(function') : -1;
  assert.ok(boot > 0 && boot < html.lastIndexOf('<script>'), '引导脚本要在后台脚本之前');
  assert.ok(html.includes('<script type="module" src="./mock.js"></script></body>'));
  assert.ok(html.includes('id="demoReset"'));
  void main;
});
