// 测试辅助（文件名不含 .test，不会被当作测试执行）
import { defaultSettings } from '../src/control/settings.js';

/** 测试 KV 预置的后台 cookie 签名密钥（app 级测试用它签 cookie） */
export const TEST_AUTH_KEY = 'ab'.repeat(32);

export function memKV(init = {}) {
  const m = new Map(Object.entries({ 'nt.authkey': TEST_AUTH_KEY, ...init }).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const kv = {
    reads: 0, writes: 0, m,
    async get(k, opt) { kv.reads++; const v = m.get(k); if (v == null) return null; return opt?.type === 'json' || opt === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { kv.writes++; m.set(k, String(v)); },
  };
  return kv;
}

/** 假 fetch：routes = {url前缀: 文本 | (url)=>Response}；未命中返回 404 */
export function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    for (const [prefix, v] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return typeof v === 'function' ? v(url) : new Response(v, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

export function settingsWith(patch = {}) {
  const s = defaultSettings();
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ||= {}, v); else a[k] = v; } };
  merge(s, patch);
  return s;
}

export const UUID = '5d7b401c-1111-4222-8333-444455556666';

export function resolvedNodes() {
  return [
    { id: 'a', name: '日本-住宅-01', origin: 'custom', address: '1.2.3.4', port: 443, path: '/?ed=2560', host: 'vp2.example.com' },
    { id: 'b', name: 'CF-电信-01', origin: 'random', address: '2606:4700::1', port: 2053, path: '/', host: 'vp3.example.com' },
    { id: 'c', name: '外部-01', origin: 'link', link: 'trojan://pw@9.9.9.9:443?security=tls&type=ws&host=x.com&sni=x.com&path=%2Fws#%E5%A4%96%E9%83%A8-01', host: '' },
  ];
}
