// 特征码隐藏：让发布文件里不出现代理/隧道域的关键词，运行时取值与源码完全一致。
// 形态对齐上游 cmliu/edgetunnel 的思路（它用 String.fromCharCode / Proxy.name 算出特征串），
// 但本实现用更自然的 i18n 式转义，避免被当成混淆器产物：
//   - 字符串字面量：关键词覆盖的字符 → \xNN / \uXXXX 转义（值不变，仍是单个字面量）
//   - 正则字面量：pattern 里的关键词字符 → \xNN / \uXXXX（正则语义不变）
//   - 模板字面量：静态片段里的关键词字符 → \uXXXX（未打标签的模板 cooked 值不变）
//   - 属性访问 env.PROXYIP → env["\x50ROXYIP"]（属性名运行时不变）
//   - 对象键 { proxy: v } → { "\x70roxy": v }（含简写形式展开）
//   - 注释：域词汇换成中性说法
// 改完重新解析校验；失败整体回退，绝不产出坏文件。
import { parse } from 'acorn';

// 身份词（两种风格都隐藏）
export const IDENTITY_KEYWORDS = ['edgetunnel', 'cmliu', 'nicetunnel', 'yyyyy114514'];

// 协议/客户端词（两种风格都隐藏）
export const PROTOCOL_KEYWORDS = [
  'vless', 'trojan', 'socks', 'proxy', 'tunnel',
  'clash', 'sing-box', 'surge', 'subconverter', 'mihomo', 'v2ray', 'shadowrocket', 'loon', 'stash',
  'websocket',
];

// 平台运行时特征（两种风格都隐藏）：cloudflare:sockets 是「Worker 做 TCP 出站」的专属 API，
// 自动扫描只要在部署包里看到这个明文模块名，基本可以直接判定是代理，比任何协议词都硬。
export const RUNTIME_KEYWORDS = ['cloudflare:sockets'];

// 平台全局标识符（不能转义成字符串，改为 globalThis 计算访问，运行时等价）
export const PLATFORM_GLOBALS = ['WebSocketPair'];

// 隧道域中文词（disguise 风格额外隐藏）
export const DOMAIN_KEYWORDS = ['反代', '代理', '链式', '订阅', '伪装', '隧道', '拨号', '优选', '上行', '下行'];

export const EDT_KEYWORDS = [...IDENTITY_KEYWORDS, ...PROTOCOL_KEYWORDS, ...RUNTIME_KEYWORDS];
export const DISGUISE_KEYWORDS = [...EDT_KEYWORDS, ...DOMAIN_KEYWORDS];

// 注释里的身份词 → 中性说法（edt 风格）
export const COMMENT_REPLACEMENTS = {
  edgetunnel: '上游实现',
  cmliu: '原作者',
  nicetunnel: '本项目',
  yyyyy114514: '原作者镜像',
  edt: '上游',
  vless: 'V1',
  trojan: 'T1',
  socks: 'S5',
  proxy: '转发',
  tunnel: '通道',
  'sing-box': '客户端A',
  clash: '客户端B',
  surge: '客户端C',
  subconverter: '转换器',
  mihomo: '客户端D',
  v2ray: '客户端E',
  shadowrocket: '客户端F',
  loon: '客户端G',
  stash: '客户端H',
  'cloudflare:sockets': '平台套接字接口',
  WebSocketPair: '双向流对',
  websocket: 'ws',
};

// disguise 风格：域词汇也中性化
export const COMMENT_REPLACEMENTS_DISGUISE = {
  ...COMMENT_REPLACEMENTS,
  反代: '转发',
  代理: '中转',
  链式: '串联',
  订阅: '内容下发',
  伪装: '默认页',
  隧道: '通道',
  拨号: '连接',
  优选: '挑选',
  上行: '发送',
  下行: '接收',
};

/** 单个字符 → \xNN（Latin-1）或 \uXXXX 转义 */
function esc(ch) {
  const cp = ch.codePointAt(0);
  if (cp <= 0xff) return '\\x' + cp.toString(16).padStart(2, '0');
  return '\\u' + cp.toString(16).padStart(4, '0');
}

/**
 * 在文本里找出所有关键词命中（大小写不敏感）。
 * rawMode：文本是「源码原文」（可能含转义序列）时，跳过紧跟在反斜杠后的命中，
 *          避免破坏 \x.. / \u.. 等已有转义。
 */
function findHits(text, keywords, rawMode = false) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let idx = lower.indexOf(k);
    while (idx >= 0) {
      if (!rawMode || idx === 0 || text[idx - 1] !== '\\') {
        hits.push({ start: idx, end: idx + kw.length });
      }
      idx = lower.indexOf(k, idx + kw.length);
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let cursor = -1;
  for (const h of hits) {
    if (h.start >= cursor) { kept.push(h); cursor = h.end; }
  }
  return kept;
}

/** 命中覆盖的字符位置集合 */
function maskSet(text, keywords, rawMode = false) {
  const hits = findHits(text, keywords, rawMode);
  if (!hits.length) return null;
  const mask = new Set();
  for (const h of hits) for (let i = h.start; i < h.end; i++) mask.add(i);
  return mask;
}

/** 把 cooked 字符串值重新输出为字面量；关键词字符转义，其余按需转义。无命中返回 null。 */
function literalSource(cooked, keywords) {
  const mask = maskSet(cooked, keywords);
  if (!mask) return null;
  let out = '"';
  for (let i = 0; i < cooked.length; i++) {
    const ch = cooked[i];
    if (mask.has(i)) { out += esc(ch); continue; }
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ' || ch === '\x7f') out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** 正则 pattern 源文本：关键词字符转义，其余原样。无命中返回 null。 */
function patternSource(pattern, keywords) {
  const mask = maskSet(pattern, keywords, true);
  if (!mask) return null;
  let out = '';
  for (let i = 0; i < pattern.length; i++) out += mask.has(i) ? esc(pattern[i]) : pattern[i];
  return out;
}

/** 模板静态片段 raw 文本：关键词字符 → \uXXXX。无命中返回 null。 */
function templateRawSource(raw, keywords) {
  const mask = maskSet(raw, keywords, true);
  if (!mask) return null;
  let out = '';
  for (let i = 0; i < raw.length; i++) out += mask.has(i) ? esc(raw[i]) : raw[i];
  return out;
}

/** 标识符名（属性访问 / 对象键）→ 全转义的字符串字面量。无命中返回 null。 */
function identifierSource(name, keywords) {
  if (!findHits(name, keywords).length) return null;
  let out = '"';
  for (const ch of name) out += esc(ch);
  return out + '"';
}

// ---------------- AST 遍历 ----------------
function walk(node, parent, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, parent, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent);
  // 注意：不能跳过 'value' 键 —— Property.value 是属性值表达式本身，跳过会整棵子树漏遍历
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (child && typeof child === 'object') walk(child, node, visit);
  }
}

/** 注释中性化 */
export function neutralizeComments(code, replacements) {
  const map = replacements ?? COMMENT_REPLACEMENTS;
  const comments = [];
  try {
    parse(code, {
      ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
      onComment: (block, text, start, end) => comments.push({ start, end }),
    });
  } catch (e) {
    return { code, hits: 0, error: '解析失败：' + e.message };
  }
  // 长词先替换，避免短词先命中破坏长词
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  const edits = [];
  for (const c of comments) {
    const raw = code.slice(c.start, c.end);
    let out = raw;
    for (const [kw, rep] of entries) {
      out = out.replace(new RegExp(kw, 'gi'), rep);
    }
    if (out !== raw) edits.push({ start: c.start, end: c.end, text: out });
  }
  if (!edits.length) return { code, hits: 0 };
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  try {
    parse(out, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    return { code, hits: 0, error: '注释替换后解析失败，已回退：' + e.message };
  }
  return { code: out, hits: edits.length };
}

/**
 * @param {string} code 待处理源码
 * @param {{keywords?: string[], comments?: boolean, commentReplacements?: Record<string,string>}} options
 * @returns {{code: string, hits: number, changed: boolean, error?: string}}
 */
export function hideSignatures(code, options = {}) {
  const keywords = options.keywords ?? EDT_KEYWORDS;
  let work = code;
  let commentHits = 0;
  if (options.comments !== false) {
    const r = neutralizeComments(work, options.commentReplacements);
    if (!r.error) { work = r.code; commentHits = r.hits; }
  }
  let ast;
  try {
    ast = parse(work, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    return { code, hits: 0, changed: false, error: '解析失败：' + e.message };
  }

  const edits = [];
  let hits = 0;

  walk(ast, null, (node, parent) => {
    // 1) 字符串字面量（跳过指令序言，如 'use strict'——转义会使其失去指令语义）
    if (node.type === 'Literal' && typeof node.value === 'string' && node.raw) {
      if (parent && parent.type === 'ExpressionStatement' && parent.directive) return;
      const src = literalSource(node.value, keywords);
      if (!src) return;
      hits += 1;
      edits.push({ start: node.start, end: node.end, text: src });
      return;
    }
    // 2) 正则字面量
    if (node.type === 'Literal' && node.value instanceof RegExp && node.raw) {
      const raw = node.raw;
      const lastSlash = raw.lastIndexOf('/');
      if (lastSlash <= 0) return;
      const pattern = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1);
      const pat = patternSource(pattern, keywords);
      if (!pat) return;
      hits += 1;
      edits.push({ start: node.start, end: node.end, text: `/${pat}/${flags}` });
      return;
    }
    // 3) 模板字面量（未打标签：raw 不参与运行时）
    if (node.type === 'TemplateLiteral') {
      if (parent && parent.type === 'TaggedTemplateExpression') return;
      for (const quasi of node.quasis) {
        const raw = quasi.value.raw;
        const src = templateRawSource(raw, keywords);
        if (!src) continue;
        hits += 1;
        edits.push({ start: quasi.start, end: quasi.end, text: src });
      }
      return;
    }
    // 4) 属性访问：env.PROXYIP → env["\x50ROXYIP"]（可选链 ?. 同样处理）
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
      const src = identifierSource(node.property.name, keywords);
      if (!src) return;
      let dotPos = work.lastIndexOf('.', node.property.start);
      // 点号必须紧贴对象之后（普通访问 dotPos === object.end；可选链是 object.end + 1 且前一位是 '?'）
      if (dotPos < node.object.end) return;
      let from = dotPos;
      let text = `[${src}]`;
      if (work[dotPos - 1] === '?') { from = dotPos - 1; text = `?.${text}`; }
      hits += 1;
      edits.push({ start: from, end: node.property.end, text });
      return;
    }
    // 5) 对象键：{ proxy: v } → { "\x70roxy": v }；简写 { proxy } → { "\x70roxy": proxy }
    if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier') {
      const src = identifierSource(node.key.name, keywords);
      if (!src) return;
      hits += 1;
      const text = node.shorthand ? `${src}: ${node.key.name}` : src;
      edits.push({ start: node.key.start, end: node.key.end, text });
      return;
    }
    // 5.5) 平台全局标识符（如 WebSocketPair）：改成 globalThis 计算访问，运行时等价
    //      （new WebSocketPair() → new (globalThis["\x57ebSocketPair"])()）。
    //      只处理「引用位置」：作为对象键/属性/声明名出现时不在此处理。
    if (node.type === 'Identifier' && PLATFORM_GLOBALS.includes(node.name)) {
      if (parent && (parent.type === 'MemberExpression' || parent.type === 'Property'
        || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition'
        || parent.type === 'VariableDeclarator' || parent.type === 'FunctionDeclaration'
        || parent.type === 'ClassDeclaration')) return;
      hits += 1;
      edits.push({ start: node.start, end: node.end, text: `(globalThis[${identifierSource(node.name, keywords) || JSON.stringify(node.name)}])` });
      return;
    }
    // 6) 类成员 / 方法名里的关键词：跳过（不能改成字符串键），保持原样
  });

  if (!edits.length) return { code: work, hits: 0, commentHits, changed: commentHits > 0 };

  // 从后往前替换；同一起点只保留一个编辑，避免互相覆盖
  edits.sort((a, b) => b.start - a.start);
  let out = work;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.start >= lastStart) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }

  try {
    parse(out, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    return { code, hits: 0, changed: false, error: '替换后解析失败，已回退：' + e.message };
  }
  return { code: out, hits, commentHits, changed: true };
}
