import { z } from 'zod';

/** 技能概要。名称和说明走 i18n（skills.<id>.name / .description）。 */
export const skillSummarySchema = z.object({
  id: z.string(),
  requiresClient: z.boolean(),
  /** 技能只能在想一想和做一做里用（Q4） */
  modes: z.array(z.enum(['plan', 'craft'])),
  clientFacing: z.boolean(),
  involvesHealthJudgment: z.boolean(),
  /** 需要客户有已核对的报告（/体检解读，M2 规格 2.6）；没有时不生成 */
  requiresReport: z.boolean().default(false),
  /**
   * 技能会读取报告，可以 @ 报告（/体检解读、/面谈提纲）。requiresReport 为 false 时报告可选：
   * 不选就用最近一份已核对报告，客户没有已核对报告时按档案生成（/面谈提纲，验收反馈）。
   */
  usesReport: z.boolean().default(false),
  /**
   * 不需要再写要求：选了技能和客户（必须要报告的技能还要引用报告）就能直接发送，
   * 输入框为空时后端用默认的要求文字。
   */
  allowsEmptyRequest: z.boolean().default(false),
  /**
   * 多步计划（Q22）：不为空时这是一份只能在想一想模式下用的计划，
   * 确认后按顺序调用这些技能，每个技能各出一份草稿。
   */
  planSkills: z.array(z.string()).default([]),
  /**
   * 是否接入专家（M3 规格 2.4、Q7）：none 不调用专家（带 @专家 时后端返回 400）；
   * auto 执行时自动选择专家。M3 只有 /体检解读 是 auto，且只在专家预览开启时生效。
   */
  experts: z.enum(['none', 'auto']).default('none'),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillListResponseSchema = z.object({ skills: z.array(skillSummarySchema) });
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;
