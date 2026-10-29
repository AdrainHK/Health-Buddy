/**
 * 会话结束后的后台整理（M6 规格 2.6、2.7、5.1）：一次调用里同时提取记忆、收集信息，写一句会话摘要。
 * 不面向客户；只拿本次会话和已有记忆，不拿档案。病名、药名、健康判断由 isAllowedMemory 再过滤一遍；
 * 收集信息只给健管师看，药名换成“药物”，闲聊里的测量值记成待确认（不直接写监测）。
 */
import {
  normalizeForCompliance,
  CHECKIN_METRICS,
  checkinValuesInRange,
  COMPANION_OBSERVATION_CATEGORIES,
  type CheckinMetric,
  type ObservationCategory,
} from '@health-buddy/shared';
import { z } from 'zod';
import { findDoseMatch, findDrugNames } from '../wording.js';
import { isAllowedMemory } from './checks.js';
import { redactCompanionText, type CompanionTurn } from './prompt.js';

export const COMPANION_MEMORY_PROMPT = `你在整理 AI 伴侣“福宝”和一位老年客户的一次聊天记录，供福宝以后聊天时参考。

1. memories：从这次聊天里找出值得以后记住的事，每条一句话（不超过 40 个字），最多 5 条。只记：客户希望怎么被称呼、喜好（爱吃的、爱好）、家人的称呼和近况、作息习惯、近期的生活事件。已经记得的事不要重复。没有就给空数组。
2. 不记病名、药名、症状、检查结果、测量数值和任何健康判断；不记电话、地址、身份证号。
3. 客户说了想怎么被称呼，写成“客户希望被称呼为……”。
4. summary：用一两句话概括这次聊了什么（不超过 80 个字），同样不写病名、药名和健康判断，也不提吃药、服药、测量数值（这些只记在 observations 里）。
5. observations：给健管师看的收集信息，只记客户（或家人）自己说的事，每条一句话（不超过 60 个字），最多 8 条，没有就给空数组。
   - category 只能是：diet（饮食）、sleep（睡眠）、exercise（运动）、mood（情绪）、adherence（服药依从：只记“客户说漏服了 / 按时吃了”，不记药名和剂量）、body（身体感受）、life（生活事件）、measurement（客户随口说的测量值）。
   - text 用“客户说……”开头，照客户的意思写，不加判断、不下结论。
   - polarity：mood、sleep 类填 negative / neutral / positive，其他类填 null。
   - measurement 类：metric 填 bp（血压）、fpg（空腹血糖）、weight（体重，单位公斤）、steps（步数）、sleep_hours（睡眠小时）之一，values 填数字（血压是高压、低压两个数）；说不清是哪项或没有数就填 null 和空数组。其他类 metric 填 null、values 填空数组。
   - 福宝说的话、打卡时已经确认记下的数不用再记。
6. 只依据聊天记录，不编造。`;

export const companionObservationOutputSchema = z.object({
  category: z.enum(COMPANION_OBSERVATION_CATEGORIES),
  text: z.string().max(200),
  polarity: z.enum(['negative', 'neutral', 'positive']).nullable(),
  metric: z.enum(CHECKIN_METRICS).nullable(),
  values: z.array(z.number()).max(2),
});

export const companionMemoryOutputSchema = z.object({
  memories: z.array(z.string().max(100)).max(5),
  summary: z.string().max(200),
  observations: z.array(companionObservationOutputSchema).max(8),
});
export type CompanionMemoryOutput = z.infer<typeof companionMemoryOutputSchema>;
export const COMPANION_MEMORY_FORMAT = 'companion_memory';

export function buildCompanionMemoryRequest(
  turns: readonly CompanionTurn[],
  existing: readonly string[],
): { system: string; messages: { role: 'user'; content: string }[] } {
  const transcript = turns
    .map((t) => `${t.role === 'client' ? '客户' : '福宝'}：${redactCompanionText(t.text)}`)
    .join('\n');
  const known = existing.length ? existing.map((m) => `- ${m}`).join('\n') : '（还没有）';
  return {
    system: COMPANION_MEMORY_PROMPT,
    messages: [
      { role: 'user', content: `已经记得的事：\n${known}\n\n这次的聊天记录：\n${transcript}` },
    ],
  };
}

/** 过滤后的新记忆（去重、去掉病名药名等）和摘要（不合格时为 null） */
export function acceptCompanionMemory(
  output: Pick<CompanionMemoryOutput, 'memories' | 'summary'>,
  existing: readonly string[],
): { memories: string[]; summary: string | null } {
  const seen = new Set(existing.map((m) => m.trim()));
  const memories: string[] = [];
  for (const m of output.memories) {
    const t = m.trim();
    if (!isAllowedMemory(t) || seen.has(t)) continue;
    seen.add(t);
    memories.push(t);
  }
  const summary = output.summary.trim();
  return {
    memories,
    summary: summary && isAllowedMemory(summary.slice(0, 100)) ? summary.slice(0, 200) : null,
  };
}

export interface AcceptedObservation {
  category: ObservationCategory;
  text: string;
  polarity: 'negative' | 'neutral' | 'positive' | null;
  metric: CheckinMetric | null;
  values: number[];
}

/**
 * 过滤后的收集信息（规格 2.7、5.4 第 4 条）：去掉电话、证件号、地址，药名换成“药物”；
 * polarity 只留给情绪、睡眠类；测量值必须项目明确、个数对、在合理范围内，否则只留文字不当测量。
 */
export function acceptCompanionObservations(
  items: CompanionMemoryOutput['observations'],
): AcceptedObservation[] {
  const out: AcceptedObservation[] = [];
  for (const item of items) {
    let text = redactCompanionText(item.text.trim()).slice(0, 200);
    for (const { term } of findDrugNames(text)) text = text.split(term).join('药物');
    // 原文里的写法和词表不一样（加了空格、繁体字）时替换不掉：仍查得到药名就整条不要（合规审查 S3）
    if (!text || findDrugNames(text).length) continue;
    // 服药情况不记剂量（规格 2.7）：查到剂量就只记“客户说服药有情况”，原话不留（合规审查 S4）
    // 只看服药情况：“一瓶可乐”“两碗饭”这类饮食说法也会被当成剂量（评测发现）
    if (item.category === 'adherence' && findDoseMatch(normalizeForCompliance(text).text)) {
      text = '客户说了服药的情况（含剂量，已省略，请看聊天原文）';
    }
    const polarity = item.category === 'mood' || item.category === 'sleep' ? item.polarity : null;
    const isReading =
      item.category === 'measurement' &&
      item.metric !== null &&
      checkinValuesInRange(item.metric, item.values);
    out.push({
      category: item.category,
      text,
      polarity,
      metric: isReading ? item.metric : null,
      values: isReading ? [...item.values] : [],
    });
  }
  return out;
}
