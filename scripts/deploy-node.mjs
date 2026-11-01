#!/usr/bin/env node
// 把节点包（dist/_worker.node.js）直接上传部署到 Cloudflare Pages 项目。零依赖，Node 18+。
//
// 用途：节点 Pages 项目是"直接上传"部署的，Cloudflare 不允许用 API 重试这类部署；加了新绑定（例如多用户的
// NT_MU / NT_AE）或者要更新节点代码时，需要重新上传一次。本脚本做的就是控制台里"上传新版本"那一步。
//
// 用法：
//   CF_API_TOKEN=... node scripts/deploy-node.mjs --account <AccountID> --project <Pages项目名> [--file dist/_worker.node.js] [--branch main]
//   CF_API_TOKEN=... node scripts/deploy-node.mjs --account <AccountID> --host v1n1.example.com     （按域名找项目）
//
// Token 需要「Cloudflare Pages: Edit」。只上传 _worker.js：节点代码自己处理所有请求，不需要静态文件。
// 退出码：0 成功；1 参数 / 网络 / 接口错误。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

async function call(token, method, url, body, headers = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(120000) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      if (r.ok && json?.success !== false) return json;
      last = new Error(`HTTP ${r.status} ${json?.errors?.[0]?.message || text.slice(0, 200)}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw last;
}

/** 按域名找 Pages 项目（列表接口不接受 per_page=100，逐页翻） */
export async function findProjectByHost(token, account, host) {
  const want = String(host).toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const j = await call(token, 'GET', `/accounts/${account}/pages/projects?page=${page}`);
    const list = j?.result || [];
    const p = list.find((x) => [x.subdomain, ...(x.domains || [])].map((d) => String(d).toLowerCase()).includes(want));
    if (p) return p.name;
    if (!list.length || page >= (j?.result_info?.total_pages || page)) break;
  }
  return null;
}

/** 上传部署：manifest 为空（没有静态文件），附带 _worker.js */
export async function deployWorker(token, account, project, code, branch) {
  const form = new FormData();
  form.append('manifest', '{}');
  if (branch) form.append('branch', branch);
  form.append('_worker.js', new Blob([code], { type: 'application/javascript' }), '_worker.js');
  const j = await call(token, 'POST', `/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments`, form);
  return j?.result;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const token = process.env.CF_API_TOKEN || o.token;
  const account = o.account;
  if (!token || !account || (!o.project && !o.host)) {
    console.error('用法：CF_API_TOKEN=... node scripts/deploy-node.mjs --account <AccountID> (--project <项目名> | --host <节点域名>) [--file dist/_worker.node.js] [--branch main]');
    process.exit(1);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = o.file || path.join(here, '..', 'dist', '_worker.node.js');
  const code = fs.readFileSync(file);
  const project = o.project || await findProjectByHost(token, account, o.host);
  if (!project) { console.error('没找到承载 ' + o.host + ' 的 Pages 项目'); process.exit(1); }
  console.log(`上传 ${path.basename(file)}（${(code.length / 1024).toFixed(0)} KB）到 Pages 项目 ${project} …`);
  const d = await deployWorker(token, account, project, code, typeof o.branch === 'string' ? o.branch : undefined);
  console.log(`已创建部署 ${d?.id}（${d?.environment || '-'}），地址 ${d?.url || '-'}，状态 ${d?.latest_stage?.name || '-'} ${d?.latest_stage?.status || ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('部署失败：' + (e?.message || e)); process.exit(1); });
}
