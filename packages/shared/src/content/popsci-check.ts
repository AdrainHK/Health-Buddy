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
      '保证有效',
      '保证治好',
      '保证见效',
      '保证康复',
      '保证不复发',
      '100%有效',
      '百分百有效',
      '百分之百有效',
      '立竿见影',
      '根除疾病',
      '彻底根除',
      '彻底告别',
      '永不复发',
      '一次见效',
      '药到病除',
      '无效退款',
      '万能',
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
      '唯一的办法',
      '全国第一',
      '排名第一',
      '第一品牌',
      'NO.1',
      'TOP1',
      '效果最好',
      '疗效最好',
      '最好的方法',
      '最好的药',
      '效果最佳',
      '最佳疗效',
      '最有效',
      '最先进',
      '最安全',
      '最权威',
      '最科学',
    ],
    negatable: true,
  },
  {
    id: 'alt_medicine',
    category: 'forbid',
    label: '替代医疗',
    reason: '不能建议停药或用其他方法代替药物治疗',
    terms: [
      '可以停药',
      '就能停药',
      '直接停药',
      '可以不吃药',
      '不用吃药',
      '不必吃药',
      '无需服药',
      '摆脱药物',
      '代替药物',
      '替代药物',
      '取代药物',
      '代替降压药',
      '代替降糖药',
      '替代降压药',
      '替代降糖药',
    ],
    negatable: true,
  },
  {
    // 规格 2.3 候选里的单字词（最好、第一、唯一、停药、保证、根除等）在正常科普里很常见
    // （“最好在医生指导下”“第一页”“不要擅自停药”“保证睡眠”“根除幽门螺杆菌”），
    // 直接禁止会误拦；短语形式放在上面的禁止类，单字词在这里要健管师核对（合规审查 B2、S2）
    id: 'wording_review',
    category: 'review',
    label: '需要核对的说法',
    reason: '可能是绝对化用语、疗效承诺或停药建议，请核对上下文',
    terms: ['最好', '最佳', '第一', '唯一', '首选', '保证', '根除', '停药', '减药', '代替', '替代'],
    negatable: false,
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

/**
 * 否定说法（合规审查 B1）：只有词前面紧挨着这些说法时才不算命中，例如“不能代替药物”“请勿停药”。
 * 中间最多隔着几个修饰词（能、会、要、随意、擅自……），不跨标点；“不是不”“没有不”“不得不”
 * “不可能不”这类双重否定照样算命中。
 */
const NEGATION_PHRASES = [
  '千万不要',
  '不可以',
  '不一定',
  '不能',
  '不会',
  '不要',
  '不可',
  '不得',
  '不应',
  '不宜',
  '不必',
  '不用',
  '无法',
  '无需',
  '并非',
  '不是',
  '没有',
  '切勿',
  '请勿',
  '未必',
  '不',
  '勿',
  '别',
] as const;
const DOUBLE_NEGATIONS = ['不是不', '没有不', '不得不', '不可能不', '并非不', '不能不'] as const;
const NEGATION_FILLERS = [
  '完全',
  '随意',
  '擅自',
  '自行',
  '随便',
  '轻易',
  '一定',
  '马上',
  '立即',
  '能',
  '会',
  '要',
  '就',
] as const;
const CLAUSE_BREAK = /[，,。！!？?；;：:、（）()【】「」“”"'…—]/;

function negatedBefore(norm: string, i: number): boolean {
  let prefix = norm.slice(Math.max(0, i - 10), i);
  // 不跨标点
  const cut = Math.max(...[...prefix].map((ch, k) => (CLAUSE_BREAK.test(ch) ? k : -1)));
  if (cut >= 0) prefix = prefix.slice(cut + 1);
  for (let guard = 0; guard < 3; guard++) {
    const filler = NEGATION_FILLERS.find((f) => prefix.endsWith(f));
    if (!filler) break;
    // 修饰词本身就是否定说法的一部分时（“不能”的“能”）先看否定说法
    if (NEGATION_PHRASES.some((p) => prefix.endsWith(p))) break;
    prefix = prefix.slice(0, -filler.length);
  }
  if (DOUBLE_NEGATIONS.some((d) => prefix.endsWith(d))) return false;
  return NEGATION_PHRASES.some((p) => prefix.endsWith(p));
}

/**
 * 看不见的格式字符。表情符号里的变体选择符（U+FE0F）和零宽连接符（U+200D）紧跟在表情后面时不算
 * （社群稿常用 ❤️、☀️，合规审查 S1）；换行、回车、制表符不算。
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\u034F\uFE00-\uFE0F]/u;
const EMOJI_JOINERS = /([\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}])[\uFE0F\u200D]+/gu;

function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text.replace(/[\r\n\t]/g, '').replace(EMOJI_JOINERS, '$1'));
}

/**
 * 数字和引用（Q7）：模型可能编造来源，标为“需要人工判断”。
 * 文字类在去掉空白后的规范化文本上匹配（“研 究表明”同样算），数字类在去掉空白的原文上匹配。
 */
const CITATION_TEXT_PATTERNS: readonly RegExp[] = [
  /百分之[零一二三四五六七八九十百\d]+/g,
  /(?:研究|调查|数据|统计|实验|专家)(?:表明|显示|发现|证实|证明|指出|认为)/g,
  /有研究|临床试验|meta分析|世界卫生组织|WHO|据报道|专家共识|指南|《[^》]{1,30}》/gi,
  /[两二三四五六七八九十]+(?:片|粒|袋|勺)/g,
];
const CITATION_NUMBER_PATTERNS: readonly RegExp[] = [
  /\d+(?:\.\d+)?[%％]/g,
  /\d+(?:\.\d+)?(?:毫克|微克|毫升|千卡|大卡|mmol|mmHg|mg|μg|ug|ml|kcal|IU|克|片|粒)/gi,
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
    if (!negatable || !negatedBefore(norm, i)) return true;
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
    if (hasInvisible(text)) {
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
    const compact = text.normalize('NFKC').replace(/\s+/g, '');
    const seen = new Set<string>();
    for (const [pattern, source] of [
      ...CITATION_TEXT_PATTERNS.map((p) => [p, norm] as const),
      ...CITATION_NUMBER_PATTERNS.map((p) => [p, compact] as const),
    ]) {
      for (const m of source.matchAll(pattern)) {
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
