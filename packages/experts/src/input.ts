/**
 * 把后端读好的客户资料组装成专家引擎的输入（M3 规格 3.1、7.2 第 4 条）。
 *
 * 和 M2 4.2 一样只有年龄段、性别和健康数据；健管师问题和健康史里的姓名、电话、证件号、地址
 * 统一用 redactClientIdentity 去掉。组装好的内容有单元测试检查（验收 19）。
 */
import type { ConsultationInput, FlaggedIndicator } from '@health-buddy/ai-engine';
import type { TwinRef } from '@health-buddy/shared';
import {
  checkTwinJudgments,
  describeReportClient,
  describeTwin,
  detectCrisisKeywords,
  detectEmergencyKeywords,
  knownNumbers,
  redactClientIdentity,
  redactTwin,
  TWIN_PROMPT_RULES,
  twinFlaggedIndicators,
  twinFreeTexts,
  type ClientSnapshot,
} from '@health-buddy/skills';

/** 疑似急症关键词：实现在 packages/skills（专家、工作台、伴侣共用） */
export { detectEmergencyKeywords };

/** 输入资料里出现过的全部数值：实现在 packages/skills（/孪生小结 和专家共用） */
export { knownNumbers };

export interface ExpertInputSource {
  /** 没有 @客户 的一般性问题为空 */
  client: ClientSnapshot | null;
  /** 健管师这次的问题（原话，组装时去标识化） */
  question: string;
  /** 要从文字里去掉的客户姓名等字样，只在内存里用 */
  identifiers: readonly string[];
  /** 本任务里健管师之前说过的话，只用来识别危机和急症信号，不进提示词 */
  earlierTexts?: readonly string[];
  /**
   * “请专家看看”（M4 规格 2.6 之二）：针对的孪生项。有值时规则路由只按这些孪生项涉及的指标走，
   * 客户资料里要有孪生资料（client.twin）
   */
  twinRefs?: readonly TwinRef[];
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
        // 孪生里手动调整的理由、跟进备注同样去标识（M4 规格 5.4 第 6 条）
        ...(source.client.twin ? { twin: redactTwin(source.client.twin, redact) } : {}),
      }
    : null;
  const clientPart = client
    ? describeReportClient({ client, managerRequest: '' }, { includeCriteria: false })
    : '## 客户资料\n没有关联客户：这是一个一般性的专业问题，没有客户资料。';
  // 孪生资料（M4 规格 5.2）：规则放在资料前面，资料里的数字都是后端算好的，专家只能引用
  const twinPart = client?.twin ? `\n\n${TWIN_PROMPT_RULES}\n\n${describeTwin(client.twin)}` : '';
  const userContent = `${clientPart}${twinPart}\n\n## 健管师的问题\n${question || '（没有额外的问题，请按你的分析流程给出意见）'}`;

  const twinRefs = source.twinRefs ?? [];
  const flaggedIndicators: FlaggedIndicator[] =
    twinRefs.length && client?.twin
      ? twinFlaggedIndicators(client.twin, twinRefs)
      : (client?.reportDetail?.indicators ?? []).flatMap((i) =>
          i.abnormal === 'high' || i.abnormal === 'low' || i.abnormal === 'no_reference'
            ? [{ code: i.code, direction: i.abnormal }]
            : [],
        );
  // 危机和急症识别用原文（去标识之前）：手动调整理由、跟进备注里写的也算（M4 规格 5.4 第 7 条）
  const signalTexts = [
    source.question,
    ...(source.earlierTexts ?? []),
    ...twinFreeTexts(source.client?.twin),
  ];
  return {
    userContent,
    request: question,
    flaggedIndicators,
    historyCategories: [...new Set((client?.healthHistory ?? []).map((h) => h.category))],
    allowedNumbers: knownNumbers(client, [question]),
    // 有孪生资料时，专家意见同样不能下状态结论、把预测说成确定、说成疾病风险（M4 规格 5.4）
    ...(client?.twin
      ? { extraWordingCheck: (text: string) => checkTwinJudgments(text).length > 0 }
      : {}),
    crisisDetected: detectCrisisKeywords(signalTexts),
    emergencyDetected: detectEmergencyKeywords(signalTexts),
  };
}
