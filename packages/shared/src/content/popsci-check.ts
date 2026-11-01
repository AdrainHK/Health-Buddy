import type { ContentRules } from '../api/content-rules.js';
import type { ContentCheckHit, PopsciContent, PopsciLocation } from '../api/popsci.js';
import { DRUG_NAMES, findBannedTerms, normalizeForCompliance } from '../compliance/index.js';

/**
 * 科普内容的确定性合规检查（M8 规格 2.3，Q3、Q7）。一律在后端执行（红线 5），前端只用来提前提示。
 *
 * - 内置检查（不能在后台关掉）：原有禁用词表 → 禁止；看不见的格式字符 → 禁止；
 *   药名 → 需要人工判断；具体百分比、剂量、“研究表明”、指南和书名号引用 → 需要人工判断（Q7）。
 * - 后台维护的词表（content_rules）：按组给出类别和原因。
 * 匹配前去掉空白、零宽字符和词中间的分隔符号，全角转半角，繁体转简体（同禁用词检查）。
 */

/** 默认规则，迁移时写成第 1 版。词语是候选，由平台在后台调整（Q3） */
export const POPSCI_DEFAULT_RULES: ContentRules = [
  {
    id: 'efficacy_promise',
    category: 'forbid',
    label: '疗效承诺',
    reason: '科普不能承诺疗效',
    terms: [
      '保证',
      '100%有效',
      '百分之百有效',
      '立竿见影',
      '根除',
      '彻底告别',
      '永不复发',
      '一次见效',
      '药到病除',
      '无效退款',
    ],
    negatable: true,
  },
  {
    id: 'absolute_terms',
    category: 'forbid',
    label: '绝对化用语',
    reason: '不能使用广告绝对化用语',
    terms: [
      '国家级',
      '顶级',
      '唯一有效',
      '唯一疗法',
      '全国第一',
      '排名第一',
      '效果最好',
      '疗效最好',
      '最有效',
      '最佳疗效',
      '最先进',
    ],
    negatable: true,
  },
  {
    id: 'alt_medicine',
    category: 'forbid',
    label: '替代医疗',
    reason: '不能建议停药或用其他方法代替药物治疗',
    terms: ['可以停药', '可以不吃药', '不用吃药', '不必吃药', '代替药物', '替代药物', '取代药物'],
    negatable: true,
  },
  {
    id: 'products',
    category: 'review',
    label: '药品和保健品',
    reason: '不能推荐或点名具体药品、保健品品牌，请核对',
    terms: ['保健品', '胶囊', '口服液', '特效药', '偏方', '秘方', '品牌'],
    negatable: false,
  },
  {
    id: 'disease_names',
    category: 'review',
    label: '疾病名称',
    reason: '提到疾病名称，请核对表述没有判断疾病或针对个人',
    terms: [
      '高血压',
      '糖尿病',
      '冠心病',
      '心梗',
      '脑卒中',
      '中风',
      '癌',
      '肿瘤',
      '抑郁症',
      '焦虑症',
      '痛风',
      '高血脂',
      '肾病',
      '脂肪肝',
      '骨质疏松',
    ],
    negatable: false,
  },
];

const NEGATIONS = /[不别勿没无非未莫]/;
const NEGATION_WINDOW = 4;
const INVISIBLE = /[\p{Cf}\p{Cc}͏︀-️]/u;

/** 数字和引用（Q7）：模型可能编造来源，标为“需要人工判断” */
const CITATION_PATTERNS: readonly RegExp[] = [
  /\d+(?:\.\d+)?\s*[%％]/g,
  /百分之[零一二三四五六七八九十百\d]+/g,
  /(?:研究|调查|数据|统计|实验)(?:表明|显示|发现|证实|证明)/g,
  /指南|专家共识|《[^》]{1,30}》/g,
  /\d+(?:\.\d+)?\s*(?:毫克|微克|毫升|千卡|大卡|mmol|mmHg|mg|ml|kcal|克|片|粒)/gi,
];

interface Field {
  location: PopsciLocation;
  text: string;
}

const at = (
  field: PopsciLocation['field'],
  index: number | null = null,
  item: number | null = null,
) => ({
  field,
  index,
  item,
});

/** 内容里每一段要检查的文字和它的位置 */
export function popsciTextFields(content: PopsciContent): Field[] {
  switch (content.kind) {
    case 'popsci_article':
      return [
        { location: at('title'), text: content.title },
        ...content.sections.flatMap((s, i) => [
          { location: at('heading', i), text: s.heading },
          { location: at('body', i), text: s.body },
        ]),
        { location: at('summary'), text: content.summary },
      ];
    case 'lecture_deck':
      return [
        { location: at('title'), text: content.title },
        ...content.slides.flatMap((s, i) => [
          { location: at('slideTitle', i), text: s.title },
          ...s.bullets.map((b, j) => ({ location: at('bullet', i, j), text: b })),
          { location: at('notes', i), text: s.notes },
        ]),
      ];
    case 'community_post':
      return [
        ...content.paragraphs.map((p, i) => ({ location: at('paragraph', i), text: p })),
        { location: at('interaction'), text: content.interaction },
      ];
  }
}

function findTerm(norm: string, term: string, negatable: boolean): boolean {
  const t = normalizeForCompliance(term).text;
  if (!t) return false;
  let from = 0;
  for (;;) {
    const i = norm.indexOf(t, from);
    if (i === -1) return false;
    if (!negatable || !NEGATIONS.test(norm.slice(Math.max(0, i - NEGATION_WINDOW), i))) return true;
    from = i + t.length;
  }
}

/**
 * 检查科普内容。每个位置每条规则每个词最多报一次；“禁止”类在前。
 * rules 是当前版本的后台词表；内置检查总是执行。
 */
export function checkPopsciContent(content: PopsciContent, rules: ContentRules): ContentCheckHit[] {
  const hits: ContentCheckHit[] = [];
  for (const { location, text } of popsciTextFields(content)) {
    if (!text) continue;
    if (INVISIBLE.test(text.replace(/[\n\t]/g, ''))) {
      hits.push({
        ruleId: 'builtin_invisible',
        category: 'forbid',
        term: '',
        reason: '文字里有看不见的格式字符，请删除',
        location,
      });
    }
    for (const issue of findBannedTerms(text)) {
      if (
        hits.some(
          (h) => h.ruleId === 'builtin_banned' && h.term === issue.term && h.location === location,
        )
      )
        continue;
      hits.push({
        ruleId: 'builtin_banned',
        category: 'forbid',
        term: issue.term,
        reason: issue.reason,
        location,
      });
    }
    const norm = normalizeForCompliance(text).text;
    for (const group of rules) {
      for (const term of group.terms) {
        if (findTerm(norm, term, group.negatable)) {
          hits.push({
            ruleId: group.id,
            category: group.category,
            term,
            reason: group.reason,
            location,
          });
        }
      }
    }
    for (const drug of DRUG_NAMES) {
      if (findTerm(norm, drug, false)) {
        hits.push({
          ruleId: 'builtin_drug',
          category: 'review',
          term: drug,
          reason: '提到药名，请核对没有推荐用药；用药一律写“请遵医嘱”',
          location,
        });
      }
    }
    const nfkc = text.normalize('NFKC');
    const seen = new Set<string>();
    for (const pattern of CITATION_PATTERNS) {
      for (const m of nfkc.matchAll(pattern)) {
        const term = m[0].slice(0, 30);
        if (seen.has(term)) continue;
        seen.add(term);
        hits.push({
          ruleId: 'builtin_citation',
          category: 'review',
          term,
          reason: '出现具体数字或引用，可能不准确，请核对来源',
          location,
        });
      }
    }
  }
  return hits.sort((a, b) => (a.category === b.category ? 0 : a.category === 'forbid' ? -1 : 1));
}

/** 有没有“禁止”类命中 */
export const hasForbiddenHits = (hits: readonly ContentCheckHit[]) =>
  hits.some((h) => h.category === 'forbid');
/** 有没有要人工核对的项目 */
export const hasReviewHits = (hits: readonly ContentCheckHit[]) =>
  hits.some((h) => h.category === 'review');
