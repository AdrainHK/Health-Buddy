import { addDaysIso, dateInTimeZone, daysBetweenIso } from './dates.js';
import type { GoalMetric } from './library.js';

/**
 * 方案执行情况（M5 规格 2.6、Q10）：纯函数，后端确定性计算，不调用模型。
 * 只对照关联了监测指标的目标（步数、睡眠时长），算近 7 天、近 14 天的平均值和达到目标的天数。
 * 只显示：不生成跟进项，不改孪生状态，不进通俗版。
 */

export const ADHERENCE_WINDOWS = [7, 14] as const;

export interface AdherenceGoal {
  /** 调用方用来对应目标的键（如目标模板 id） */
  key: string;
  metric: GoalMetric;
  /** 目标值：每天步数、每晚睡眠小时数；当天数值 ≥ 目标值算达标 */
  target: number;
}

export interface AdherenceReading {
  metric: string;
  value: number;
  measuredAt: Date | string;
}

export interface AdherenceWindow {
  days: (typeof ADHERENCE_WINDOWS)[number];
  /** 窗口内有数据的天数 */
  daysWithData: number;
  /** 有数据那几天的平均值；没有数据为 null。步数取整，睡眠保留一位小数 */
  average: number | null;
  /** 达到目标的天数 */
  daysMet: number;
}

export interface AdherenceResult {
  key: string;
  metric: GoalMetric;
  target: number;
  /** 近 14 天都没有数据：界面写“没有监测数据，无法看执行情况” */
  hasData: boolean;
  windows: AdherenceWindow[];
}

export interface AdherenceInput {
  now: Date;
  /** 健管师时区：“今天”和每条读数属于哪一天都按它算 */
  timeZone: string;
  goals: readonly AdherenceGoal[];
  readings: readonly AdherenceReading[];
}

/**
 * 每个目标的执行情况。一天有多条读数时取当天最后一条（手动录入的更正以最后一次为准）；
 * 窗口是包含今天在内的最近 n 个日历日；不合理的数值（负数、非有限数）不参与计算。
 */
export function adherence(input: AdherenceInput): AdherenceResult[] {
  const today = dateInTimeZone(input.now, input.timeZone);
  const daily = new Map<GoalMetric, Map<string, { at: number; value: number }>>();
  for (const r of input.readings) {
    if (r.metric !== 'steps' && r.metric !== 'sleep_hours') continue;
    if (!Number.isFinite(r.value) || r.value < 0) continue;
    const at = typeof r.measuredAt === 'string' ? new Date(r.measuredAt) : r.measuredAt;
    if (Number.isNaN(at.getTime())) continue;
    const day = dateInTimeZone(at, input.timeZone);
    const age = daysBetweenIso(day, today);
    if (age < 0 || age >= 14) continue;
    const byDay = daily.get(r.metric) ?? new Map<string, { at: number; value: number }>();
    const prev = byDay.get(day);
    if (!prev || at.getTime() >= prev.at) byDay.set(day, { at: at.getTime(), value: r.value });
    daily.set(r.metric, byDay);
  }

  return input.goals.map((g) => {
    const byDay = daily.get(g.metric) ?? new Map();
    const windows = ADHERENCE_WINDOWS.map((days) => {
      const from = addDaysIso(today, -(days - 1));
      const values = [...byDay.entries()]
        .filter(([d]) => daysBetweenIso(from, d) >= 0)
        .map(([, v]) => v.value);
      const sum = values.reduce((a, b) => a + b, 0);
      const average = values.length
        ? g.metric === 'steps'
          ? Math.round(sum / values.length)
          : Math.round((sum / values.length) * 10) / 10
        : null;
      return {
        days,
        daysWithData: values.length,
        average,
        daysMet: values.filter((v) => v >= g.target).length,
      };
    });
    return {
      key: g.key,
      metric: g.metric,
      target: g.target,
      hasData: byDay.size > 0,
      windows,
    };
  });
}
