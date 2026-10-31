// 身份推导：UUID / 订阅 token / 后台 cookie —— 算法与上游 cmliu/edgetunnel 完全一致（_worker.js 30–37、89、102 行）。
import { md5md5 } from '../lib/md5.js';

export const DEFAULT_SECRET_KEY = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/** 与上游 整理成数组(5911 行) 等价的同步拆分（Tab/引号/换行/逗号分隔），额外去掉空项与首尾空白 */
export function splitEnvList(text) {
  return String(text || '').replace(/[\t"'\r\n]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function adminPasswordOf(env) {
  return env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY || env.UUID || env.uuid || '';
}

/**
 * @param {Record<string,any>} env
 * @param {string} requestHostname
 */
export function deriveIdentity(env, requestHostname) {
  const adminPassword = adminPasswordOf(env);
  const secretKey = env.KEY || DEFAULT_SECRET_KEY;
  const m = md5md5(adminPassword + secretKey);
  const envUUID = env.UUID || env.uuid;
  const envUuidValid = !!(envUUID && UUID_RE.test(envUUID));
  const uuid = envUuidValid
    ? envUUID.toLowerCase()
    : [m.slice(0, 8), m.slice(8, 12), '4' + m.slice(13, 16), '8' + m.slice(17, 20), m.slice(20)].join('-');
  const hosts = env.HOST
    ? splitEnvList(env.HOST).map((h) => h.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0])
    : [String(requestHostname || '').toLowerCase()];
  const host = hosts[0];
  return {
    adminPassword, secretKey, uuid, host,
    // UUID 来源：env=环境变量（合法 v4）；derived=由 ADMIN+KEY 推导。设置了 UUID 但格式不是标准 v4 时会被忽略（与 edgetunnel 一致），envUuidInvalid=true
    uuidSource: envUuidValid ? 'env' : 'derived', envUuidInvalid: !!envUUID && !envUuidValid,
    subToken: md5md5(host + uuid),
    hasCustomKey: secretKey !== DEFAULT_SECRET_KEY,
  };
}

/** 后台 cookie 值（与上游一致，绑定 UA） */
export const authCookieValue = (ua, identity) => md5md5(ua + identity.secretKey + identity.adminPassword);
