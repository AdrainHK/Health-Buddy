/**
 * 把后端读好的客户资料组装成专家引擎的输入（M3 规格 3.1、7.2 第 4 条）。
 *
 * 和 M2 4.2 一样只有年龄段、性别和健康数据；健管师问题和健康史里的姓名、电话、证件号、地址
 * 统一用 redactClientIdentity 去掉。组装好的内容有单元测试检查（验收 19）。
 */
import type { ConsultationInput, FlaggedIndicator } from '@health-buddy/ai-engine';
import {
  describeReportClient,
  detectCrisisKeywords,
  redactClientIdentity,
  type ClientSnapshot,
} from '@health-buddy/skills';

/** 疑似急症关键词：不依赖模型，模型拒答时也能提示健管师 */
const EMERGENCY_KEYWORDS =
  /胸痛|胸闷.{0,6}(?:出汗|喘|晕)|晕厥|昏厥|晕倒|昏迷|意识不清|意识模糊|叫不醒|呼吸困难|喘不上气|口角歪斜|说话不清|口齿不清|言语不清|一侧肢体(?:无力|麻木)|半边身子(?:无力|麻|不能动)|单侧肢体(?:无力|麻木)|抽搐|剧烈头痛|头痛欲裂|大汗淋漓|冒冷汗|出冷汗|大汗|低血糖昏迷|呕血|吐血|黑便|便血不止/;

export function detectEmergencyKeywords(texts: readonly string[]): boolean {
  return texts.some((t) => EMERGENCY_KEYWORDS.test(t.replace(/\s+/g, '')));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 输入资料里出现过的全部数值：报告数值、报告上印的参考范围、之前的数值、监测读数、危急指标数值和阈值、
 * 年龄段两端，以及同一指标两次数值的差（“比上次上升 0.6”），还有健管师问题里写的数字。
 */
export function knownNumbers(
  client: ClientSnapshot | null,
  texts: readonly string[] = [],
): number[] {
  const nums = new Set<number>();
  const pairDiffs = (values: number[]) => {
    for (const a of values) for (const b of values) if (a > b) nums.add(round1(a - b));
  };
  for (const t of texts) for (const n of t.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
  if (client) {
    for (const n of client.ageBand?.match(/\d+/g) ?? []) nums.add(Number(n));
    for (const m of client.monitoring) {
      for (const r of m.readings) nums.add(r.value);
      pairDiffs(m.readings.map((r) => r.value));
    }
    for (const i of client.latestReport?.indicators ?? []) {
      nums.add(i.value);
      if (i.refLow !== undefined) nums.add(i.refLow);
      if (i.refHigh !== undefined) nums.add(i.refHigh);
    }
    for (const i of client.reportDetail?.indicators ?? []) {
      const values = [...(i.value !== null ? [i.value] : []), ...i.previous.map((p) => p.value)];
      for (const v of values) nums.add(v);
      pairDiffs(values);
      if (i.refLow !== null) nums.add(i.refLow);
      if (i.refHigh !== null) nums.add(i.refHigh);
      for (const n of i.refText?.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
      for (const n of i.textValue?.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
    }
    for (const f of client.criticalFlags) {
      nums.add(f.value);
      nums.add(f.rule.value);
    }
  }
  return [...nums];
}

export interface ExpertInputSource {
  /** 没有 @客户 的一般性问题为空 */
  client: ClientSnapshot | null;
  /** 健管师这次的问题（原话，组装时去标识化） */
  question: string;
  /** 要从文字里去掉的客户姓名等字样，只在内存里用 */
  identifiers: readonly string[];
  /** 本任务里健管师之前说过的话，只用来识别危机和急症信号，不进提示词 */
  earlierTexts?: readonly string[];
}

/** 组装引擎输入。返回的 userContent 已去标识，可以直接发给模型 */
export function buildConsultationInput(source: ExpertInputSource): ConsultationInput {
  const redact = (t: string) => redactClientIdentity(t, source.identifiers);
  const question = redact(source.question);
  const client: ClientSnapshot | null = source.client
    ? {
        ...source.client,
        ...(source.client.healthHistory
          ? {
              healthHistory: source.client.healthHistory.map((h) => ({
                ...h,
                content: redact(h.content),
              })),
            }
          : {}),
      }
    : null;
  const clientPart = client
    ? describeReportClient({ client, managerRequest: '' }, { includeCriteria: false })
    : '## 客户资料\n没有关联客户：这是一个一般性的专业问题，没有客户资料。';
  const userContent = `${clientPart}\n\n## 健管师的问题\n${question || '（没有额外的问题，请按你的分析流程给出意见）'}`;

  const flaggedIndicators: FlaggedIndicator[] = (client?.reportDetail?.indicators ?? []).flatMap(
    (i) =>
      i.abnormal === 'high' || i.abnormal === 'low' || i.abnormal === 'no_reference'
        ? [{ code: i.code, direction: i.abnormal }]
        : [],
  );
  const signalTexts = [source.question, ...(source.earlierTexts ?? [])];
  return {
    userContent,
    request: question,
    flaggedIndicators,
    historyCategories: [...new Set((client?.healthHistory ?? []).map((h) => h.category))],
    allowedNumbers: knownNumbers(client, [
      question,
      ...(client?.healthHistory ?? []).map((h) => h.content),
    ]),
    crisisDetected: detectCrisisKeywords(signalTexts),
    emergencyDetected: detectEmergencyKeywords(signalTexts),
  };
}
