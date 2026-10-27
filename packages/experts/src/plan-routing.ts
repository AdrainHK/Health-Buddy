import type { PlanSection } from '@health-buddy/shared';

/**
 * /方案生成 按方案部分命中专家（M5 规格 2.5）：选了饮食 → 营养专家；选了运动 → 运动康复专家；
 * 选了心理、且健康史、健管师要求或最近的随访记录里有情绪、压力、睡眠相关描述 → 心理专家。
 * 作息部分没有对应的专科专家（睡眠专家在 M9）。确定性规则，不调用模型。
 */
const SECTION_EXPERT: Partial<Record<PlanSection, string>> = {
  diet: 'nutrition',
  exercise: 'exercise-rehab',
  mind: 'mental-health',
};

/** 情绪、压力、睡眠相关描述（心理部分请心理专家的前提） */
const MIND_CUES =
  /情绪|心情|压力|焦虑|紧张|烦躁|低落|郁闷|抑郁|不开心|想哭|孤独|失眠|睡不好|睡不着|入睡|早醒|多梦|睡眠/;

export function planSectionExperts(
  sections: readonly PlanSection[],
  texts: readonly string[],
): { expertId: string; section: PlanSection }[] {
  const mindCue = texts.some((t) => MIND_CUES.test(t.replace(/\s+/g, '')));
  return sections.flatMap((section) => {
    const expertId = SECTION_EXPERT[section];
    if (!expertId || (section === 'mind' && !mindCue)) return [];
    return [{ expertId, section }];
  });
}
