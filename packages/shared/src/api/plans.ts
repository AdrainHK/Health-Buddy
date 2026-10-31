import { z } from 'zod';
import { findBannedTerms } from '../compliance/index.js';

/**
 * 套餐和额度（M7 规格 2.5，Q6）。平台定义套餐（功能开关、每月额度），给协会设可售套餐；
 * 协会在可售范围内给健管师分配。没分配的健管师按“试点版”处理。
 * 额度为 null 表示不另设上限，只受 M1–M6 的技术性上限。
 */

/** 按模块开关的功能：专家中心、数字孪生、方案与随访、AI 健康伴侣 */
export const PLAN_FEATURES = ['experts', 'twin', 'care', 'companion'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** 额度项：前三项按北京时间的自然月计；伴侣设备数是同时绑定的上限 */
export const QUOTA_METRICS = [
  'llm_calls',
  'expert_calls',
  'report_pages',
  'companion_devices',
] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

/** 内置的试点版（Q6 没定之前）：全部功能开、额度不另设上限，不能停售 */
export const PILOT_PLAN_CODE = 'pilot';
export const PLAN_NAME_MAX = 20;
export const QUOTA_MAX = 10_000_000;

export const planCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

export const planFeaturesSchema = z
  .object({ experts: z.boolean(), twin: z.boolean(), care: z.boolean(), companion: z.boolean() })
  .strict();
export type PlanFeatures = z.infer<typeof planFeaturesSchema>;

const quota = z.number().int().min(0).max(QUOTA_MAX).nullable();
export const planQuotasSchema = z
  .object({
    llm_calls: quota,
    expert_calls: quota,
    report_pages: quota,
    companion_devices: quota,
  })
  .strict();
export type PlanQuotas = z.infer<typeof planQuotasSchema>;

const planFields = {
  // 套餐名会出现在协会后台和健管师“我的账号”，不能含禁用词和看不见的格式字符（合规审查 S3）
  name: z
    .string()
    .trim()
    .min(1)
    .max(PLAN_NAME_MAX)
    .refine((v) => !/[\p{Cf}\p{Cc}]/u.test(v) && findBannedTerms(v).length === 0),
  features: planFeaturesSchema,
  monthlyQuotas: planQuotasSchema,
};

export const createPlanRequestSchema = z.object({ ...planFields, code: planCodeSchema }).strict();
export type CreatePlanRequest = z.infer<typeof createPlanRequestSchema>;
/** 修改时代码不变（协会的导入文件里用的是代码） */
export const updatePlanRequestSchema = z.object(planFields).strict();
export type UpdatePlanRequest = z.infer<typeof updatePlanRequestSchema>;

export const planSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  features: planFeaturesSchema,
  monthlyQuotas: planQuotasSchema,
  status: z.enum(['active', 'retired']),
  /** 正在用这个套餐的健管师数（平台查看时；改套餐前二次确认用）。协会查看时为 null */
  assignedCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.iso.datetime(),
});
export type Plan = z.infer<typeof planSchema>;
export const planListResponseSchema = z.object({ plans: z.array(planSchema) });
export type PlanListResponse = z.infer<typeof planListResponseSchema>;
export const planResponseSchema = z.object({ plan: planSchema });
export type PlanResponse = z.infer<typeof planResponseSchema>;

/** 平台设协会的可售套餐 */
export const setOperatorPlansRequestSchema = z
  .object({ planIds: z.array(z.uuid()).max(50) })
  .strict();
export type SetOperatorPlansRequest = z.infer<typeof setOperatorPlansRequestSchema>;
export const operatorPlansResponseSchema = z.object({ planIds: z.array(z.uuid()) });
export type OperatorPlansResponse = z.infer<typeof operatorPlansResponseSchema>;

/** 协会改账号（第 4 步只改套餐；改机构单独设计） */
export const updateAccountRequestSchema = z.object({ planId: z.uuid() }).strict();
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

/** 健管师“我的账号”：套餐、到期日（随协会合同）、本月用量 */
export const myPlanSchema = z.object({
  code: z.string(),
  name: z.string(),
  features: planFeaturesSchema,
  monthlyQuotas: planQuotasSchema,
  contractEnd: z.iso.date().nullable(),
  usage: z.object({
    llm_calls: z.number().int(),
    expert_calls: z.number().int(),
    report_pages: z.number().int(),
    companion_devices: z.number().int(),
  }),
});
export type MyPlan = z.infer<typeof myPlanSchema>;
export const myPlanResponseSchema = z.object({ plan: myPlanSchema });
export type MyPlanResponse = z.infer<typeof myPlanResponseSchema>;
