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
