import { z } from 'zod';
import {
  CRITICAL_COMPARATORS,
  CRITICAL_LEVELS,
  INDICATOR_CODES,
  THRESHOLD_BOUNDS,
  type IndicatorCode,
} from '../health/critical.js';

const ruleFields = {
  metric: z.enum(INDICATOR_CODES as unknown as [IndicatorCode, ...IndicatorCode[]]),
  comparator: z.enum(CRITICAL_COMPARATORS),
  value: z.number().finite(),
  level: z.enum(CRITICAL_LEVELS),
  enabled: z.boolean(),
};

/** 阈值必须落在该指标的合理范围内，挡住明显误填 */
function withinBounds(v: { metric: IndicatorCode; value: number }): boolean {
  const b = THRESHOLD_BOUNDS[v.metric];
  return v.value >= b.min && v.value <= b.max;
}
const boundsError = { message: 'value out of range', path: ['value'] };

export const criticalThresholdSchema = z.object({
  id: z.uuid(),
  ...ruleFields,
  updatedBy: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
});
export type CriticalThreshold = z.infer<typeof criticalThresholdSchema>;

export const createCriticalThresholdRequestSchema = z
  .object(ruleFields)
  .refine(withinBounds, boundsError);
export type CreateCriticalThresholdRequest = z.infer<typeof createCriticalThresholdRequestSchema>;

export const updateCriticalThresholdRequestSchema = z
  .object({
    comparator: ruleFields.comparator.optional(),
    value: ruleFields.value.optional(),
    level: ruleFields.level.optional(),
    enabled: ruleFields.enabled.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to update' });
export type UpdateCriticalThresholdRequest = z.infer<typeof updateCriticalThresholdRequestSchema>;

/** 修改时指标不变，范围校验在后端拿到原指标后用这个函数做 */
export function thresholdValueInBounds(metric: IndicatorCode, value: number): boolean {
  return withinBounds({ metric, value });
}

export const criticalThresholdListResponseSchema = z.object({
  thresholds: z.array(criticalThresholdSchema),
});
export type CriticalThresholdListResponse = z.infer<typeof criticalThresholdListResponseSchema>;
