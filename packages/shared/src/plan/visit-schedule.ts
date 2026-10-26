import { z } from 'zod';
import { addMonthsIso } from '../health/twin.js';
import {
  addDaysIso,
  dateInTimeZone,
  daysBetweenIso,
  isWeekend,
  shiftWeekendToMonday,
} from './dates.js';

/**
 * 随访日期的计算（M5 规格 2.7、第五节之二，Q17）：纯函数，不调用模型。
 * 日期是服务规则，确定性、可测试；AI 只为每次随访写方式建议和重点，不能改日期。
 * 默认频次是通用的初步做法，不是医学或服务标准，待产品负责人和医学顾问审定。
 */

export const VISIT_METHODS = ['phone', 'wechat', 'in_person', 'video'] as const;
export const visitMethodSchema = z.enum(VISIT_METHODS);
export type VisitMethod = z.infer<typeof visitMethodSchema>;

/** 常规随访、方案复评、跟进项回访、临时加的随访 */
export const VISIT_PURPOSES = ['routine', 'plan_review', 'follow_up', 'adhoc'] as const;
export const visitPurposeSchema = z.enum(VISIT_PURPOSES);
export type VisitPurpose = z.infer<typeof visitPurposeSchema>;

/** 风险分层（none = 未分层） */
export const VISIT_RISK_TIERS = ['high', 'medium', 'low', 'none'] as const;
export const visitRiskTierSchema = z.enum(VISIT_RISK_TIERS);
export type VisitRiskTier = z.infer<typeof visitRiskTierSchema>;

export const VISIT_INTERVAL_MIN = 7;
export const VISIT_INTERVAL_MAX = 180;
export const FIRST_VISIT_WITHIN_MIN = 1;
export const FIRST_VISIT_WITHIN_MAX = 14;
/** 和方案复评相隔不到 7 天的常规随访合并为一次 */
export const PLAN_REVIEW_MERGE_DAYS = 7;
/** 没有生效方案时排未来 12 周 */
export const NO_PLAN_HORIZON_WEEKS = 12;
/** 随访日期不能超过 6 个月后（2.7 第 5 条） */
export const VISIT_MAX_AHEAD_MONTHS = 6;

export const visitTierRuleSchema = z.object({
  intervalDays: z.number().int().min(VISIT_INTERVAL_MIN).max(VISIT_INTERVAL_MAX),
  defaultMethod: visitMethodSchema,
});
export type VisitTierRule = z.infer<typeof visitTierRuleSchema>;

/** 全平台唯一一套随访频次规则（Q18） */
export const visitFrequencyRulesSchema = z.object({
  tiers: z.object({
    high: visitTierRuleSchema,
    medium: visitTierRuleSchema,
    low: visitTierRuleSchema,
    none: visitTierRuleSchema,
  }),
  /** 有 1、2 级未处理跟进项时，第一次随访不晚于几天后 */
  firstVisitWithinDays: z.number().int().min(FIRST_VISIT_WITHIN_MIN).max(FIRST_VISIT_WITHIN_MAX),
});
export type VisitFrequencyRules = z.infer<typeof visitFrequencyRulesSchema>;

/** 默认频次（第五节之二，候选，待审定） */
export const DEFAULT_VISIT_FREQUENCY_RULES: VisitFrequencyRules = {
  tiers: {
    high: { intervalDays: 14, defaultMethod: 'phone' },
    medium: { intervalDays: 30, defaultMethod: 'phone' },
    low: { intervalDays: 90, defaultMethod: 'wechat' },
    none: { intervalDays: 30, defaultMethod: 'phone' },
  },
  firstVisitWithinDays: 3,
};

export interface ScheduleVisitsInput {
  /** 计算时刻；“今天”按健管师时区算 */
  now: Date;
  timeZone: string;
  /** 客户当前的风险分层；未分层为 null */
  riskTier: 'high' | 'medium' | 'low' | null;
  rules: VisitFrequencyRules;
  /**
   * 生效方案（或同一次计划刚生成的方案草稿）的复评日期（周期结束那天）。没有方案为 null。
   * 复评日期早于今天时按没有方案处理。
   */
  planReviewDate: string | null;
  /** 有没有 1、2 级未处理的跟进项 */
  hasUrgentFollowUp: boolean;
}

export interface ScheduledVisit {
  dueDate: string;
  purpose: Exclude<VisitPurpose, 'adhoc'>;
  method: VisitMethod;
}

export interface ScheduleVisitsResult {
  /** 按健管师时区的今天 */
  today: string;
  tier: VisitRiskTier;
  intervalDays: number;
  /** 排到哪一天为止（复评日期，或 12 周后） */
  horizonEnd: string;
  /** 按日期升序，同一天只有一次 */
  visits: ScheduledVisit[];
}

/** 跟进项回访：(今天, 今天 + n] 里最晚的工作日；没有工作日时顺延到下一个周一 */
function urgentDate(today: string, withinDays: number): string {
  for (let d = withinDays; d >= 1; d -= 1) {
    const date = addDaysIso(today, d);
    if (!isWeekend(date)) return date;
  }
  return shiftWeekendToMonday(addDaysIso(today, 1));
}

/**
 * 按客户风险分层和平台的随访频次规则算出随访日期（第五节之二）：
 * - 间隔按分层取；第一次随访在今天 + 间隔；有 1、2 级未处理跟进项时第一次改为不晚于 n 天后的跟进项回访，
 *   之后按间隔从这一天往后排；
 * - 有方案时排到复评日期为止，复评日期那天是“方案复评”，和它相隔不到 7 天的常规随访合并进去；
 *   没有方案时排 12 周；排不出任何一次时至少保留第一次（如低风险 90 天间隔），但不超过 6 个月；
 * - 周六、周日顺延到周一（顺延后的日期不再参与间隔计算，避免越推越晚）。
 */
export function scheduleVisits(input: ScheduleVisitsInput): ScheduleVisitsResult {
  const rules = visitFrequencyRulesSchema.parse(input.rules);
  const today = dateInTimeZone(input.now, input.timeZone);
  const tier: VisitRiskTier = input.riskTier ?? 'none';
  const { intervalDays, defaultMethod } = rules.tiers[tier];
  const maxDate = addMonthsIso(today, VISIT_MAX_AHEAD_MONTHS);
  const review =
    input.planReviewDate !== null && daysBetweenIso(today, input.planReviewDate) >= 0
      ? input.planReviewDate
      : null;
  const horizonEnd = review ?? addDaysIso(today, NO_PLAN_HORIZON_WEEKS * 7);

  const visits: ScheduledVisit[] = [];
  let base: string;
  if (input.hasUrgentFollowUp) {
    base = urgentDate(today, rules.firstVisitWithinDays);
    visits.push({ dueDate: base, purpose: 'follow_up', method: defaultMethod });
  } else {
    base = today;
  }
  for (let k = 1; ; k += 1) {
    const raw = addDaysIso(base, intervalDays * k);
    if (daysBetweenIso(raw, horizonEnd) < 0) break;
    visits.push({ dueDate: shiftWeekendToMonday(raw), purpose: 'routine', method: defaultMethod });
  }

  let out = visits;
  if (review !== null) {
    const reviewDue = shiftWeekendToMonday(review);
    out = out.filter(
      (v) =>
        v.purpose !== 'routine' ||
        Math.abs(daysBetweenIso(v.dueDate, reviewDue)) >= PLAN_REVIEW_MERGE_DAYS,
    );
    out = out.filter((v) => v.dueDate !== reviewDue);
    out.push({ dueDate: reviewDue, purpose: 'plan_review', method: defaultMethod });
  }
  if (out.length === 0) {
    out.push({
      dueDate: shiftWeekendToMonday(addDaysIso(today, intervalDays)),
      purpose: 'routine',
      method: defaultMethod,
    });
  }

  const seen = new Set<string>();
  const visitsOut = out
    .filter((v) => daysBetweenIso(v.dueDate, maxDate) >= 0 && daysBetweenIso(today, v.dueDate) >= 0)
    .sort((a, b) => daysBetweenIso(b.dueDate, a.dueDate))
    .filter((v) => (seen.has(v.dueDate) ? false : (seen.add(v.dueDate), true)));
  return { today, tier, intervalDays, horizonEnd, visits: visitsOut };
}
