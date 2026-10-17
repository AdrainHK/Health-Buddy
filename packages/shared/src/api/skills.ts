import { z } from 'zod';

/** 技能概要。名称和说明走 i18n（skills.<id>.name / .description）。 */
export const skillSummarySchema = z.object({
  id: z.string(),
  requiresClient: z.boolean(),
  /** 技能只能在想一想和做一做里用（Q4） */
  modes: z.array(z.enum(['plan', 'craft'])),
  clientFacing: z.boolean(),
  involvesHealthJudgment: z.boolean(),
  /** 需要客户有已核对的报告（/体检解读、/面谈提纲，M2 规格 2.6） */
  requiresReport: z.boolean().default(false),
  /**
   * 不需要再写要求：选了技能和客户（要报告的技能还要引用报告）就能直接发送，
   * 输入框为空时后端用默认的要求文字。
   */
  allowsEmptyRequest: z.boolean().default(false),
  /**
   * 多步计划（Q22）：不为空时这是一份只能在想一想模式下用的计划，
   * 确认后按顺序调用这些技能，每个技能各出一份草稿。
   */
  planSkills: z.array(z.string()).default([]),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillListResponseSchema = z.object({ skills: z.array(skillSummarySchema) });
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;
