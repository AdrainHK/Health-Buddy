/**
 * 产品边界用词检查。
 *
 * 面向客户和宣传的文案不能把产品说成医疗诊断或治疗手段。
 * 这里只做确定性的词表匹配；语义层面的审查在 AI 评测和 compliance-reviewer 子代理里做。
 */
import { PRODUCT_NAME } from '../brand.js';

export interface BannedTerm {
  term: string;
  /** 写给开发者看的原因，也会出现在检查结果里。 */
  reason: string;
}

export const BANNED_TERMS: readonly BannedTerm[] = [
  { term: '诊断', reason: '产品不做医疗诊断，分析结果须标注“仅供参考，非医疗诊断”' },
  { term: '确诊', reason: '产品不做医疗诊断' },
  { term: '筛查', reason: '不能宣称具备疾病筛查能力' },
  { term: '治愈', reason: '不能承诺疗效' },
  { term: '根治', reason: '不能承诺疗效' },
  { term: '药到病除', reason: '不能承诺疗效' },
  { term: '包治', reason: '不能承诺疗效' },
];

/** 标准免责声明，所有分析、预测、专家意见都要带上。 */
export const DISCLAIMER = '仅供参考，非医疗诊断';

/** 问一问的回答不经过审核，固定加这段提示（M1 规格 7.3） */
export const ASK_DISCLAIMER = '仅供健管师参考，非医疗诊断，请勿直接转发给客户';

/** 专家意见（专家中心的回答、专家标签）末尾固定加这段提示，由后端拼接（M3 规格 2.3、4.2） */
export const EXPERT_DISCLAIMER = '仅供健管师专业参考，非医疗诊断，请勿直接转发给客户';

/**
 * Q13：在拿到具体热线列表之前，心理危机提示统一用这段通用措辞。只给健管师看。
 * 后端拼在回答和专业版最前面，工作台的危机提示框用同一段文字（i18n 测试核对）。
 */
export const CRISIS_NOTICE =
  '客户可能存在心理危机信号，请按危机流程处理：立即联系客户本人和家属，必要时拨打当地急救电话。';

/** 疑似急症提示（M3 规格 7.2 第 5 条）。只给健管师看，用法同 CRISIS_NOTICE */
export const EMERGENCY_NOTICE =
  '健管师转述的情况里有疑似急症，请建议客户及时就医，必要时拨打当地急救电话。';

/**
 * 常见慢病用药的药名和药物类别。面向客户的文字、面谈提纲（M2 规格 2.8）和专家意见（M3 规格 7.1）
 * 都不能点名药物；工作台技能和专家引擎共用这一份（packages/skills 的 wording.ts 重新导出）。
 */
export const DRUG_NAMES = [
  '降压药',
  '降糖药',
  '降脂药',
  '止痛药',
  '感冒药',
  '安眠药',
  '布洛芬',
  '对乙酰氨基酚',
  '他汀',
  '二甲双胍',
  '胰岛素',
  '阿司匹林',
  '氨氯地平',
  '硝苯地平',
  '缬沙坦',
  '厄贝沙坦',
  '氯沙坦',
  '美托洛尔',
  '格列美脲',
  '格列齐特',
  '阿卡波糖',
  '达格列净',
  '恩格列净',
  '西格列汀',
  '司美格鲁肽',
  '利拉鲁肽',
  '非诺贝特',
  '依折麦布',
  '氯吡格雷',
  '华法林',
  '左甲状腺素',
  '非布司他',
  '别嘌醇',
  '苯溴马隆',
  '秋水仙碱',
  '舍曲林',
  '帕罗西汀',
  '艾司唑仑',
] as const;

/** 不算违规的固定提示语：标准免责声明、问一问和专家意见末尾由后端拼接的提示（都含“非医疗诊断”） */
const ALLOWED_PHRASES = [ASK_DISCLAIMER, EXPERT_DISCLAIMER, DISCLAIMER] as const;

export interface ComplianceIssue {
  term: string;
  reason: string;
  /** 在原文中的起始位置（按 UTF-16 码元计）。 */
  index: number;
}

/** 零宽字符：插在词中间可以绕过简单的字符串匹配。 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;

/**
 * 插在词中间的分隔符号（如“诊·断”“根-治”），规范化时去掉。
 * 不含逗号和句号：去掉它们会把相邻两句的字拼成禁用词，误报太多。
 */
const IN_WORD_PUNCT = /[·•・‧\-_~*/|.、]/;

/** 禁用词里用到的繁体字，统一成简体再匹配 */
const TRADITIONAL: Record<string, string> = {
  診: '诊',
  斷: '断',
  確: '确',
  篩: '筛',
  癒: '愈',
  藥: '药',
  醫: '医',
  療: '疗',
  專: '专',
};

interface Normalized {
  text: string;
  /** 规范化后每个字符对应的原文位置 */
  origin: number[];
}

/**
 * 匹配前先规范化：去掉空白、零宽字符和词中间的分隔符号，全角转半角（NFKC），繁体转简体。
 * 同时记下每个字符在原文中的位置，便于把问题标回原文。
 */
export function normalizeForCompliance(text: string): Normalized {
  let out = '';
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    if (!/\s/.test(ch) && !ZERO_WIDTH.test(ch)) {
      for (const n of ch.normalize('NFKC')) {
        if (IN_WORD_PUNCT.test(n) || /\s/.test(n)) continue;
        out += TRADITIONAL[n] ?? n;
        for (let k = 0; k < n.length; k++) origin.push(i);
      }
    }
    i += ch.length;
  }
  return { text: out, origin };
}

/**
 * 找出文案中的禁用词。
 * 匹配前去掉空格、零宽字符和词中间的分隔符号，统一全角半角和繁简，
 * “筛 查”“根\u200B治”“诊·断”“確診”这类写法同样会被找出。
 * 标准免责声明和后端固定拼接的提示语（ASK_DISCLAIMER、EXPERT_DISCLAIMER）里的“诊断”是允许的，不算违规。
 */
export function findBannedTerms(text: string): ComplianceIssue[] {
  const { text: norm, origin } = normalizeForCompliance(text);
  // 长的在前：专家和问一问的提示语里含标准免责声明
  let masked = norm;
  for (const phrase of ALLOWED_PHRASES) {
    const p = normalizeForCompliance(phrase).text;
    masked = masked.split(p).join(' '.repeat(p.length));
  }
  const issues: ComplianceIssue[] = [];
  for (const { term, reason } of BANNED_TERMS) {
    let from = 0;
    for (;;) {
      const index = masked.indexOf(term, from);
      if (index === -1) break;
      issues.push({ term, reason, index: origin[index] ?? 0 });
      from = index + term.length;
    }
  }
  return issues.sort((a, b) => a.index - b.index);
}

/** 文案是否以标准免责声明结尾（忽略末尾空白）。 */
export function endsWithDisclaimer(text: string): boolean {
  return text.trimEnd().endsWith(DISCLAIMER);
}

/** 规范化后免责声明出现的次数，用于检查是否重复 */
export function countDisclaimers(text: string): number {
  const norm = normalizeForCompliance(text).text;
  const d = normalizeForCompliance(DISCLAIMER).text;
  return norm.split(d).length - 1;
}

/**
 * 复制和导出给客户的最终文本（规格 3.6）：已审核的通俗版（已带免责声明），末尾加产品名称。
 * 产品名称只在交付时拼接，不存进产物内容。
 */
export function buildClientDeliverable(clientFacing: string): string {
  return `${clientFacing.trimEnd()}\n\n— ${PRODUCT_NAME}`;
}
