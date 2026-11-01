// 基于 AST 的 Workers 产物压缩与混淆。
// 只用构建期依赖（terser + javascript-obfuscator），不改 src 中的功能代码。
//
// 性能原则：
// - 不做控制流平坦化、死代码注入、反调试、控制台禁用、RC4、字符串运行时调用链变换。
// - 字符串仅 Base64 编码；variable wrapper 在模块初始化时解码一次，后续复用解码结果。
// - 不改对象属性名，避免破坏 env / Request / Response / KV / WebSocket 等外部接口。
import fs from 'node:fs';
import { minify } from 'terser';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { pathToFileURL } from 'node:url';

/**
 * 仅改标识符名（disguise 风格用）：不压缩、不删代码、保留注释，
 * 把所有局部/顶层绑定改成短名，消除 `SOCKS5白名单`、`所有反代数组` 这类
 * 自带关键词的标识符。属性名与环境变量名不动（外部接口）。
 * 注意：必须在特征码转义【之前】执行——terser 会按字符串值重新输出字面量，
 * 先转义会被它还原成明文。
 * @param {string} source 已打包好的单文件 ESM
 */
export async function mangleIdentifiers(source) {
  const result = await minify(source, {
    module: true,
    compress: false,
    mangle: { toplevel: true, properties: false },
    format: { comments: true, beautify: true, indent_level: 2, ascii_only: false },
  });
  if (!result.code) throw new Error('Terser 未生成代码');
  return result.code;
}

/**
 * @param {string} source 已打包好的单文件 ESM
 * @param {{seed?: number, strings?: boolean}} options
 * @returns {Promise<{code: string, stats: {minifiedBytes: number, obfuscatedBytes: number}}>}
 */
export async function obfuscateWorker(source, options = {}) {
  const minified = await minify(source, {
    module: true,
    compress: {
      passes: 2,
      unsafe: false,
      unsafe_comps: false,
      unsafe_math: false,
      unsafe_methods: false,
      pure_getters: false,
    },
    mangle: {
      properties: false,
    },
    format: {
      comments: false,
      ascii_only: false,
    },
  });
  if (!minified.code) throw new Error('Terser 未生成代码');

  const result = JavaScriptObfuscator.obfuscate(minified.code, {
    target: 'browser',
    seed: options.seed ?? 0,
    compact: true,
    log: false,

    // 标识符混淆；属性名和全局导出不改。
    identifierNamesGenerator: 'hexadecimal',
    identifiersPrefix: '',
    renameGlobals: false,
    renameProperties: false,
    transformObjectKeys: false,

    // 低开销字符串混淆：启动时解码，不在每次请求时重复执行复杂解密。
    stringArray: options.strings !== false,
    stringArrayThreshold: 0.75,
    stringArrayEncoding: ['base64'],
    stringArrayShuffle: true,
    stringArrayRotate: false,
    stringArrayIndexShift: true,
    stringArrayIndexesType: ['hexadecimal-number'],
    stringArrayWrappersType: 'variable',
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: false,
    stringArrayCallsTransform: false,
    splitStrings: false,

    // 不把数字改成重复求值的表达式，避免给热路径增加无意义运算。
    numbersToExpressions: false,
    simplify: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    selfDefending: false,
    domainLock: [],
    forceTransformStrings: [],
    reservedNames: [],
    reservedStrings: [],
    sourceMap: false,
    unicodeEscapeSequence: false,
  });

  const code = result.getObfuscatedCode();
  if (!code) throw new Error('javascript-obfuscator 未生成代码');
  return {
    code,
    stats: {
      minifiedBytes: Buffer.byteLength(minified.code),
      obfuscatedBytes: Buffer.byteLength(code),
    },
  };
}

// 独立用法：node scripts/obfuscate.mjs <in.js> <out.js> [--no-strings]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('用法：node scripts/obfuscate.mjs <in.js> <out.js> [--no-strings]');
    process.exit(1);
  }
  const source = fs.readFileSync(input, 'utf8');
  const { code, stats } = await obfuscateWorker(source, { strings: !process.argv.includes('--no-strings') });
  fs.writeFileSync(output, code);
  console.log(`已生成 ${output}：压缩 ${(stats.minifiedBytes / 1024).toFixed(1)} KB，混淆 ${(stats.obfuscatedBytes / 1024).toFixed(1)} KB`);
}
