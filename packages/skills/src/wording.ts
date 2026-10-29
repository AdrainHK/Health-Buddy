import {
  COMPANION_SCRIPT_PLACEHOLDERS,
  DRUG_NAMES,
  findBannedTerms,
  normalizeForCompliance,
  type CompanionScriptKind,
} from '@health-buddy/shared';

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
  | 'invented_number'
  // M5 方案库条目（规格 2.4、4.2）
  | 'efficacy_claim'
  // M5 方案通俗版（规格 2.3）：孪生状态颜色和预测、风险分层字样
  | 'twin_term'
  | 'risk_tier';

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
 * 改状态的动词后面的颜色：只排除后面紧跟食物字的（“改为绿叶菜”“调成红枣茶”），
 * “改为红色更合适”“状态应为红才对”照样算
 */
const CHANGED_COLOR =
  '(?:红|黄|绿|灰)(?!肉|叶|菜|豆|枣|茶|瓜|薯|糖|酒|椒|米|萝卜|油|色(?:食|蔬|水果))';
/**
 * 状态结论（Q4：AI 不定状态）：“建议将代谢调整为红”“应改为绿色”“状态应为黄”“下调为黄色”。
 * “由绿变黄”“由黄升为红”是描述后端给出的变化，不算（见 findStatusChange）。
 * 括号里的“需要留意”“需要尽快关注”是状态名称（“黄（需要留意）手动调整为绿”），不当作“需要……改为”；
 * “心血管需要留意并把它调红”仍算。第二种说法的情态词和改动词之间放宽到整个分句。
 * “建议列为红色”“我认为应判为黄”“心血管换成红色更合适”也算；“由黄变成红”是描述（见 DESCRIBED_CHANGE）。
 */
export const STATUS_CHANGE = new RegExp(
  `(?:改为|改成|调整为|调为|调成|上调为|下调为|升为|降为|升级为|应为|应该是|应当是|定为|标为|标记为|列为|设为|设置为|判为|归为|划为|评为|换成|变成)${SAME_CLAUSE}{0,2}${CHANGED_COLOR}|(?:建议|(?<![对相反适供响])应|应该|(?<![（(])需要|可以(?!看到|看出)|最好|本该)${SAME_CLAUSE}*?(?:改|调整|调|上调|下调|标)${SAME_CLAUSE}{0,4}${CHANGED_COLOR}`,
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
/** 一般的否定词：和被否定的说法之间最多隔 8 个字 */
const NEGATION_WORDS =
  /(?:不能|不应|不得|不会|不代表|不意味着|并不|不是|不说|不写|不做|不表示|不等于|无法|没法|没办法|未必|不一定)(?=[^，。；,;\n]*$)/g;
/**
 * “不能”“不会”后面是做到某件事（“不能坚持运动”“不会控制体重”“不能把盐减下来”“不能管好饮食”）时是条件，
 * 不是否定：“不能坚持运动患病风险较高”仍算
 */
const NEGATION_CONDITIONAL =
  /^(?:坚持|控制|管住|管好|把握|做到|按时|规律|保持|养成|戒|减|降|改)|下来|到位|好/;
/**
 * “不将”“不把”只在后面跟“说成”“写成”“视为”这类描述动词时才是否定（“不把这次波动说成患病风险升高”）；
 * “不把体重降下来患病风险较高”“不将饮食调整到位患病风险增加”是条件，仍算
 */
const NEGATION_DESCRIBING = /(?:不将|不把)(?=[^，。；,;\n]*$)/g;
const DESCRIBE_VERB =
  /(?:说成|写成|说为|视为|看作|看成|当作|当成|解释为|解释成|归为|作为)[^，。；,;\n]{0,4}$/;
/**
 * 否定的对象就是风险、概率、数据或结论本身（“没有这项患病概率数据”“不提供应改为绿色的结论”
 * “没有可用于评估患病概率的数据”）：和被否定的说法之间最多隔 4 个字
 */
const NEGATION_OF_OBJECT = /(?:不提供|不给出|没有(?:这项|此项|该项?|可用于))(?=[^，。；,;\n]*$)/g;
/** “不能据此判断……”“无法据此给出……”这类说明：否定词后面是这些字时，最多隔 14 个字 */
const NEGATION_EXPLAINING = /^(?:据此|仅凭|单凭|凭此|只凭)/;
/**
 * 否定词和被查的说法之间有这些字时，否定管不到后面（“并不只是血压的问题而是心血管风险较高”
 * “不会控制饮食的话三个月后血糖将会继续升高”“在不提供任何干预的情况下患病概率约为 30%”）
 */
const NEGATION_BREAK = /而|但|却|其实|就是|反而|的话|时|情况下/;
/**
 * 否定词往前看的字数。规范化后全角逗号、分号已变成半角，两种都算分句边界
 * （“不能只看一次，后续必然升高”不算否定）
 */
const NEGATION_LOOKBACK = 18;

/** 紧挨在这一处前面的文字（同一分句内）是否有管得到它的否定词 */
function negationReaches(before: string): boolean {
  const reaches = (re: RegExp, maxGap: (gap: string, word: string) => number) =>
    [...before.matchAll(re)].some((m) => {
      const gap = before.slice(m.index + m[0].length);
      return gap.length <= maxGap(gap, m[0]) && !NEGATION_BREAK.test(gap);
    });
  return (
    reaches(NEGATION_WORDS, (gap, word) => {
      if ((word === '不能' || word === '不会') && NEGATION_CONDITIONAL.test(gap)) return -1;
      return NEGATION_EXPLAINING.test(gap) ? 14 : 8;
    }) ||
    reaches(NEGATION_DESCRIBING, (gap) => (DESCRIBE_VERB.test(gap) ? 12 : -1)) ||
    reaches(NEGATION_OF_OBJECT, () => 4)
  );
}
/** “不能排除……风险升高”“……除外”是肯定有可能，不算否定 */
const NOT_EXCLUDED = /排除|除外/;

/**
 * 这一处是否在否定或说明里：前面 18 个字以内有否定词，并且同一分句里没有“排除”“除外”
 */
function negatedAt(norm: string, index: number, length: number): boolean {
  const before = norm.slice(Math.max(0, index - NEGATION_LOOKBACK), index);
  if (!negationReaches(before)) return false;
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
  skip?: (before: string, norm: string, index: number, match: string) => boolean,
): WordingIssue[] {
  const { text: norm, origin } = normalized(text);
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  const out: WordingIssue[] = [];
  for (const m of norm.matchAll(global)) {
    const before = norm.slice(Math.max(0, m.index - 12), m.index);
    if (negatedAt(norm, m.index, m[0].length) || skip?.(before, norm, m.index, m[0])) continue;
    out.push({ category, term, index: origin[m.index] ?? 0 });
  }
  return out;
}

/**
 * 描述已经发生的变化，不是 AI 的结论：
 * - “由黄升为红”“从绿调为黄”“由系统计算的黄调整为绿”（前面没有“可”“应”“建议”这类说法；“可由黄调为红”仍算结论）；
 * - 照抄的手动调整：“健管师手动调整为红”“已调整为绿”。
 */
const DESCRIBED_CHANGE =
  /(?:(?:由|从)(?:[^，。；,;\n]{0,8}?的)?(?:红|黄|绿|灰)色?|手动|健管师已?|已)$/;

/**
 * 同一分句里这一处前面有这些说法时就是 AI 在下结论，不算描述
 * （“我建议将代谢方面目前的状态由系统计算的黄调整为绿”“应当把心血管从平台计算的黄改为红”）。
 * 括号里的“需要留意”是状态名称，不算。
 */
const STATUS_JUDGING =
  /建议|应该|应当|(?<![对相反适供响])应|可以|(?<!不)可(?!能)|宜|(?<![（(])需|最好|本该|判断|认为|觉得|更合理|(?<![获取记觉值显懂晓])得(?!到)/;
/**
 * 这些说法里的“可”“得”不是判断（“可以看到代谢由黄升为红”“可见……”“获得新的读数后……”“记得……”），
 * 查 STATUS_JUDGING 前先去掉
 */
const NOT_JUDGING = /可以看到|可以看出|可见|获得|得到|记得/g;

/**
 * 复述系统给的颜色：只认“系统/平台/规则”（可带“已”“自动”）后面紧跟“标为”“标记为”“定为”
 * （“系统标记为绿（平稳）”“平台已标为黄”），分句里不能有别的判断说法。
 * “按规则……，因此标为红”“孪生资料看本该标为红”都算结论：写颜色用“当前为黄”“状态为黄”。
 */
const LABEL_VERB = /^(?:标为|标记为|定为)/;
const LABEL_BY_SYSTEM = /(?:系统|平台|规则)(?:已|自动)?$/;

function clauseBefore(norm: string, index: number): string {
  const before = norm.slice(0, index);
  return before.slice(
    Math.max(
      ...['，', '。', '；', '\n', ',', ';', '!', '?', '！', '？'].map((p) => before.lastIndexOf(p)),
    ) + 1,
  );
}

/** 状态结论这一处是否其实是描述（已发生的变化、照抄的手动调整、复述系统给的颜色） */
function describedStatus(before: string, norm: string, index: number, match: string): boolean {
  const clause = clauseBefore(norm, index);
  if (STATUS_JUDGING.test(clause.replace(NOT_JUDGING, ''))) return false;
  if (DESCRIBED_CHANGE.test(before)) return true;
  return LABEL_VERB.test(match) && LABEL_BY_SYSTEM.test(clause);
}

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

// ---------- M5 /随访记录、/随访话术给健管师看的部分 ----------

/** 建议的说法：AI 自己给的建议（“建议继续服用”“最好减半”），不是客户说的 */
const SUGGESTION = '建议|应该|应当|最好|不妨|推荐';
const QUOTED_DRUG_ADVICE = new RegExp(
  `(?:${SUGGESTION})${SAME_CLAUSE}{0,10}?(?:${TWIN_DRUG_TARGETS})|(?:${TWIN_DRUG_TARGETS})${SAME_CLAUSE}{0,10}?(?:${SUGGESTION})`,
);

/**
 * 随访记录、随访话术的汇总和“为什么问”（M5 规格 2.8、2.9，只给健管师）：禁用词、判断说法、
 * 疾病名称、药名、用药建议和药物剂量。“半碗杂粮饭”“每次二两”是客户说的饮食，不算剂量。
 * quoted 是照抄客户说的事实：disease 允许病名（既往史、家族史），drug 允许药名和
 * “自行减少了”这类描述（用药情况、用药史），但仍不能有 AI 自己给的用药建议。
 */
export function checkRecordWording(
  text: string,
  quoted: { disease?: boolean; drug?: boolean } = {},
): WordingIssue[] {
  const issues: WordingIssue[] = [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...asIssues('judgment', findTerms(text, JUDGMENT_PHRASES)),
  ];
  if (!quoted.disease) issues.push(...asIssues('presumed_disease', findDiseaseTerms(text)));
  if (quoted.drug) {
    const { text: norm, origin } = normalized(text);
    const advice = QUOTED_DRUG_ADVICE.exec(norm);
    if (advice) {
      issues.push({ category: 'drug_advice', term: '用药建议', index: origin[advice.index] ?? 0 });
    }
  } else {
    issues.push(...asIssues('drug_name', findDrugNames(text)), ...findTwinDrugAdvice(text));
  }
  return issues;
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
    ...findPattern(text, STATUS_CHANGE, 'status_change', '状态结论', describedStatus),
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
    ...findPattern(text, STATUS_CHANGE, 'status_change', '状态结论', describedStatus),
    ...findPattern(text, FORECAST_CERTAINTY, 'forecast_certainty', '确定说法'),
    ...findDiseaseRisk(text),
  ];
}

// ---------- M5 方案库条目（规格 2.4、4.2） ----------

/**
 * 功效承诺：库条目只描述食物和动作本身，不写和疾病、指标挂钩的效果（“降血糖”“护肝”），
 * 也不写“保证”“见效”这类承诺。方案生成器的通俗版检查以后同样用这份词表。
 */
export const EFFICACY_TERMS = [
  '降血糖',
  '降血压',
  '降血脂',
  '降尿酸',
  '降压',
  '降糖',
  '降脂',
  '控糖',
  '控血糖',
  '稳血糖',
  '调血脂',
  '治好',
  '治疗',
  '疗效',
  '功效',
  '药效',
  '食疗',
  '排毒',
  '抗癌',
  '防癌',
  '抗衰',
  '减肥',
  '瘦身',
  '燃脂',
  '刮油',
  '逆转',
  '根除',
  '保证',
  '见效',
  '消炎',
  '补血',
  '养肝',
  '护肝',
  '清血管',
  '软化血管',
  '增强免疫',
  '提高免疫',
  '降胆固醇',
  '稳糖',
  '控压',
  '助眠',
  '安神',
  '改善睡眠',
  '降火',
  '去火',
  '清热',
  '祛湿',
  '养胃',
  '健脾',
  '补肾',
  '护心',
  '通血管',
  '抗氧化',
  '抗炎',
  '减脂',
  '燃烧脂肪',
  '提高抵抗力',
  '延缓衰老',
  '立竿见影',
] as const;

/** 和指标挂钩的效果说法：“降低血糖”“控制血压”“改善血脂”（词表列不全的组合） */
export const EFFICACY_PATTERN =
  /(?:降低|降|控制|调节|稳定|平稳|改善|调理|调|稳)(?:血糖|血压|血脂|胆固醇|尿酸)/;

/**
 * 方案库条目里另外不许写的人群和疾病说法（“适合三高人群”“缓解焦虑”）。只用于库条目和以后的方案通俗版，
 * 不放进 DISEASE_TERMS：面谈提纲会问“最近有没有失眠、焦虑”这类情况。
 */
export const LIBRARY_DISEASE_TERMS: readonly string[] = [
  ...DISEASE_TERMS,
  '三高',
  '高血糖',
  '血糖高',
  '血压高',
  '血脂高',
  '肥胖',
  '焦虑',
  '失眠',
  '关节炎',
  '颈椎病',
  '腰椎间盘',
];

/**
 * 方案库条目里面向客户的文字（名称、食材、做法、动作要点、目标模板文字，规格 4.2）：
 * 禁用词、疾病名称、具体药名和功效承诺。不查剂量：食谱的家庭常用量（“一碗”“两片”）是正常内容。
 */
export function checkLibraryText(text: string): WordingIssue[] {
  const issues = [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...asIssues('presumed_disease', findTerms(text, LIBRARY_DISEASE_TERMS)),
    ...asIssues('drug_name', findDrugNames(text)),
    ...asIssues('efficacy_claim', findTerms(text, EFFICACY_TERMS)),
    ...findEfficacyPattern(text),
  ];
  // 词表和句式在同一处都命中（“降血糖”）时只报一次
  const seen = new Set<string>();
  return issues
    .sort((a, b) => a.index - b.index || b.term.length - a.term.length)
    .filter((i) => {
      const key = `${i.category}@${i.index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 不看否定词：库条目里“不能降低血糖”这类说法同样不该出现 */
function findEfficacyPattern(text: string): WordingIssue[] {
  const { text: norm, origin } = normalized(text);
  return [...norm.matchAll(new RegExp(EFFICACY_PATTERN.source, 'g'))].map((m) => ({
    category: 'efficacy_claim' as const,
    term: m[0],
    index: origin[m.index] ?? 0,
  }));
}

// ---------- M5 方案通俗版（规格 2.3、5.3、5.4） ----------

/**
 * 方案通俗版里不能出现的孪生字样（规格 2.3：出现就不能确认）：预测、状态颜色的说法、“红灯”“黄灯”。
 * 状态名称（“需要留意”等）只给健管师看；“需要留意盐的用量”这类日常说法很常见，只拦带颜色的写法。
 */
export const CLIENT_TWIN_TERMS = ['孪生', '预测', '红灯', '黄灯', '需要尽快关注'] as const;

/** “状态是黄”“状态显示为红”“当前为黄”“黄（需要留意）”：状态加颜色、或颜色加括号里的状态名称 */
const CLIENT_TWIN_PATTERNS = [
  new RegExp(
    `(?:状态|当前)${SAME_CLAUSE}{0,5}?(?:红|黄|绿|灰)(?!肉|叶|菜|豆|枣|茶|瓜|薯|糖|酒|椒|米|萝卜|油)`,
    'g',
  ),
  /(?:红|黄|绿|灰)色?[(（](?:需要|平稳|暂无)/g,
];

export function findClientTwinTerms(text: string): { term: string; index: number }[] {
  const { text: norm, origin } = normalized(text);
  const out = findTerms(text, CLIENT_TWIN_TERMS);
  for (const re of CLIENT_TWIN_PATTERNS) {
    for (const m of norm.matchAll(re)) out.push({ term: '状态颜色', index: origin[m.index] ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 通俗版里点名专家（“营养专家”“专家建议”）：专家意见原文和专家名称都不进通俗版 */
export function findExpertMentions(
  text: string,
  expertNames: readonly string[],
): { term: string; index: number }[] {
  return findTerms(text, [...new Set([...expertNames, '专家'])]);
}

/**
 * 保健品、膳食补充剂和代餐（规格 5.3：方案不推荐）。“可以吃点钙片”不再靠“片”字识别，靠这份词表。
 */
export const SUPPLEMENT_TERMS = [
  '保健品',
  '膳食补充剂',
  '营养补充剂',
  '代餐',
  '钙片',
  '维生素片',
  '复合维生素',
  '鱼油',
  '蛋白粉',
  '益生菌',
  '酵素',
] as const;

/** 规格允许的固定说法（“用药调整由医生评估”），检查用药建议前遮掉 */
const CLIENT_DRUG_ALLOWED = [
  '用药调整由医生评估',
  '用药调整需由医生评估',
  '请向开药医生确认',
  '如在服用药物',
  '如正在服用药物',
];

/**
 * 通俗版的用药建议：动词和“药”、胶囊、剂量或具体药名在同一分句。不把片、粒、颗当作药
 * （“加姜片”“一颗鸡蛋”是做法），“山药”“芍药”里的药也不算。
 */
const CLIENT_DRUG_TARGETS = ['(?<![山芍])药', '胶囊', '剂量', ...DRUG_NAMES].join('|');
const CLIENT_DRUG_ADVICE = new RegExp(
  `(?:${verbs})${SAME_CLAUSE}{0,8}?(?:${CLIENT_DRUG_TARGETS})|(?:${CLIENT_DRUG_TARGETS})${SAME_CLAUSE}{0,8}?(?:${verbs})`,
);

/** 方案通俗版的药物检查：具体药名、用药建议、保健品。只给类别和位置 */
export function findClientDrugIssues(text: string): WordingIssue[] {
  const { text: norm0, origin } = normalized(text);
  let norm = norm0;
  for (const phrase of CLIENT_DRUG_ALLOWED) {
    const p = normalizeForCompliance(phrase).text;
    norm = norm.split(p).join(' '.repeat(p.length));
  }
  const out: WordingIssue[] = asIssues('drug_name', findDrugNames(text));
  const advice = CLIENT_DRUG_ADVICE.exec(norm);
  if (advice) {
    out.push({ category: 'drug_advice', term: '用药建议', index: origin[advice.index] ?? 0 });
  }
  out.push(...asIssues('drug_advice', findTerms(text, SUPPLEMENT_TERMS)));
  return out.sort((a, b) => a.index - b.index);
}

/** “保证睡眠时间”“保证饮水”这类生活安排不是功效承诺：方案的功效检查前遮掉这里的“保证” */
/** 中间夹着指标的（“保证血糖规律”“保证血压充足”）照样算承诺 */
const ROUTINE_ASSURE =
  /保证(?![^，。；,.;]{0,4}(?:血糖|血压|血脂|尿酸|体重|指标))(?=[^，。；,.;]{0,4}(?:睡眠|休息|饮水|喝水|水分|充足|规律|作息|早餐|三餐|蔬菜|蛋白))/g;
const maskRoutineAssure = (text: string) => text.replace(ROUTINE_ASSURE, '　　');

/**
 * 方案通俗版的每一段文字（规格 2.3、5.3）：禁用词、疾病和人群说法、“风险”“患有”这类判断、药物和保健品、
 * 孪生状态颜色和预测、功效承诺。生成时命中就带纠正说明重试一次（确认时后端再查一遍）。
 * 风险分层字样由调用方另查（guardrails 的 findRiskTierMentions）。
 */
export function checkPlanClientText(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...asIssues('presumed_disease', findTerms(text, LIBRARY_DISEASE_TERMS)),
    ...asIssues('judgment', findTerms(text, JUDGMENT_PHRASES)),
    ...findClientDrugIssues(text),
    ...asIssues('twin_term', findClientTwinTerms(text)),
    ...asIssues('efficacy_claim', findTerms(maskRoutineAssure(text), EFFICACY_TERMS)),
    ...findEfficacyPattern(text),
  ];
}

/**
 * 专业版里“治疗”是正常的转介说法（“转介医生评估治疗”），不算功效承诺；
 * “治好”“疗效”等仍然拦
 */
const PROFESSIONAL_EFFICACY_TERMS = EFFICACY_TERMS.filter((t) => t !== '治疗');

/** 方案专业版（只给健管师）：禁用词、具体药名和用药建议、功效承诺 */
export function checkPlanProfessionalText(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...checkAdviceWording(text),
    ...asIssues('efficacy_claim', findTerms(maskRoutineAssure(text), PROFESSIONAL_EFFICACY_TERMS)),
    ...findEfficacyPattern(text),
  ];
}

// ---------- M6 伴侣固定话术（规格 2.2–2.5、2.10、5.3、5.4） ----------

/** 话术里不能出现的数值评价（福宝不评价高低，规格 5.3 第 3 条） */
export const COMPANION_JUDGMENT_TERMS = [
  ...JUDGMENT_PHRASES,
  '偏高',
  '偏低',
  '正常',
  '异常',
] as const;
/** 危机、急症、危急指标话术里不能有安抚性否认（规格 2.5） */
export const COMPANION_REASSURANCE_TERMS = [
  '没事',
  '不要紧',
  '别担心',
  '不严重',
  '不用担心',
  '没关系',
] as const;
/** 不能代健管师承诺（规格 5.3 第 10 条） */
export const COMPANION_MANAGER_PROMISE =
  /(?:健管师|他|她)?(?:会|马上|今天|很快|立刻)(?:给您|给你|联系|回复|打电话|来电)/;
/** 推荐具体医院（规格 5.3 第 5 条） */
const HOSPITAL_RECOMMENDATION = /(?:去|到)[^，。；,.;]{0,8}(?:医院|诊所)(?:看|就诊|挂号)/;

export type CompanionScriptIssueCategory =
  | WordingCategory
  | 'reassurance'
  | 'manager_promise'
  | 'hospital'
  | 'expert'
  | 'missing_required'
  | 'placeholder';

export interface CompanionScriptIssue {
  category: CompanionScriptIssueCategory;
  term: string;
  index: number;
}

/** 必须保留的内容（规格 Q22、N9）：删掉就不能保存 */
const COMPANION_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  crisis: ['120', '家人'],
  emergency: ['120'],
  intro: ['不是医生'],
  daily_intro: ['不是医生'],
  // 告知书至少要说清“不是医生”和怎么撤回（合规复审）；其余要点由法务审定
  notice: ['不是医生', '撤回'],
};

const SAFETY_KINDS = new Set(['crisis', 'emergency', 'critical_value']);
const PROMISE_KINDS = new Set(['handoff', 'fallback', 'critical_value', 'handoff_reply_intro']);

/**
 * 平台保存伴侣固定话术时的检查（合规复审 B1、B2）。固定话术不经模型、不经审核，念给所有客户听，
 * 检查不比福宝回答的输出检查松：禁用词、疾病名称、判断和数值评价、药名和用药建议、剂量、功效承诺、
 * 孪生字样、专家、医院推荐；按种类再查安抚性否认、代健管师承诺、必须保留的内容和占位符。
 * 告知书模板（notice）是打印的长文，只查禁用词和必须写明的要点。
 */
export function checkCompanionScript(kind: string, text: string): CompanionScriptIssue[] {
  const banned = findBannedTerms(text).map((b) => ({
    category: 'banned_term' as const,
    term: b.term,
    index: b.index,
  }));
  if (kind === 'notice') return [...banned, ...missingRequired(kind, text)];
  const { text: norm } = normalized(text);
  const issues: CompanionScriptIssue[] = [
    ...banned,
    ...asIssues('presumed_disease', findTerms(text, LIBRARY_DISEASE_TERMS)),
    ...asIssues('judgment', findTerms(text, COMPANION_JUDGMENT_TERMS)),
    ...findClientDrugIssues(text),
    ...asIssues('twin_term', findClientTwinTerms(text)),
    ...asIssues('efficacy_claim', findTerms(text, EFFICACY_TERMS)),
    ...findEfficacyPattern(text),
  ];
  for (const found of findTerms(text, ['专家'])) issues.push({ category: 'expert', ...found });
  const dose = findDoseMatch(norm);
  if (dose) issues.push({ category: 'drug_advice', term: dose.text, index: dose.index });
  const hospital = HOSPITAL_RECOMMENDATION.exec(norm);
  if (hospital) issues.push({ category: 'hospital', term: hospital[0], index: hospital.index });
  if (SAFETY_KINDS.has(kind)) {
    for (const found of findTerms(text, COMPANION_REASSURANCE_TERMS)) {
      issues.push({ category: 'reassurance', ...found });
    }
  }
  if (PROMISE_KINDS.has(kind)) {
    const promise = COMPANION_MANAGER_PROMISE.exec(norm);
    if (promise)
      issues.push({ category: 'manager_promise', term: promise[0], index: promise.index });
  }
  issues.push(...missingRequired(kind, text));
  const placeholders = [...text.matchAll(/\{[^}]*\}|[{}]/g)];
  const placeholder = COMPANION_SCRIPT_PLACEHOLDERS[kind as CompanionScriptKind];
  const expected = placeholder ? [placeholder] : [];
  if (placeholders.map((m) => m[0]).join() !== expected.join()) {
    issues.push({
      category: 'placeholder',
      term: placeholders.map((m) => m[0]).join('') || (placeholder ?? ''),
      index: placeholders[0]?.index ?? 0,
    });
  }
  return issues.sort((a, b) => a.index - b.index);
}

function missingRequired(kind: string, text: string): CompanionScriptIssue[] {
  return (COMPANION_REQUIRED[kind] ?? [])
    .filter((required) => !text.includes(required))
    .map((required) => ({ category: 'missing_required' as const, term: required, index: 0 }));
}
