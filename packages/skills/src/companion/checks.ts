/**
 * 福宝的确定性检查（M6 规格 5.4），不依赖模型：
 * - 调用模型前：危机、急症关键词；用药、症状、诊断、检查结果、看病类问题；“忘掉……”命令（N11）。
 * - 模型回答后、合成前：输出检查（禁用词、判断、药名、承诺等，复用固定话术的检查），加长度和符号。
 */
import type { CompanionHandoffCategory } from '@health-buddy/shared';
import { detectCrisisKeywords, detectEmergencyKeywords } from '../guardrails.js';
import {
  checkCompanionScript,
  COMPANION_REASSURANCE_TERMS,
  findDiseaseTerms,
  findDrugNames,
  LIBRARY_DISEASE_TERMS,
  type CompanionScriptIssue,
} from '../wording.js';

const QUESTION =
  /[吗么呢？?]|多少|能不能|可不可以|可以吗|要不要|该不该|用不用|行不行|怎么办|怎么样|是不是|会不会/;

/** 客户这句话是不是在提问（打卡时问句不当作回答） */
export function isCompanionQuestion(text: string): boolean {
  return QUESTION.test(compact(text));
}

/** 按顺序匹配，先命中的类别优先 */
const MEDICAL_RULES: readonly {
  category: CompanionHandoffCategory;
  pattern: RegExp;
  needsQuestion?: boolean;
  /** 整句符合时不算这一类 */
  unless?: RegExp;
  /** 说到了具体药名并且在提问 */
  drugQuestion?: boolean;
}[] = [
  {
    category: 'diagnosis',
    pattern:
      /是不是得了|会不会是.{0,6}(病|癌|炎)|得了什么病|是什么病|确诊|诊断|是不是.{0,4}(病|癌|炎|糖尿病|高血压|中风)/,
  },
  {
    category: 'medication',
    pattern:
      /停药|减药|加药|换药|药.{0,3}停了|不吃药了|药不吃了|药没了|药快吃完|忘了吃没吃|不记得吃没吃|记不清吃没吃|吃没吃过|药.{0,4}多吃了|药.{0,6}吃多少|吃多少.{0,2}药|几片|几粒|剂量|打几个单位|胰岛素|降压药|降糖药|吃什么药|药.{0,6}(能不能|可不可以|要不要|该不该|副作用|怎么吃|一起吃)/,
  },
  // 问自己今天吃没吃药（打卡情况）不是用药问题，由福宝按今天的打卡回答（第 5 步）。
  // 只放过固定的说法，“饭前能把药吃了吗”“药多吃了吗”这类仍转交（合规审查 B2）
  {
    category: 'medication',
    pattern: /药/,
    needsQuestion: true,
    unless:
      /^(?:福宝[，,]?)?(?:我|咱)?(?:今天|今儿|今早|早上|上午|中午|下午|晚上|睡前){0,2}(?:的)?药(?:今天|早上|中午|晚上|睡前)?(?:吃了没|吃过没|吃了吗|吃过了吗|吃没吃|吃了没有)[吗呢？]*$/,
  },
  // 药名加提问（“二甲双胍饭前吃还是饭后吃”）同样转交
  { category: 'medication', pattern: /^$/, drugQuestion: true },
  {
    category: 'exam',
    pattern: /高不高|低不低|正不正常|算高|算低|超标|指标|化验|检查结果|报告上|参考范围/,
  },
  // 问数值高低（打卡复述时“是不是有点高啊”），没说指标名也转交（合规审查 S2）
  {
    category: 'exam',
    pattern: /太高|太低|有点高|有点低|偏高|偏低|高吗|低吗|高了吗|低了吗|高不|算不算高|算不算低/,
    needsQuestion: true,
  },
  // 没说“高不高”的数值提问：“血压是不是高了”“血糖低了吗”
  {
    category: 'exam',
    pattern: /(?:血压|血糖|心率|心跳|尿酸|血脂|胆固醇|体重).{0,8}(?:高|低|好|稳)/,
    needsQuestion: true,
  },
  {
    category: 'other',
    pattern: /要不要去医院|去哪个医院|挂什么科|看什么科|要不要看医生|用不用去医院|该去医院/,
  },
  // 客户主动要转给健管师（规格 2.4）
  { category: 'other', pattern: /问问(?:我的)?健管师|转告(?:我的)?健管师|告诉(?:我的)?健管师/ },
  {
    category: 'symptom',
    pattern:
      /疼|痛|晕|发麻|手麻|脚麻|腿麻|麻木|咳|喘|发烧|发热|拉肚子|腹泻|心慌|心跳快|胸闷|恶心|吐了|不舒服|难受|肿|出血|便秘|尿频|看不清/,
  },
];

export interface CompanionPreCheck {
  crisis: boolean;
  emergency: boolean;
  /** 用药、症状、诊断类问题：直接转交，不调用模型 */
  medical: CompanionHandoffCategory | null;
  /** 客户要福宝忘掉一件事或全部（N11） */
  forget: { all: boolean; query: string } | null;
}

const FORGET = /(?:忘掉|忘了吧|忘记吧|别记着|别记了|不要记着|不要记了|删掉)/;
const FORGET_ALL =
  /(?:全都|都|所有|全部|一切).{0,6}(?:忘掉|忘了|忘记|别记|删掉)|(?:忘掉|忘了|删掉).{0,4}(?:全部|所有|一切)/;
const FORGET_FILLER =
  /请|你|福宝|帮我|把|给我|我说的|的事情?|这件事|那件事|吧|了|呀|啊|呢|，|。|！|？|\s/g;

/** 去掉空白后的文字 */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

export function preCheckCompanionInput(text: string): CompanionPreCheck {
  const t = compact(text);
  const crisis = detectCrisisKeywords([t]);
  const emergency = detectEmergencyKeywords([t]);
  let forget: CompanionPreCheck['forget'] = null;
  if (FORGET.test(t)) {
    const all = FORGET_ALL.test(t);
    const query = t.replace(FORGET, '').replace(FORGET_FILLER, '');
    forget = { all, query };
  }
  // “忘掉”命令里夹着用药、症状问题时仍要转交（合规复审 B2），所以总是判断
  let medical: CompanionHandoffCategory | null = null;
  for (const rule of MEDICAL_RULES) {
    const hit = rule.drugQuestion
      ? findDrugNames(t).length > 0 && (QUESTION.test(t) || /还是|怎么|什么时候|几点/.test(t))
      : rule.pattern.test(t) && (!rule.needsQuestion || QUESTION.test(t)) && !rule.unless?.test(t);
    if (hit) {
      medical = rule.category;
      break;
    }
  }
  return { crisis, emergency, medical, forget };
}

/** 客户确认“全都忘掉”：话术请客户再说一遍“全都忘掉”，只认这句（N11） */
export function confirmsForgetAll(text: string): boolean {
  return /全都忘|都忘掉|全部忘掉/.test(compact(text));
}

/**
 * 找出和“忘掉……”说的内容相关的记忆：记忆包含整段内容，或至少有两个相同的双字词。
 * 内容为空时（只说了“忘掉”）不匹配任何记忆。
 */
export function matchMemoriesToForget<T extends { text: string }>(
  memories: readonly T[],
  query: string,
): T[] {
  const q = compact(query);
  if (q.length < 2) return [];
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
  return memories.filter((m) => {
    const text = compact(m.text);
    if (text.includes(q)) return true;
    let shared = 0;
    for (const g of grams) if (text.includes(g)) shared++;
    return shared >= Math.min(2, grams.size);
  });
}

/**
 * 念出来的长度（规格 5.3 第 2 条“不超过 3 句、每句不超过 25 字”）：句子按句号、问号、叹号分，
 * 25 字按逗号分开的每一小句算（平台固定话术也是这个标准），整段不超过 90 字
 */
export const COMPANION_MAX_SENTENCES = 3;
export const COMPANION_MAX_CLAUSE_CHARS = 25;
export const COMPANION_MAX_REPLY_CHARS = 90;

export type CompanionReplyIssueCategory =
  CompanionScriptIssue['category'] | 'too_long' | 'symbols' | 'empty';

export interface CompanionReplyIssue {
  category: CompanionReplyIssueCategory;
  term: string;
}

/** 福宝回答里不能出现的数值、健康评价（固定话术检查里的判断用语之外） */
export const COMPANION_VALUE_JUDGMENTS = [
  '超标',
  '达标',
  '有点高',
  '有点低',
  '太高',
  '太低',
  '过高',
  '过低',
  '偏胖',
  '太胖',
  '很健康',
  '挺健康',
  '身体很好',
  '不太好',
  '控制得好',
  '控制得不错',
] as const;
/** 指标后面跟高低好坏：“血压高了”“血糖挺稳” */
const METRIC_JUDGMENT =
  /(?:血压|血糖|心率|心跳|体重|尿酸|血脂|胆固醇|指标|数值|这个数)[^，。！？；]{0,6}(?:高(?!压)|低(?!压)|好|稳|合适|理想|正常)/;
/** 替健管师承诺：主语是健管师（他、她），或承诺“给您打电话、联系您、回复您”（规格 5.3 第 10 条） */
const REPLY_MANAGER_PROMISE =
  /(?:健管师|他|她)(?:会|马上|今天|明天|很快|立刻|一会儿)[^，。！？]{0,6}(?:给您|给你|联系|回复|打电话|来电|上门)|(?:会|马上|很快|立刻|尽快)[^，。！？]{0,3}(?:给您|给你)(?:打电话|回电|回复)|(?:会|马上|很快|尽快)[^，。！？]{0,3}(?:联系您|联系你|回复您|回复你)/;

/** 平时的回答里不能说的安抚（危机后的陪伴用 COMPANION_REASSURANCE_TERMS 全部） */
const NORMAL_REASSURANCE = ['没事', '不要紧', '不严重', '没什么大问题'] as const;

/** 列表、括号、符号、英文缩写（“AI”除外） */
const SYMBOLS =
  /[[\]()（）【】*#•·:：/\\|<>{}=_~^%&@$]|^\s*[-\d]+[.、)]|(?<![A-Za-z])(?!AI\b)[A-Za-z]{2,}/m;

/** 句子：按句号、问号、叹号、分号分开 */
export function companionSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 字数：不算标点和空白 */
function spokenLength(text: string): number {
  return [...text.replace(/[，,、。！？!?；;：:\s“”"'‘’]/g, '')].length;
}

/**
 * 福宝回答的输出检查（规格 5.4 第 2 条）。不通过就丢弃，播放兜底话术并转交，不重试。
 * crisis 为真时（危机、急症后的陪伴）另外查安抚性否认（“没事”“别担心”）。
 */
export function checkCompanionReply(
  reply: string,
  options: { crisis?: boolean } = {},
): CompanionReplyIssue[] {
  if (!reply.trim()) return [{ category: 'empty', term: '' }];
  // 复述“血压高压一百四十五”时“血压高”会被当成病名（评测发现）：项目名和高压、低压之间断开再查
  const text = reply.replace(/血压(?=[高低]压)/g, '血压，');
  // 转交、兜底话术的检查最全：禁用词、病名、判断、药名、剂量、功效、孪生字样、专家、医院、代健管师承诺、占位符
  // 代健管师承诺改用更窄的规则：“马上联系家人”是危机后该说的话，不是替健管师承诺（评测发现）
  const issues: CompanionReplyIssue[] = checkCompanionScript('fallback', text)
    .filter((i) => i.category !== 'manager_promise')
    .map((i) => ({ category: i.category, term: i.term }));
  const promise = REPLY_MANAGER_PROMISE.exec(compact(text));
  if (promise) issues.push({ category: 'manager_promise', term: promise[0] });
  // 数值高低、“健康”“达标”这类评价（合规复审 B3；规格 5.3 第 3 条）
  const norm = compact(text);
  for (const term of COMPANION_VALUE_JUDGMENTS) {
    if (norm.includes(term)) issues.push({ category: 'judgment', term });
  }
  const metric = METRIC_JUDGMENT.exec(norm);
  if (metric) issues.push({ category: 'judgment', term: metric[0] });
  // 不说客户“没事”；危机、急症后的陪伴连“别担心”也不说
  const reassurance = options.crisis ? COMPANION_REASSURANCE_TERMS : NORMAL_REASSURANCE;
  for (const term of reassurance) {
    if (norm.includes(term)) issues.push({ category: 'reassurance', term });
  }
  const sentences = companionSentences(text);
  const clauses = sentences.flatMap((s) => s.split(/[，,、]/));
  if (
    sentences.length > COMPANION_MAX_SENTENCES ||
    clauses.some((c) => spokenLength(c) > COMPANION_MAX_CLAUSE_CHARS) ||
    spokenLength(text) > COMPANION_MAX_REPLY_CHARS
  ) {
    issues.push({ category: 'too_long', term: '' });
  }
  const symbol = SYMBOLS.exec(text);
  if (symbol) issues.push({ category: 'symbols', term: symbol[0] });
  return issues;
}

/**
 * 记忆和摘要里不能有的（规格 2.6、5.4 第 4 条）：病名、药名、“药”字、判断用语、症状、
 * 指标和数值（合规复审 S5）
 */
const MEMORY_FORBIDDEN =
  /药|偏高|偏低|正常|异常|风险|疑似|患有|确诊|诊断|疼|痛|晕|发麻|咳|喘|发烧|不舒服|难受|失眠|血压|血糖|心率|尿酸|血脂|胆固醇|体重|化验|检查/;

export function isAllowedMemory(text: string): boolean {
  const t = text.trim();
  if (!t || [...t].length > 100) return false;
  if (MEMORY_FORBIDDEN.test(compact(t))) return false;
  if (findDiseaseTerms(t).length || findDrugNames(t).length) return false;
  return !LIBRARY_DISEASE_TERMS.some((term) => t.includes(term));
}
