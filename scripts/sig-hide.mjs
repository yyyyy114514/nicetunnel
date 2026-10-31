// 特征码隐藏：把源码里容易被静态扫描命中的关键词（项目身份、协议名、作者标识）
// 改成运行时表达式计算，形态对齐上游 cmliu/edgetunnel 的「查杀特征码」做法：
//   const 特征码字典 = [
//       (Proxy.name + "IP").toUpperCase(),
//       (String.fromCharCode(67, 109) + URL.name[2] + 'i' + URL.name[0]).toLowerCase(),
//   ];
// 关键词本身不出现在文件里，运行时取值与原来完全一致。
//
// 实现要点：
// - 用 acorn 精确定位字面量节点范围，只替换命中的那一段文本，代码其余部分（含注释、格式）逐字节不变。
// - 字符串字面量 → 拆成「普通片段 + String.fromCharCode(...)」的拼接表达式。
// - 模板字面量静态片段 → 插入 ${String.fromCharCode(...)} 插值（仅限未打标签的模板）。
// - 正则字面量 → 换成 new RegExp(<计算出的pattern>, flags)，正则语义不变。
// - 跳过对象键、import/export 来源、指令序言（'use strict'）等必须保持字面量的位置。
// - 改完重新解析校验；万一解析失败则整体回退到原文，绝不产出坏文件。
import { parse } from 'acorn';

// 默认隐藏的关键词（大小写不敏感匹配，替换时保留原字符的大小写）
export const DEFAULT_KEYWORDS = [
  'edgetunnel',
  'cmliu',
  'nicetunnel',
  'yyyyy114514',
  'vless',
  'trojan',
  'socks',
  'proxy',
  'tunnel',
];

// 注释里的身份词：不做表达式计算，直接换成中性说法（注释不影响运行）
export const COMMENT_REPLACEMENTS = {
  edgetunnel: '上游实现',
  cmliu: '原作者',
  nicetunnel: '本项目',
  yyyyy114514: '原作者镜像',
  edt: '上游',
  vless: 'V1',
  trojan: 'T1',
  socks: 'S5',
  proxy: '代理',
  tunnel: '隧道',
};

const ESC = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\' };

/** 把一段原始文本放进 JS 字符串字面量（按给定引号转义） */
function toLiteral(text, quote) {
  let out = quote;
  for (const ch of text) {
    if (ch === quote) out += '\\' + ch;
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out + quote;
}

/** 关键词 → String.fromCharCode(...) 表达式 */
function charCodeExpr(text) {
  const codes = [...text].map((c) => c.codePointAt(0));
  return `String.fromCharCode(${codes.join(',')})`;
}

/**
 * 在文本里找出所有关键词命中，返回 [{start, end, text}]（相对文本的偏移）
 * rawMode：文本是「源码原文」（可能含转义序列），此时跳过紧跟在反斜杠后的命中，
 *          避免把 \vless 里的 vless 当成关键词、破坏转义语义。
 */
function findHits(text, keywords, rawMode = false) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let idx = lower.indexOf(k);
    while (idx >= 0) {
      if (!rawMode || (idx === 0 ? false : text[idx - 1] !== '\\')) {
        hits.push({ start: idx, end: idx + kw.length, text: text.slice(idx, idx + kw.length) });
      }
      idx = lower.indexOf(k, idx + kw.length);
    }
  }
  // 去重叠（长关键词优先）
  hits.sort((a, b) => (a.start - b.start) || (b.end - b.end - a.end + a.end));
  const kept = [];
  let cursor = -1;
  for (const h of hits) {
    if (h.start >= cursor) { kept.push(h); cursor = h.end; }
  }
  return kept;
}

/** 把带关键词的文本转换成表达式片段数组 */
function buildSegments(text, keywords, rawMode = false) {
  const hits = findHits(text, keywords, rawMode);
  if (!hits.length) return null;
  const segs = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) segs.push({ type: 'text', value: text.slice(pos, h.start) });
    segs.push({ type: 'kw', value: h.text });
    pos = h.end;
  }
  if (pos < text.length) segs.push({ type: 'text', value: text.slice(pos) });
  return segs;
}

/** 遍历 AST */
function walk(node, parent, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, parent, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent);
  for (const key of Object.keys(node)) {
    // 注意：不能跳过 'value' —— Property.value 是属性值表达式本身，跳过它会整棵子树漏遍历。
    // 字面量的 value 是字符串/正则（非 AST 节点），下面的 typeof 判断会自然跳过。
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (child && typeof child === 'object') walk(child, node, visit);
  }
}

/** 决定这个字符串字面量能不能替换 */
function isSafeLiteral(node, parent, patternKeys) {
  if (!parent) return false;
  // 解构模式里的键不能改成计算属性（会改变解构语义），保持原样
  if (patternKeys && patternKeys.has(node)) return false;
  if ((parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') && parent.key === node && !parent.computed) return false;
  if ((parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportAllDeclaration') && parent.source === node) return false;
  if (parent.type === 'ExpressionStatement' && parent.directive) return false;
  if (parent.type === 'TemplateLiteral' && parent.quasis && parent.quasis.includes(node)) return false;
  return true;
}

/**
 * 注释中性化：把注释里的身份词（上游项目名、作者 id 等）换成中性说法。
 * 注释不影响运行，上游同样不在文件里出现自己的项目名。
 * @param {string} code
 * @param {Record<string,string>} replacements
 * @returns {{code: string, hits: number}}
 */
export function neutralizeComments(code, replacements = COMMENT_REPLACEMENTS) {
  const comments = [];
  try {
    parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      onComment: (block, text, start, end) => comments.push({ block, text, start, end }),
    });
  } catch (e) {
    return { code, hits: 0, error: '解析失败：' + e.message };
  }
  const edits = [];
  let hits = 0;
  for (const c of comments) {
    const raw = code.slice(c.start, c.end);
    let out = raw;
    for (const [kw, rep] of Object.entries(replacements)) {
      // 'edt' 只在独立成词时替换，避免破坏 vendor-edt.mjs 这类文件名
      const re = kw === 'edt'
        ? new RegExp(`(?<![A-Za-z0-9_-])${kw}(?![A-Za-z0-9_-])`, 'gi')
        : new RegExp(kw, 'gi');
      out = out.replace(re, rep);
    }
    if (out !== raw) {
      hits += 1;
      edits.push({ start: c.start, end: c.end, text: out });
    }
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
  return { code: out, hits };
}

/**
 * @param {string} code 待处理源码
 * @param {{keywords?: string[], comments?: boolean}} options
 * @returns {{code: string, hits: number, changed: boolean}}
 */
export function hideSignatures(code, options = {}) {
  const keywords = options.keywords ?? DEFAULT_KEYWORDS;
  let work = code;
  let commentHits = 0;
  if (options.comments !== false) {
    const r = neutralizeComments(work);
    if (!r.error) { work = r.code; commentHits = r.hits; }
  }
  let ast;
  try {
    ast = parse(work, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    return { code, hits: 0, changed: false, error: '解析失败：' + e.message };
  }

  const edits = []; // {start, end, text}
  let hits = 0;

  // 先标出解构模式里的键：这些位置必须保持字面量
  const patternKeys = new WeakSet();
  walk(ast, null, (node) => {
    if (node.type !== 'ObjectPattern') return;
    for (const prop of node.properties || []) {
      if (prop && prop.key && prop.key.type === 'Literal') patternKeys.add(prop.key);
    }
  });

  walk(ast, null, (node, parent) => {
    // 1) 字符串字面量：按「 cooked 值」处理，重新用 JSON.stringify 输出，运行时取值完全不变
    if (node.type === 'Literal' && typeof node.value === 'string' && node.raw) {
      if (!isSafeLiteral(node, parent, patternKeys)) return;
      const cooked = node.value;
      const segs = buildSegments(cooked, keywords);
      if (!segs) return;
      const parts = segs.map((s) => (s.type === 'kw' ? charCodeExpr(s.value) : JSON.stringify(s.value)));
      hits += segs.filter((s) => s.type === 'kw').length;
      let text = parts.join(' + ');
      // 对象字面量的键：改成计算属性，运行时属性名保持一致
      if (parent && parent.type === 'Property' && parent.key === node) {
        text = parent.computed ? text : `[${text}]`;
      }
      edits.push({ start: node.start, end: node.end, text });
      return;
    }
    // 2) 正则字面量
    if (node.type === 'Literal' && node.value instanceof RegExp && node.raw) {
      const raw = node.raw;
      const lastSlash = raw.lastIndexOf('/');
      if (lastSlash <= 0) return;
      const pattern = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1);
      const segs = buildSegments(pattern, keywords, true);
      if (!segs) return;
      const parts = [];
      for (const s of segs) {
        if (s.type === 'kw') { parts.push(charCodeExpr(s.value)); continue; }
        // 正则片段转成 JS 字符串：只做一次转义，保证字符串值与原 pattern 完全一致
        const lit = toLiteral(s.value, '"');
        let roundTrip;
        try { roundTrip = JSON.parse(lit); } catch { return; } // 无法安全转义就放弃替换
        if (roundTrip !== s.value) return;
        parts.push(lit);
      }
      hits += segs.filter((s) => s.type === 'kw').length;
      edits.push({ start: node.start, end: node.end, text: `new RegExp(${parts.join(' + ')}, ${JSON.stringify(flags)})` });
      return;
    }
    // 3) 模板字面量（未打标签）：静态片段里塞插值
    if (node.type === 'TemplateLiteral') {
      // 打标签的模板不处理（raw 语义会变）
      const tagged = parent && parent.type === 'TaggedTemplateExpression';
      if (tagged) return;
      for (const quasi of node.quasis) {
        const raw = quasi.value.raw;
        const segs = buildSegments(raw, keywords, true);
        if (!segs) continue;
        const text = segs.map((s) => (s.type === 'kw' ? '${' + charCodeExpr(s.value) + '}' : s.value)).join('');
        hits += segs.filter((s) => s.type === 'kw').length;
        edits.push({ start: quasi.start, end: quasi.end, text });
      }
    }
  });

  if (!edits.length) return { code: work, hits: 0, changed: false };

  // 从后往前替换，保证偏移有效
  edits.sort((a, b) => b.start - a.start);
  let out = work;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // 校验：重新解析，失败则回退
  try {
    parse(out, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    return { code, hits: 0, changed: false, error: '替换后解析失败，已回退：' + e.message };
  }
  return { code: out, hits, commentHits, changed: true };
}
