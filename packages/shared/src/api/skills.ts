import { z } from 'zod';

/** 技能概要。名称和说明走 i18n（skills.<id>.name / .description）。 */
export const skillSummarySchema = z.object({
  id: z.string(),
  requiresClient: z.boolean(),
  /** 技能只能在想一想和做一做里用（Q4） */
  modes: z.array(z.enum(['plan', 'craft'])),
  clientFacing: z.boolean(),
  involvesHealthJudgment: z.boolean(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillListResponseSchema = z.object({ skills: z.array(skillSummarySchema) });
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;
