import type { SkillSummary } from '@health-buddy/shared';
import { carePlan } from './care-plan/index.js';
import { clientRecentSummary } from './client-recent-summary/index.js';
import { skillUsesReport, type PlanTemplate, type SkillDefinition } from './framework.js';
import { interviewOutline } from './interview-outline/index.js';
import { reportInterpretation } from './report-interpretation/index.js';
import { twinSummary } from './twin-summary/index.js';
import { visitSchedule } from './visit-schedule/index.js';

/** 技能注册表。新技能在这里登记后，/ 菜单和接口才能看到。 */
// 各技能的输出结构不同，登记时统一成宽类型；取用时按 outputSchema 校验
export const SKILLS: readonly SkillDefinition[] = [
  clientRecentSummary as unknown as SkillDefinition,
  reportInterpretation as unknown as SkillDefinition,
  interviewOutline as unknown as SkillDefinition,
  twinSummary as unknown as SkillDefinition,
  carePlan as unknown as SkillDefinition,
  visitSchedule as unknown as SkillDefinition,
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
    defaultRequest: '请为这位客户做一次新客户完整评估',
  },
  // M4 规格 2.9：孪生复盘 = 读取客户档案 → 读取数字孪生 → /孪生小结；计划不接入专家
  {
    id: 'twin-review',
    skills: [twinSummary.id],
    requiresClient: true,
    requiresReport: false,
    readsTwin: true,
    defaultRequest: '请为这位客户做一次孪生复盘',
  },
];

export function getSkill(id: string): SkillDefinition | undefined {
  return SKILLS.find((s) => s.id === id);
}

export function getPlanTemplate(id: string): PlanTemplate | undefined {
  return PLAN_TEMPLATES.find((p) => p.id === id);
}

/** GET /api/skills 返回的技能概要；多步计划也列在这里，planSkills 不为空、只能用于想一想 */
/**
 * expertsEnabled：专家预览开启时（M3 Q2），接入专家的技能显示 experts = auto；
 * 关闭时一律 none，/体检解读 保持 M2 的行为。
 */
export function skillSummaries(expertsEnabled = false): SkillSummary[] {
  return [
    ...SKILLS.map((s) => ({
      id: s.id,
      requiresClient: s.requiresClient,
      modes: [...s.modes],
      clientFacing: s.clientFacing,
      involvesHealthJudgment: s.involvesHealthJudgment,
      requiresReport: s.requiresReport ?? false,
      usesReport: skillUsesReport(s),
      allowsEmptyRequest: s.defaultRequest !== null,
      planSkills: [],
      experts: expertsEnabled ? (s.experts ?? 'none') : ('none' as const),
      usesMaterials: false,
      // /方案生成 有方案选项条（部分、周期，规格 2.2）
      usesPlanOptions: s.planContext === 'care_plan',
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
        usesReport: p.requiresReport || skills.some(skillUsesReport),
        allowsEmptyRequest: p.defaultRequest !== null,
        planSkills: [...p.skills],
        experts: 'none' as const,
        usesMaterials: false,
        usesPlanOptions: skills.some((s) => s.planContext === 'care_plan'),
      };
    }),
  ];
}
