// 运营商识别：逻辑等价于上游 edgetunnel 的 识别运营商()，仅国内(CN)请求区分 ct/cu/cmcc，其余归为 cf。
// 输入是 Workers 的 request.cf（只读 country/asn/asOrganization）。

const ASN_MAP = {
  4134: 'ct', 4809: 'ct', 4811: 'ct', 4812: 'ct', 4815: 'ct',
  4837: 'cu', 4814: 'cu', 9929: 'cu', 17623: 'cu', 17816: 'cu',
  9808: 'cmcc', 24400: 'cmcc', 56040: 'cmcc', 56041: 'cmcc', 56044: 'cmcc',
};
const NAME_PATTERNS = [
  ['ct', /chinanet|chinatelecom|china telecom|cn2|shtel/],
  ['cmcc', /cmi|cmnet|chinamobile|china mobile|cmcc|mobile communications/],
  ['cu', /china169|china unicom|chinaunicom|cucc|cncgroup|cuii|netcom/],
];

/** @param {{country?:string, asn?:number|string, asOrganization?:string}|undefined|null} cf @returns {'ct'|'cu'|'cmcc'|'cf'} */
export function detectIsp(cf) {
  if (String(cf?.country || '').toLowerCase() !== 'cn') return 'cf';
  const org = String(cf?.asOrganization || '').toLowerCase();
  for (const [code, re] of NAME_PATTERNS) if (re.test(org)) return code;
  return ASN_MAP[String(cf?.asn || '')] || 'cf';
}

export const ISP_LABEL = { ct: '电信', cu: '联通', cmcc: '移动', cf: '官方' };
