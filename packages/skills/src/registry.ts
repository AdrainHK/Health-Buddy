import type { SkillSummary } from '@health-buddy/shared';
import { clientRecentSummary } from './client-recent-summary/index.js';
import type { PlanTemplate, SkillDefinition } from './framework.js';
import { interviewOutline } from './interview-outline/index.js';
import { reportInterpretation } from './report-interpretation/index.js';

/** 技能注册表。新技能在这里登记后，/ 菜单和接口才能看到。 */
// 各技能的输出结构不同，登记时统一成宽类型；取用时按 outputSchema 校验
export const SKILLS: readonly SkillDefinition[] = [
  clientRecentSummary as unknown as SkillDefinition,
  reportInterpretation as unknown as SkillDefinition,
  interviewOutline as unknown as SkillDefinition,
];

/**
 * 多步计划（M2 规格 2.9、Q22）。只能在想一想模式下用：先出计划，健管师确认后按顺序
 * 调用这些技能，每个技能各出一份草稿。
 */
export const PLAN_TEMPLATES: readonly PlanTemplate[] = [
  {
    id: 'new-client-assessment',
    skills: [reportInterpretation.id, interviewOutline.id],
    requiresClient: true,
    requiresReport: true,
  },
];

export function getSkill(id: string): SkillDefinition | undefined {
  return SKILLS.find((s) => s.id === id);
}

export function getPlanTemplate(id: string): PlanTemplate | undefined {
  return PLAN_TEMPLATES.find((p) => p.id === id);
}

/** GET /api/skills 返回的技能概要；多步计划也列在这里，planSkills 不为空、只能用于想一想 */
export function skillSummaries(): SkillSummary[] {
  return [
    ...SKILLS.map((s) => ({
      id: s.id,
      requiresClient: s.requiresClient,
      modes: [...s.modes],
      clientFacing: s.clientFacing,
      involvesHealthJudgment: s.involvesHealthJudgment,
      requiresReport: s.requiresReport ?? false,
      planSkills: [],
    })),
    ...PLAN_TEMPLATES.map((p) => {
      const skills = p.skills.map((id) => getSkill(id)).filter((s) => s !== undefined);
      return {
        id: p.id,
        requiresClient: p.requiresClient,
        modes: ['plan' as const],
        clientFacing: skills.some((s) => s.clientFacing),
        involvesHealthJudgment: skills.some((s) => s.involvesHealthJudgment),
        requiresReport: p.requiresReport,
        planSkills: [...p.skills],
      };
    }),
  ];
}
