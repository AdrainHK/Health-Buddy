import { findBannedTerms, normalizeForCompliance } from '@health-buddy/shared';

/**
 * 面向客户说出口的话（面谈提纲的问题）的确定性措辞检查（M2 规格 2.8）。
 * 后端保存前检查，评测的规则检查用同一份词表，两边不会不一致。
 * 结果只有类别和位置，不带原文以外的内容；日志里只记类别。
 */

/** 疾病名称：问题里出现就算预设客户患病（了解家族情况也不点名疾病） */
export const DISEASE_TERMS = [
  '高血压',
  '低血压',
  '糖尿病',
  '高血脂',
  '血脂异常',
  '高尿酸血症',
  '痛风',
  '脂肪肝',
  '冠心病',
  '心脏病',
  '中风',
  '脑卒中',
  '肥胖症',
  '低血糖症',
  '抑郁',
  '焦虑症',
  '肿瘤',
  '癌',
  '甲亢',
  '甲减',
  '肾病',
  '哮喘',
  '骨质疏松',
  '贫血',
] as const;

/**
 * 具体药名和药物类别（和 interview-outline/skill.md 列出的一致）。
 * 提纲任何地方都不能点名；问题里只能问“在用哪些药”
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
  '非布司他',
  '别嘌醇',
] as const;

/** 同一个分句里的字（规范化后全角标点已变成半角，两种都排除） */
const SAME_CLAUSE = '[^，。；：！？,.;:!?\\n]';

/**
 * 用药建议的动词。故意宽：只要这些动词和“药”、剂型、剂量或具体药名出现在同一个分句里就算。
 * “建议少吃甜食”“把白米饭换成杂粮饭”这类饮食建议没有药，不算。
 */
const ADVICE_VERBS = [
  '换',
  '停',
  '减',
  '加',
  '改',
  '别吃',
  '不吃',
  '暂停',
  '减半',
  '加倍',
  '吃点',
  '可以吃',
  '建议吃',
  '可以用',
  '建议用',
  '服用',
  '继续吃',
  // 让他（头疼时）吃布洛芬：让和吃之间最多隔 4 个字
  `让${SAME_CLAUSE}{0,4}?吃`,
];
/** “片”不含常见食物（薯片、面包片、燕麦片） */
const ADVICE_TARGETS = ['药', '(?<!薯|面包|燕麦)片', '粒', '颗', '胶囊', '剂量', ...DRUG_NAMES];
const verbs = ADVICE_VERBS.join('|');
const targets = ADVICE_TARGETS.join('|');

/** 动词在前（建议换药、停掉降压药）或药在前（把药减半、降压药先别吃了），同一分句内相距不超过 8 个字 */
export const DRUG_ADVICE = new RegExp(
  `(?:${verbs})${SAME_CLAUSE}{0,8}?(?:${targets})|(?:${targets})${SAME_CLAUSE}{0,8}?(?:${verbs})`,
);

/**
 * 剂量或数量：阿拉伯数字、中文数字或分数加单位（5 mg、一片、半粒、1/2 片、两袋、10 ml、几杯、二两）。
 * 单位后面紧跟 / 或字母的不算（mg/dL、g/L 是检验单位）；“一两天”“一听到”不算。
 * 生活方式的数量（几支烟、几两白酒、几勺盐、几杯水）可以问，见 isLifestyleQuantity。
 */
export const DOSE =
  /(?:\d+(?:\.\d+)?|\d+\/\d+|[一二两三四五六七八九十]+分之[一二三四五六七八九]|[一二两三四五六七八九十半几]+)\s*(mg|毫克|克|g|ml|毫升|片|粒|颗|支|袋|包|丸|勺|瓶|杯|罐|听(?![到说见过力])|两(?![天年次个周月顿回遍晚位种项分小岁])|单位|IU)(?![/A-Za-z])/i;

/**
 * 可以问数量的生活方式（规格 2.8 产品决定）：只认这张名单里的整个词，而且数的必须就是它。
 * 名单外的东西（三七粉、止咳糖浆、藿香正气水、人参酒、降糖茶）一律按剂量算。
 */
const LIFESTYLE_NOUNS = [
  '香烟',
  '烟',
  '白酒',
  '啤酒',
  '红酒',
  '黄酒',
  '酒',
  '食用油',
  '油',
  '食盐',
  '盐',
  '白糖',
  '糖',
  '白开水',
  '开水',
  '水',
  '咖啡',
  '浓茶',
  '绿茶',
  '红茶',
  '茶',
  '含糖饮料',
  '饮料',
  '奶茶',
  '果汁',
  '牛奶',
  '酸奶',
  '豆浆',
  '可乐',
  '汽水',
  '苏打水',
  '汤',
].join('|');
/** 数量和饮品之间可以有的修饰：几杯含糖饮料、几杯冰可乐、几杯全脂牛奶 */
const DRINK_MODIFIER = '(?:含糖|无糖|低糖|全脂|脱脂|低脂|甜|冰|热)?';
/** 名单里的词后面再接这些字就成了别的东西（糖浆、酒精、盐水针……），不算 */
const NOT_A_WORD_END = '(?!浆|精|粉|膏|丸|片|剂|药|胶囊|颗粒|针)';
/** 单位后面紧跟名单里的词：几支烟、几两白酒、几瓶啤酒、几勺盐、几杯水 */
const COUNTED_AFTER = new RegExp(`^${DRINK_MODIFIER}(?:${LIFESTYLE_NOUNS})${NOT_A_WORD_END}`);
/** “支”只用来数烟 */
const CIGARETTES_AFTER = new RegExp(`^(?:香烟|烟)${NOT_A_WORD_END}`);
/** 名单里的词是分句的话题，紧接着是问量的说法：白酒每次喝几两、盐每天放几勺 */
const TOPIC_BEFORE = new RegExp(
  `(?:^|您|平时|平常|另外|其中)(?:${LIFESTYLE_NOUNS})(?:每天|每次|一次|一天|每周|一周|平时|平常|大概|大约|一般|通常|会|喝|抽|吃|放|用|加)*$`,
);
/**
 * 话题在句首、隔了一个分句再问量：“酒多久喝一次，每天大概喝几杯”“饮料平时喝得多吗，每天大概喝几杯”。
 * 句首（可带“您”“平时”）是名单里的词；问量的分句里只剩下面这些问频次、问量的字。
 */
const SENTENCE_TOPIC = new RegExp(
  `^(?:您|平时|平常|另外|其中|那)?${DRINK_MODIFIER}(?:${LIFESTYLE_NOUNS})${NOT_A_WORD_END}`,
);
const QUANTITY_FILLER =
  /每天|每次|一次|一天|每周|一周|平时|平常|大概|大约|一般|通常|多久|多长时间|会|喝|抽|放|加|得|多|吗|不|您/g;
const ASKS_AMOUNT = /喝|抽|放|加/;
const AFTER_FILLER = /^(?:左右|上下|吗|呢|呀|啊|吧)*$/;
/** 同一分句里出现这些就一律不放过：药、保健品、药材和剂型 */
const DRUG_OR_SUPPLEMENT = new RegExp(
  [
    '药',
    '保健',
    '补充剂',
    '营养',
    '维生素',
    '钙',
    '鱼油',
    '叶酸',
    '蛋白粉',
    '益生菌',
    '胶囊',
    '冲剂',
    '颗粒',
    '口服液',
    '针',
    '贴',
    '中药',
    '药材',
    '三七',
    '人参',
    '阿胶',
    '灵芝',
    '褪黑素',
    '糖浆',
    '正气水',
    '补液盐',
    '泡腾',
    '维C',
    'VC',
    '(?<!奶|面)粉',
    '(?<!薯|面包|燕麦)片',
    '粒',
    '丸',
    ...DRUG_NAMES,
  ].join('|'),
  'i',
);
/** 这些单位只用于药和保健品，任何时候都算剂量 */
const DRUG_ONLY_UNITS = /^(?:mg|毫克|片|粒|丸|单位|IU)$/i;

/**
 * 这一处数量是不是在问生活方式：数的就是名单里的东西（紧跟在单位后面，或者是前面的话题），
 * 单位不是药专用的（“支”只数烟），同一分句里也没有药、保健品、药材或剂型。
 * 话题在句首、隔了分句再问量的，整句都不能有药、保健品、药材或剂型。
 */
function isLifestyleQuantity(norm: string, start: number, end: number, unit: string): boolean {
  const from = boundary(norm, start, CLAUSE_MARK, -1);
  const to = boundary(norm, end, CLAUSE_MARK, 1);
  const before = norm.slice(from, start);
  const after = norm.slice(end, to);
  if (DRUG_ONLY_UNITS.test(unit) || DRUG_OR_SUPPLEMENT.test(norm.slice(from, to))) return false;
  if (unit === '支') return CIGARETTES_AFTER.test(after);
  if (COUNTED_AFTER.test(after) || TOPIC_BEFORE.test(before)) return true;
  // 话题在句首：问量的分句里除了问频次、问量的字没有别的东西，后面也没有再接东西
  const sFrom = boundary(norm, start, SENTENCE_MARK, -1);
  const sentence = norm.slice(sFrom, boundary(norm, end, SENTENCE_MARK, 1));
  const topic = SENTENCE_TOPIC.exec(sentence);
  if (!topic || DRUG_OR_SUPPLEMENT.test(sentence) || !AFTER_FILLER.test(after)) return false;
  const head = from === sFrom ? before.slice(topic[0].length) : before;
  return ASKS_AMOUNT.test(head) && head.replace(QUANTITY_FILLER, '') === '';
}

const CLAUSE_MARK = /[，。；：！？,.;:!?\n]/;
const SENTENCE_MARK = /[。；;\n]/;

/** 从 i 往前（step = -1）或往后（step = 1）找到 marks 为止的位置 */
function boundary(text: string, i: number, marks: RegExp, step: -1 | 1): number {
  let k = i;
  if (step < 0) while (k > 0 && !marks.test(text[k - 1]!)) k--;
  else while (k < text.length && !marks.test(text[k]!)) k++;
  return k;
}

/** 第一处不是生活方式数量的剂量（在规范化后的文本上找），没有就是 null */
export function findDoseMatch(norm: string): { index: number; text: string } | null {
  for (const m of norm.matchAll(new RegExp(DOSE.source, 'gi'))) {
    if (!isLifestyleQuantity(norm, m.index, m.index + m[0].length, m[1]!))
      return { index: m.index, text: m[0] };
  }
  return null;
}

/** 疑似、患有、得了这类判断句式：问题里不能用（skill.md“问题的措辞”） */
export const JUDGMENT_PHRASES = ['疑似', '患有', '患上', '得了', '确诊', '病情', '风险'] as const;

/**
 * 拒绝越界要求时固定写的那句话（skill.md）。检查前整句遮掉，前后标点怎么写（，（）——）都不影响。
 */
export const DRUG_REFUSAL_PHRASES = ['未按要求给出用药建议', '用药调整需由医生评估'] as const;

export type WordingCategory =
  'banned_term' | 'presumed_disease' | 'judgment' | 'drug_name' | 'drug_advice';

export interface WordingIssue {
  category: WordingCategory;
  /** 命中的词（禁用词或疾病名称本身，不是客户资料） */
  term: string;
  /** 在被检查文本里的起点（UTF-16 码元） */
  index: number;
}

/** 规范化，并把固定的拒绝句遮成空格（长度不变，位置仍能映射回原文） */
function normalized(text: string): { text: string; origin: number[] } {
  const n = normalizeForCompliance(text);
  let masked = n.text;
  for (const phrase of DRUG_REFUSAL_PHRASES) {
    const p = normalizeForCompliance(phrase).text;
    masked = masked.split(p).join(' '.repeat(p.length));
  }
  return { text: masked, origin: n.origin };
}

function findTerms(text: string, terms: readonly string[]): { term: string; index: number }[] {
  const { text: norm, origin } = normalized(text);
  const out: { term: string; index: number }[] = [];
  for (const term of terms) {
    for (let i = norm.indexOf(term); i !== -1; i = norm.indexOf(term, i + 1)) {
      out.push({ term, index: origin[i] ?? 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 找出疾病名称。先规范化（去空格、零宽字符，统一全角半角和繁简），位置按原文 */
export function findDiseaseTerms(text: string): { term: string; index: number }[] {
  return findTerms(text, DISEASE_TERMS);
}

/** 找出具体药名（先规范化），位置按原文 */
export function findDrugNames(text: string): { term: string; index: number }[] {
  return findTerms(text, DRUG_NAMES);
}

/**
 * 用药建议或剂量（规格 2.8：提纲不给用药建议）。在规范化、遮掉固定拒绝句后的文本上匹配；
 * term 只写“用药建议”“剂量”这类类别名，不带原文。
 */
export function findDrugAdvice(text: string): WordingIssue[] {
  const { text: norm, origin } = normalized(text);
  const out: WordingIssue[] = [];
  const advice = DRUG_ADVICE.exec(norm);
  if (advice)
    out.push({ category: 'drug_advice', term: '用药建议', index: origin[advice.index] ?? 0 });
  out.push(...findDose(norm, origin));
  return out;
}

function findDose(norm: string, origin: number[]): WordingIssue[] {
  const dose = findDoseMatch(norm);
  return dose ? [{ category: 'drug_advice', term: '剂量', index: origin[dose.index] ?? 0 }] : [];
}

const asIssues = (category: WordingCategory, found: { term: string; index: number }[]) =>
  found.map((f) => ({ category, ...f }));

/**
 * 要对客户说出口的问题：禁用词、疾病名称、判断句式、具体药名、用药建议和剂量。
 * 只能问“目前在用哪些药和保健品？”“有没有医生开的长期用药？”这类情况；
 * 问停没停过药、换没换过药同样算（skill.md 禁止）。
 */
export function checkSpokenWording(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...asIssues('presumed_disease', findDiseaseTerms(text)),
    ...asIssues('judgment', findTerms(text, JUDGMENT_PHRASES)),
    ...checkAdviceWording(text),
  ];
}

/** “为什么问”：写给健管师看，但同样不写禁用词、疾病名称、判断说法，不点名药物、不给用药建议 */
export function checkWhyWording(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...asIssues('presumed_disease', findDiseaseTerms(text)),
    ...asIssues('judgment', findTerms(text, JUDGMENT_PHRASES)),
    ...checkAdviceWording(text),
  ];
}

/** 提纲其他部分（重点、缺少的信息、跟进建议）：不点名药物、不给用药建议、不写剂量 */
export function checkAdviceWording(text: string): WordingIssue[] {
  return [...asIssues('drug_name', findDrugNames(text)), ...findDrugAdvice(text)];
}

/** 只要类别（去重），用于重新生成时的提示和日志 */
export function wordingCategories(issues: readonly WordingIssue[]): WordingCategory[] {
  return [...new Set(issues.map((i) => i.category))];
}
