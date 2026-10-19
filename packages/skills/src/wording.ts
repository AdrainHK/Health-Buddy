import { DRUG_NAMES, findBannedTerms, normalizeForCompliance } from '@health-buddy/shared';

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
  // M4 合规审核补充（孪生小结、专家意见里常见的病名）
  '代谢综合征',
  '高脂血症',
  '高胆固醇血症',
  '动脉硬化',
  '动脉粥样硬化',
  '心梗',
  '心肌梗死',
  '心衰',
  '心力衰竭',
  '睡眠呼吸暂停',
] as const;

/**
 * 孪生相关检查另外不许写的病名。“失眠”在面谈提纲里常作为症状来问（“最近有没有失眠”），
 * 不放进 DISEASE_TERMS，免得改变 M2 提纲的检查；孪生小结和孪生问答里不把睡眠时长说成失眠。
 */
export const TWIN_DISEASE_TERMS: readonly string[] = [...DISEASE_TERMS, '失眠'];

/**
 * 具体药名和药物类别：词表在 packages/shared（专家引擎共用）。
 * 提纲任何地方都不能点名；问题里只能问“在用哪些药”
 */
export { DRUG_NAMES };

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
 * 单位后面紧跟 / 或字母的不算（mg/dL、g/L 是检验单位）；“一两天”“一听到”不算；
 * 同一、统一、唯一、单一、第一、某一里的“一”不是数量（“同一单位”不是剂量）。
 * 提纲不问任何东西的数量（规格 2.8，产品确认保持现状）：烟、酒、盐、水、饮料的数量同样算。
 */
export const DOSE =
  /(?:\d+(?:\.\d+)?|\d+\/\d+|[一二两三四五六七八九十]+分之[一二三四五六七八九]|(?<![同统唯单第某])[一二两三四五六七八九十半几]+)\s*(mg|毫克|克|g|ml|毫升|片|粒|颗|支|袋|包|丸|勺|瓶|杯|罐|听(?![到说见过力])|两(?![天年次个周月顿回遍晚位种项分小岁])|块(?![儿吃去走玩做住])|碗|根|服(?!务|装)|副|单位|IU)(?![/A-Za-z])/i;

/** 第一处剂量或数量（在规范化后的文本上找），没有就是 null */
export function findDoseMatch(norm: string): { index: number; text: string } | null {
  const m = DOSE.exec(norm);
  return m ? { index: m.index, text: m[0] } : null;
}

/** 疑似、患有、得了这类判断句式：问题里不能用（skill.md“问题的措辞”） */
export const JUDGMENT_PHRASES = ['疑似', '患有', '患上', '得了', '确诊', '病情', '风险'] as const;

/**
 * 拒绝越界要求时固定写的那句话（skill.md）。检查前整句遮掉，前后标点怎么写（，（）——）都不影响。
 */
export const DRUG_REFUSAL_PHRASES = ['未按要求给出用药建议', '用药调整需由医生评估'] as const;

export type WordingCategory =
  | 'banned_term'
  | 'presumed_disease'
  | 'judgment'
  | 'drug_name'
  | 'drug_advice'
  // M4 /孪生小结（规格 5.3、5.4）
  | 'status_change'
  | 'forecast_certainty'
  | 'disease_risk'
  | 'invented_number';

export interface WordingIssue {
  category: WordingCategory;
  /** 命中的词（禁用词或疾病名称本身，不是客户资料） */
  term: string;
  /** 在被检查文本里的起点（UTF-16 码元） */
  index: number;
}

/** /孪生小结 拒绝越界要求时固定写的话（twin-summary/skill.md），检查前同样遮掉 */
export const TWIN_REFUSAL_PHRASES = [
  '未按要求修改状态',
  '未按要求写疾病或患病概率',
  '未按要求去掉不确定性',
  '未按要求写给客户的内容',
] as const;

/** 规范化，并把固定的拒绝句遮成空格（长度不变，位置仍能映射回原文） */
function normalized(text: string): { text: string; origin: number[] } {
  const n = normalizeForCompliance(text);
  let masked = n.text;
  for (const phrase of [...DRUG_REFUSAL_PHRASES, ...TWIN_REFUSAL_PHRASES]) {
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

// ---------- M4 /孪生小结（规格 5.3、5.4） ----------

/**
 * 状态颜色：后面不能紧跟别的汉字（“红肉”“绿叶菜”“黄豆”不是状态），“红色状态”“黄级”可以。
 */
const TWIN_COLOR =
  '(?:红|黄|绿|灰)(?:色)?(?=[^\\u4e00-\\u9fff]|$|状态|级|档|灯|预警|警示|标识|标记)';
/**
 * 状态结论（Q4：AI 不定状态）：“建议将代谢调整为红”“应改为绿色”“状态应为黄”“下调为黄色”。
 * “由绿变黄”“由黄升为红”是描述后端给出的变化，不算（见 findStatusChange）。
 */
export const STATUS_CHANGE = new RegExp(
  `(?:改为|改成|调整为|调为|调成|上调为|下调为|升为|降为|应为|应该是|应当是|定为|标为|标记为)${SAME_CLAUSE}{0,2}${TWIN_COLOR}|(?:建议|应|应该|需要)${SAME_CLAUSE}{0,10}(?:改|调整|调|上调|下调|标)${SAME_CLAUSE}{0,4}${TWIN_COLOR}`,
);

/** 预测的确定说法（5.3）：不写“将会”“一定会”“必然” */
export const FORECAST_CERTAINTY =
  /(?<![不未])将会|(?<!不)一定会|(?<![不未])必然|(?<!不)肯定会|(?<!不)注定/;

/**
 * 把指标走势说成疾病或患病概率（5.3）：“会得”“会发展成”“患病概率”“风险增加”“发病率”。
 * “不会得”“不能说会得”这类否定和说明不算（前面有“不”“非”“不是”“不能”“不代表”时跳过）。
 */
const DISEASE_RISK =
  /(?<![不非没])(?:会得|会患|会发展成|会发展为|会演变成|发展成为|进展为|进展成|患病概率|患病风险|发病概率|发病风险|发病率|得病|高风险|(?:心血管|心脑血管|代谢|健康)?风险(?:较高|很高|偏高|升高了|高于常人)|风险(?:是|为|约为|约是|达到?)[^，。；,;\n]{0,6}?\d+(?:\.\d+)?\s*倍|(?:概率|可能性)(?:约为|约是|大约是|为|是|达到?|约)\s*\d+(?:\.\d+)?\s*%|(?:风险|概率|可能性)(?:增加|升高|上升|提高)|\d+(?:\.\d+)?\s*%\s*的?(?:风险|概率|可能))/g;
const NEGATION_BEFORE =
  /(?:不能|不应|不得|不会|不代表|不意味着|并不|不是|不说|不写|不做|无法|没法|没办法|未必|不一定)[^，。；\n]{0,8}$/;
/** “不能排除……风险升高”“……除外”是肯定有可能，不算否定 */
const NOT_EXCLUDED = /排除|除外/;

/**
 * 这一处是否在否定或说明里：前面 12 个字以内有否定词，并且同一分句里没有“排除”“除外”
 */
function negatedAt(norm: string, index: number, length: number): boolean {
  const before = norm.slice(Math.max(0, index - 12), index);
  if (!NEGATION_BEFORE.test(before)) return false;
  const clauseStart = Math.max(
    ...['，', '。', '；', '\n', ',', ';'].map((p) => before.lastIndexOf(p)),
  );
  const rest = norm.slice(index + length);
  const clauseEnd = rest.search(/[，。；\n,;]/);
  const clause =
    before.slice(clauseStart + 1) + rest.slice(0, clauseEnd === -1 ? undefined : clauseEnd);
  return !NOT_EXCLUDED.test(clause);
}

function findDiseaseRisk(text: string): WordingIssue[] {
  const { text: norm, origin } = normalized(text);
  const out: WordingIssue[] = [];
  for (const m of norm.matchAll(DISEASE_RISK)) {
    if (negatedAt(norm, m.index, m[0].length)) continue;
    out.push({ category: 'disease_risk', term: '疾病风险', index: origin[m.index] ?? 0 });
  }
  return out;
}

/** 每一处匹配都检查（不只第一处）：前面是否定或说明时跳过这一处，后面的照样检查 */
function findPattern(
  text: string,
  pattern: RegExp,
  category: WordingCategory,
  term: string,
  skip?: (before: string) => boolean,
): WordingIssue[] {
  const { text: norm, origin } = normalized(text);
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  const out: WordingIssue[] = [];
  for (const m of norm.matchAll(global)) {
    const before = norm.slice(Math.max(0, m.index - 12), m.index);
    if (negatedAt(norm, m.index, m[0].length) || skip?.(before)) continue;
    out.push({ category, term, index: origin[m.index] ?? 0 });
  }
  return out;
}

/**
 * 描述已经发生的变化，不是 AI 的结论：
 * - “由黄升为红”“从绿调为黄”（前面没有“可”“应”“建议”这类说法；“可由黄调为红”仍算结论）；
 * - 照抄的手动调整：“健管师手动调整为红”“已调整为绿”。
 */
const DESCRIBED_CHANGE =
  /(?:(?<!可|可以|能|应|应该|应当|宜|建议|需要|需)(?:由|从)(?:红|黄|绿|灰)色?|手动|健管师已?|已)$/;

const TWIN_COUNT =
  '(?:\\d+(?:\\.\\d+)?|\\d+\\/\\d+|(?<![同统唯单第某])[一二两三四五六七八九十半几]+)\\s*';
/**
 * 孪生检查里的剂量：只看药物才用的单位（mg、毫克、胶囊、单位、IU）。
 * “每天喝几杯水”“主食是否超过两碗”“两片面包”“一颗鸡蛋”是饮食，孪生小结（只给健管师）可以写；
 * 片、粒、颗、丸只在同一分句里有“药”或具体药名时才算（TWIN_PILL）。
 */
export const TWIN_DRUG_DOSE = new RegExp(
  `${TWIN_COUNT}(?:mg|毫克|微克|μg|ug|mcg|胶囊|单位|IU)(?![/A-Za-z])`,
  'i',
);
const TWIN_DRUG_WORDS = ['药', ...DRUG_NAMES].join('|');
const TWIN_PILL = new RegExp(
  `(?:${TWIN_DRUG_WORDS})${SAME_CLAUSE}{0,8}?${TWIN_COUNT}(?:片|粒|颗|丸)|${TWIN_COUNT}(?:片|粒|颗|丸)${SAME_CLAUSE}{0,8}?(?:${TWIN_DRUG_WORDS})`,
);
/** 用药建议：动词和“药”、胶囊、剂量或具体药名在同一分句（不含片、粒、颗：“加一颗鸡蛋”是饮食） */
const TWIN_DRUG_TARGETS = ['药', '胶囊', '剂量', ...DRUG_NAMES].join('|');
const TWIN_DRUG_ADVICE = new RegExp(
  `(?:${verbs})${SAME_CLAUSE}{0,8}?(?:${TWIN_DRUG_TARGETS})|(?:${TWIN_DRUG_TARGETS})${SAME_CLAUSE}{0,8}?(?:${verbs})`,
);

function findTwinDrugAdvice(text: string): WordingIssue[] {
  const { text: norm, origin } = normalized(text);
  const out: WordingIssue[] = [];
  const advice = TWIN_DRUG_ADVICE.exec(norm);
  if (advice)
    out.push({ category: 'drug_advice', term: '用药建议', index: origin[advice.index] ?? 0 });
  const dose = TWIN_DRUG_DOSE.exec(norm) ?? TWIN_PILL.exec(norm);
  if (dose) out.push({ category: 'drug_advice', term: '剂量', index: origin[dose.index] ?? 0 });
  return out;
}

/**
 * /孪生小结 模型写的每一段文字（专业版，只给健管师）：禁用词、疾病名称、状态结论、预测的确定说法、
 * 疾病风险说法，以及用药建议和剂量。命中时带纠正说明重试一次，仍不合格不保存草稿。
 */
export function checkTwinWording(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...asIssues('presumed_disease', findTerms(text, TWIN_DISEASE_TERMS)),
    ...findPattern(text, STATUS_CHANGE, 'status_change', '状态结论', (before) =>
      DESCRIBED_CHANGE.test(before),
    ),
    ...findPattern(text, FORECAST_CERTAINTY, 'forecast_certainty', '确定说法'),
    ...findDiseaseRisk(text),
    ...asIssues('drug_name', findDrugNames(text)),
    ...findTwinDrugAdvice(text),
  ];
}

/**
 * 孪生专属的三类（状态结论、预测的确定说法、疾病风险），专家意见的校验也用（M4 规格 5.4）：
 * 专家意见原有的禁用词、药物检查不变。
 */
export function checkTwinJudgments(text: string): WordingIssue[] {
  return [
    ...findPattern(text, STATUS_CHANGE, 'status_change', '状态结论', (before) =>
      DESCRIBED_CHANGE.test(before),
    ),
    ...findPattern(text, FORECAST_CERTAINTY, 'forecast_certainty', '确定说法'),
    ...findDiseaseRisk(text),
  ];
}
