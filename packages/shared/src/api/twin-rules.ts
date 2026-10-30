import { z } from 'zod';
import { CRITICAL_COMPARATORS, INDICATOR_CODES, type IndicatorCode } from '../health/critical.js';
import {
  TWIN_OBSERVATION_CATEGORIES,
  TWIN_OBSERVATION_POLARITIES,
  twinRuleShapeError,
  type TwinObservationCategory,
  type TwinStatusRuleDef,
} from '../health/twin.js';
import {
  twinDomainSchema,
  twinRuleLevelSchema,
  twinRuleMethodSchema,
  twinRuleSourceSchema,
} from './twin.js';

/**
 * 孪生状态规则（M4 规格 2.10，Q1）：全平台一套，只有平台管理员能改，
 * 协会、机构管理员和健管师只读。默认规则是通用的初步做法，不是医学标准，请由医学顾问审定。
 */

const ruleFields = {
  domain: twinDomainSchema,
  /** 条数规则（observation_count）没有指标 */
  metric: z.enum(INDICATOR_CODES as unknown as [IndicatorCode, ...IndicatorCode[]]).nullable(),
  source: twinRuleSourceSchema,
  method: twinRuleMethodSchema,
  comparator: z.enum(CRITICAL_COMPARATORS).nullable(),
  value: z.number().finite().nullable(),
  unit: z.string().nullable(),
  windowDays: z.number().int().nullable(),
  level: twinRuleLevelSchema,
  /** 只有条数规则有（M6 N16）：统计哪类收集信息、什么极性、至少几条 */
  category: z
    .enum(TWIN_OBSERVATION_CATEGORIES as [TwinObservationCategory])
    .nullable()
    .default(null),
  polarity: z.enum(TWIN_OBSERVATION_POLARITIES).nullable().default(null),
  minCount: z.number().int().nullable().default(null),
};

export const twinStatusRuleSchema = z.object({
  id: z.uuid(),
  ...ruleFields,
  enabled: z.boolean(),
  updatedBy: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
});
export type TwinStatusRuleRecord = z.infer<typeof twinStatusRuleSchema>;

/** 规则形状不对（方面和指标不匹配、阈值缺项、单位不跟目录、超出合理范围）时的错误 */
function shapeRefinement(v: TwinStatusRuleDef, ctx: z.RefinementCtx) {
  const error = twinRuleShapeError(v);
  if (error) ctx.addIssue({ code: 'custom', message: error });
}

export const createTwinStatusRuleRequestSchema = z
  .object({ ...ruleFields, enabled: z.boolean().default(true) })
  .superRefine(shapeRefinement);
export type CreateTwinStatusRuleRequest = z.infer<typeof createTwinStatusRuleRequestSchema>;

/**
 * 修改时方面、指标、来源、判断方式、类别和极性不变（要换就新增一条）；形状由后端合并原规则后再校验
 */
export const updateTwinStatusRuleRequestSchema = z
  .object({
    comparator: ruleFields.comparator.optional(),
    value: ruleFields.value.optional(),
    unit: ruleFields.unit.optional(),
    windowDays: ruleFields.windowDays.optional(),
    level: ruleFields.level.optional(),
    minCount: z.number().int().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to update' });
export type UpdateTwinStatusRuleRequest = z.infer<typeof updateTwinStatusRuleRequestSchema>;

export const twinRulesResponseSchema = z.object({
  /** 规则整体的版本号，每次修改加一 */
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  rules: z.array(twinStatusRuleSchema),
});
export type TwinRulesResponse = z.infer<typeof twinRulesResponseSchema>;

export const twinStatusRuleResponseSchema = z.object({ rule: twinStatusRuleSchema });
export type TwinStatusRuleResponse = z.infer<typeof twinStatusRuleResponseSchema>;
