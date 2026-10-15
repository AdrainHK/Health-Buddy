import type { SkillSummary } from '@health-buddy/shared';
import { clientRecentSummary } from './client-recent-summary/index.js';
import type { SkillDefinition } from './framework.js';

/** 技能注册表。新技能在这里登记后，/ 菜单和接口才能看到。 */
// 各技能的输出结构不同，登记时统一成宽类型；取用时按 outputSchema 校验
export const SKILLS: readonly SkillDefinition[] = [
  clientRecentSummary as unknown as SkillDefinition,
];

export function getSkill(id: string): SkillDefinition | undefined {
  return SKILLS.find((s) => s.id === id);
}

/** GET /api/skills 返回的技能概要 */
export function skillSummaries(): SkillSummary[] {
  return SKILLS.map((s) => ({
    id: s.id,
    requiresClient: s.requiresClient,
    modes: [...s.modes],
    clientFacing: s.clientFacing,
    involvesHealthJudgment: s.involvesHealthJudgment,
  }));
}
