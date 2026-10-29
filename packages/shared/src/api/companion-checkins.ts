import { z } from 'zod';
import { THRESHOLD_BOUNDS } from '../health/critical.js';
import type { MonitoringMetricCode } from '../health/catalog.js';

/**
 * 伴侣打卡（M6 规格 2.3、6.2）：计划只由健管师在工作台设置（Q16），三类：服药、测量、运动。
 * 客户唤醒福宝时先补说到期的提醒（暂行做法，固件空闲时不连服务器），客户的回答按规则识别；
 * 测量值复述、客户确认后写入监测（来源“伴侣”），触发孪生重算（N8）。
 * 服药计划不存药名和剂量（N15），备注只给健管师看，福宝读不到。
 */

export const CHECKIN_KINDS = ['medication', 'measurement', 'exercise'] as const;
export const checkinKindSchema = z.enum(CHECKIN_KINDS);
export type CheckinKind = z.infer<typeof checkinKindSchema>;

/** 时间段：早、中、晚、睡前 */
export const CHECKIN_SLOTS = ['morning', 'noon', 'evening', 'bedtime'] as const;
export const checkinSlotSchema = z.enum(CHECKIN_SLOTS);
export type CheckinSlot = z.infer<typeof checkinSlotSchema>;

/**
 * 每个时间段的窗口（北京时间，HH:MM，含开始不含结束）。N7 的具体时间待产品负责人定，先用这组默认值。
 * 健管师填的提醒时间必须落在窗口内；到了提醒时间、窗口结束前唤醒福宝，先补说提醒；
 * 窗口结束还没回答的记“未应答”。数据库函数里有同样的一份（有测试对照）。
 */
export const CHECKIN_SLOT_WINDOWS: Readonly<Record<CheckinSlot, { start: string; end: string }>> = {
  morning: { start: '06:00', end: '11:00' },
  noon: { start: '11:00', end: '14:00' },
  evening: { start: '17:00', end: '20:00' },
  bedtime: { start: '20:00', end: '23:00' },
};

/**
 * 测量项目（规格 2.3）：先做 5 种。餐后 2 小时血糖不在监测目录里，以后再加。
 * 血压一次报两个数（高压、低压），写成两条监测读数。
 */
export const CHECKIN_METRICS = ['bp', 'fpg', 'weight', 'steps', 'sleep_hours'] as const;
export const checkinMetricSchema = z.enum(CHECKIN_METRICS);
export type CheckinMetric = z.infer<typeof checkinMetricSchema>;

/** 测量项目对应的监测指标（按顺序：血压是高压、低压） */
export const CHECKIN_METRIC_READINGS: Readonly<
  Record<CheckinMetric, readonly MonitoringMetricCode[]>
> = {
  bp: ['sbp', 'dbp'],
  fpg: ['fpg'],
  weight: ['weight'],
  steps: ['steps'],
  sleep_hours: ['sleep_hours'],
};

/** 数值是否都在合理范围内（M2、M4 的 THRESHOLD_BOUNDS，挡住听错、说错） */
export function checkinValuesInRange(metric: CheckinMetric, values: readonly number[]): boolean {
  const codes = CHECKIN_METRIC_READINGS[metric];
  if (values.length !== codes.length) return false;
  if (metric === 'bp' && values[0]! <= values[1]!) return false;
  return codes.every((code, i) => {
    const b = THRESHOLD_BOUNDS[code];
    const v = values[i]!;
    return Number.isFinite(v) && v >= b.min && v <= b.max;
  });
}

/** 打卡结果：完成、做了一部分（运动）、没做或漏服、今天不用（服药）、未应答（窗口过了没回答） */
export const CHECKIN_STATUSES = ['done', 'partial', 'missed', 'skipped', 'no_response'] as const;
export const checkinStatusSchema = z.enum(CHECKIN_STATUSES);
export type CheckinStatus = z.infer<typeof checkinStatusSchema>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 提醒时间是否落在时间段的窗口内 */
export function checkinTimeInSlot(slot: CheckinSlot, time: string): boolean {
  const w = CHECKIN_SLOT_WINDOWS[slot];
  return TIME.test(time) && time >= w.start && time < w.end;
}

export const checkinSlotTimeSchema = z.object({
  slot: checkinSlotSchema,
  time: z.string().regex(TIME),
});
export type CheckinSlotTime = z.infer<typeof checkinSlotTimeSchema>;

export const CHECKIN_NOTE_MAX = 200;
/** 每位客户最多这么多个启用的计划 */
export const CHECKIN_PLANS_MAX = 12;

const slotsSchema = z
  .array(checkinSlotTimeSchema)
  .min(1)
  .max(CHECKIN_SLOTS.length)
  .refine((slots) => new Set(slots.map((s) => s.slot)).size === slots.length, {
    message: 'duplicate slot',
  })
  .refine((slots) => slots.every((s) => checkinTimeInSlot(s.slot, s.time)), {
    message: 'time outside slot window',
  });

/** 备注只给健管师看；去掉首尾空白，空的当作没有 */
const noteSchema = z
  .string()
  .trim()
  .max(CHECKIN_NOTE_MAX)
  .transform((s) => s || null)
  .nullable();

export const createCheckinPlanRequestSchema = z
  .object({
    kind: checkinKindSchema,
    /** 测量类必填，其他类不填 */
    metric: checkinMetricSchema.nullable().default(null),
    slots: slotsSchema,
    /** 运动类可选：对应当前方案的哪个行为目标（只给健管师看） */
    goalTemplateId: z.uuid().nullable().default(null),
    note: noteSchema.default(null),
  })
  .refine((p) => (p.kind === 'measurement') === (p.metric !== null), {
    message: 'metric required for measurement only',
    path: ['metric'],
  })
  .refine((p) => p.kind === 'exercise' || p.goalTemplateId === null, {
    message: 'goal template for exercise only',
    path: ['goalTemplateId'],
  });
export type CreateCheckinPlanRequest = z.infer<typeof createCheckinPlanRequestSchema>;

/** 修改时间段、目标、备注，或停用、启用；类别和测量项目不能改（改了就是另一个计划） */
export const updateCheckinPlanRequestSchema = z
  .object({
    slots: slotsSchema.optional(),
    goalTemplateId: z.uuid().nullable().optional(),
    note: noteSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'empty update' });
export type UpdateCheckinPlanRequest = z.infer<typeof updateCheckinPlanRequestSchema>;

export const checkinPlanSchema = z.object({
  id: z.uuid(),
  kind: checkinKindSchema,
  metric: checkinMetricSchema.nullable(),
  slots: z.array(checkinSlotTimeSchema),
  goalTemplateId: z.uuid().nullable(),
  note: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type CheckinPlan = z.infer<typeof checkinPlanSchema>;

export const checkinPlanListResponseSchema = z.object({ plans: z.array(checkinPlanSchema) });
export type CheckinPlanListResponse = z.infer<typeof checkinPlanListResponseSchema>;
export const checkinPlanResponseSchema = z.object({ plan: checkinPlanSchema });
export type CheckinPlanResponse = z.infer<typeof checkinPlanResponseSchema>;

/** 近 30 天的打卡记录（规格 2.8） */
export const CHECKIN_HISTORY_DAYS = 30;

export const checkinSchema = z.object({
  id: z.uuid(),
  planId: z.uuid(),
  kind: checkinKindSchema,
  metric: checkinMetricSchema.nullable(),
  /** 北京时间的日期 */
  dueOn: z.iso.date(),
  slot: checkinSlotSchema,
  status: checkinStatusSchema,
  /** 测量类：客户报的数值（按 CHECKIN_METRIC_READINGS 的顺序） */
  values: z.array(z.number()),
  answeredAt: z.iso.datetime().nullable(),
});
export type Checkin = z.infer<typeof checkinSchema>;

export const checkinListResponseSchema = z.object({ checkins: z.array(checkinSchema) });
export type CheckinListResponse = z.infer<typeof checkinListResponseSchema>;
