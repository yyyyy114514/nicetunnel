#!/usr/bin/env node
// 账号管理命令行：通过后台 API（Authorization: Bearer <ADMIN 密码>）批量新增 / 更新 / 删除 / 列出节点账号。
// 零依赖，Node 18+。接口说明见 docs/API.md §6。
//
// 用法：
//   node scripts/nt-accounts.mjs add    --url https://主站域名 --file accounts.txt [--poll] [--overwrite]
//   node scripts/nt-accounts.mjs list   --url https://主站域名
//   node scripts/nt-accounts.mjs delete --url https://主站域名 --host vp2.example.com --host vp3.example.com
//
// 密码：优先用环境变量 NT_PASSWORD（避免出现在 shell 历史里），也可以 --password。主站地址也可以用环境变量 NT_URL。
// accounts.txt 每行一个账号（# 开头为注释；分隔符可用 , | Tab 空格）：
//   域名,AccountID,APIToken[,名称]          或        域名,邮箱,GlobalAPIKey[,名称]
//   vp2.example.com,0123456789abcdef0123456789abcdef,cfut_xxxxxxxx,二号
// 同一个域名 / AccountID 再提交会更新而不是重复新增（幂等）；已有账号的空凭据字段保留旧值。
// 退出码：0 成功；1 参数 / 网络 / 鉴权错误；2 提交成功但 --poll 发现有账号令牌无效。

import fs from 'node:fs';

function parseArgs(argv) {
  const o = { _: [], host: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (['poll', 'overwrite', 'help'].includes(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) die(`选项 --${k} 缺少值`);
    if (k === 'host') o.host.push(v); else o[k] = v;
  }
  return o;
}

function die(msg, code = 1) { console.error('错误：' + msg); process.exit(code); }

const HELP = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1, 18).map((l) => l.slice(3)).join('\n');
const opt = parseArgs(process.argv.slice(2));
const cmd = opt._[0];
if (!cmd || opt.help) { console.log(HELP); process.exit(cmd || opt.help ? 0 : 1); }

const base = String(opt.url || process.env.NT_URL || '').replace(/\/+$/, '');
const password = opt.password || process.env.NT_PASSWORD || '';
if (!/^https?:\/\//i.test(base)) die('请用 --url 或环境变量 NT_URL 指定主站地址（如 https://vp.example.com）');
if (!password) die('请用环境变量 NT_PASSWORD（推荐）或 --password 提供管理员密码');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 调用后台 API；遇到 429 按 Retry-After 等一次再试 */
async function api(method, path, body, retried = false) {
  let res;
  try {
    res = await fetch(`${base}/admin/api/${path}`, {
      method,
      headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { die(`无法连接 ${base}：${e.message}`); }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 429 && !retried) {
    const wait = Math.min(Number(res.headers.get('Retry-After')) || Number(data?.retryAfter) || 6, 60);
    console.error(`被限频，${wait} 秒后重试…`);
    await sleep(wait * 1000 + 300);
    return api(method, path, body, true);
  }
  if (res.status === 401) die('鉴权失败：管理员密码不对（注意：连续错误 5 次会被锁定 10 分钟）');
  if (!res.ok || !data?.ok) die(`${method} ${path} 失败（HTTP ${res.status}）：${data?.error || '未知错误'}`);
  return data;
}

async function cmdAdd() {
  if (!opt.file) die('add 需要 --file <账号文件>（用 - 表示标准输入）');
  const raw = opt.file === '-' ? fs.readFileSync(0, 'utf8') : fs.existsSync(opt.file) ? fs.readFileSync(opt.file, 'utf8') : die(`找不到文件：${opt.file}`);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) die('文件里没有账号行');
  const chunk = Math.max(1, Math.min(Number(opt.chunk) || 40, 40));
  let added = 0, updated = 0, total = 0;
  const parseErrors = [], bad = [];
  for (let i = 0; i < lines.length; i += chunk) {
    const part = lines.slice(i, i + chunk);
    const r = await api('POST', 'accounts/upsert', { text: part.join('\n'), poll: !!opt.poll, overwrite: !!opt.overwrite });
    added += r.added; updated += r.updated; total = r.total;
    parseErrors.push(...(r.parseErrors || []));
    for (const p of r.polled || []) if (!p.ok) bad.push(p);
    console.log(`第 ${Math.floor(i / chunk) + 1} 批（${part.length} 行）：新增 ${r.added}，更新 ${r.updated}${r.polled ? `，验证通过 ${r.polled.filter((p) => p.ok).length}/${r.polled.length}` : ''}`);
    if (opt.poll && i + chunk < lines.length) await sleep(5300); // 服务端对 poll 有 5 秒限频
  }
  console.log(`\n完成：新增 ${added}，更新 ${updated}，现共 ${total} 个账号`);
  if (parseErrors.length) { console.log(`\n有 ${parseErrors.length} 行无法解析（已忽略）：`); parseErrors.forEach((e) => console.log('  - ' + e)); }
  if (bad.length) {
    console.log(`\n⚠ ${bad.length} 个账号验证失败（令牌无效 / 权限不足 / 网络问题）：`);
    bad.forEach((p) => console.log(`  - ${p.host}：${p.error || '未知错误'}${p.kind ? '（' + p.kind + '）' : ''}`));
    console.log('  令牌需要 "Account Analytics: Read" 权限。');
    process.exit(2);
  }
}

async function cmdList() {
  const r = await api('GET', 'accounts');
  if (!r.accounts.length) return console.log('还没有账号');
  console.log(`共 ${r.accounts.length} 个账号：`);
  for (const a of r.accounts) {
    console.log(`  ${a.role.padEnd(4)} ${a.enabled ? '启用' : '停用'}  ${(a.hosts.join(',') || '(无域名)').padEnd(36)} ${a.auth.hasToken || a.auth.hasKey ? '有凭据' : '无凭据'}  ${a.name || ''}`);
  }
}

async function cmdDelete() {
  if (!opt.host.length) die('delete 需要至少一个 --host <域名>');
  const r = await api('POST', 'accounts/delete', { hosts: opt.host });
  console.log(`已删除 ${r.removed} 个，剩余 ${r.total} 个`);
}

const run = { add: cmdAdd, list: cmdList, delete: cmdDelete }[cmd];
if (!run) die(`未知命令 ${cmd}（可用：add / list / delete）`);
await run();
