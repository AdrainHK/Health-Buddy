import { z } from 'zod';
import { MONITORING_METRICS, type MonitoringMetricCode } from '../health/catalog.js';
import { THRESHOLD_BOUNDS } from '../health/critical.js';

/**
 * 健管师手动录入监测数据（M4 规格 Q29）：单条录入，标“手动”，只能删除自己录入的。
 * 单位跟指标目录走，请求里不传单位。
 */
const metricCodes = MONITORING_METRICS.map((m) => m.code) as [
  MonitoringMetricCode,
  ...MonitoringMetricCode[],
];

/** 允许的时钟误差：客户端时间略快于服务器时也能提交 */
const CLOCK_SKEW_MS = 5 * 60_000;

export const createMonitoringReadingRequestSchema = z
  .object({
    metric: z.enum(metricCodes),
    value: z.number().finite(),
    measuredAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    (v) => {
      const b = THRESHOLD_BOUNDS[v.metric];
      return v.value >= b.min && v.value <= b.max;
    },
    { message: 'value out of range', path: ['value'] },
  )
  .refine((v) => Date.parse(v.measuredAt) <= Date.now() + CLOCK_SKEW_MS, {
    message: 'measuredAt in the future',
    path: ['measuredAt'],
  });
export type CreateMonitoringReadingRequest = z.infer<typeof createMonitoringReadingRequestSchema>;

/** 每位健管师每分钟最多手动录入 60 条（防误操作） */
export const MONITORING_MANUAL_PER_MINUTE = 60;

export const MONITORING_SOURCES = ['synthetic', 'device', 'manual', 'companion'] as const;

/** 一条监测读数。id 是数据库自增编号（字符串） */
export const monitoringReadingSchema = z.object({
  id: z.string().regex(/^\d{1,19}$/),
  clientId: z.uuid(),
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  measuredAt: z.iso.datetime(),
  source: z.enum(MONITORING_SOURCES),
  /** 当前健管师自己手动录入的，可以删除 */
  deletable: z.boolean(),
});
export type MonitoringReading = z.infer<typeof monitoringReadingSchema>;

export const monitoringReadingResponseSchema = z.object({ reading: monitoringReadingSchema });
export type MonitoringReadingResponse = z.infer<typeof monitoringReadingResponseSchema>;
