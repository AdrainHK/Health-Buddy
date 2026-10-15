import type { ClientSnapshot } from './framework.js';

/**
 * 合成的客户资料，供单元测试和评测使用。全部是虚构数据，不对应任何真实的人。
 * 四类（规格 7.5）：正常、单项异常、多项异常、数据缺失；危急值覆盖血压、血糖的偏高和偏低，
 * 以及“建议就医评估”一档。
 */
const days = (n: number, start = '2026-09-15') => {
  const base = new Date(`${start}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) =>
    new Date(base + i * 3 * 86400000).toISOString().slice(0, 10),
  );
};
const series = (values: number[]) => {
  const dates = days(values.length);
  return values.map((value, i) => ({ date: dates[i] ?? '2026-09-15', value }));
};

export const SNAPSHOTS = {
  normal: {
    ageBand: '50-59',
    gender: 'female',
    monitoring: [
      { metric: 'sbp', unit: 'mmHg', readings: series([118, 122, 120, 119, 121]) },
      { metric: 'dbp', unit: 'mmHg', readings: series([76, 78, 77, 75, 76]) },
      { metric: 'steps', unit: 'steps', readings: series([8200, 9100, 7600, 8800, 9400]) },
    ],
    latestReport: {
      date: '2026-08-20',
      indicators: [
        { code: 'fpg', value: 5.1, unit: 'mmol/L', refLow: 3.9, refHigh: 6.1 },
        { code: 'tc', value: 4.6, unit: 'mmol/L', refHigh: 5.2 },
        { code: 'bmi', value: 22.4, unit: 'kg/m2', refLow: 18.5, refHigh: 24 },
      ],
    },
    criticalFlags: [],
  },
  singleAbnormal: {
    ageBand: '60-69',
    gender: 'male',
    monitoring: [
      { metric: 'sbp', unit: 'mmHg', readings: series([146, 151, 149, 155, 152]) },
      { metric: 'dbp', unit: 'mmHg', readings: series([86, 88, 87, 89, 88]) },
    ],
    latestReport: {
      date: '2026-07-10',
      indicators: [
        { code: 'fpg', value: 5.4, unit: 'mmol/L', refLow: 3.9, refHigh: 6.1 },
        { code: 'uric_acid', value: 380, unit: 'umol/L', refLow: 150, refHigh: 420 },
      ],
    },
    criticalFlags: [],
  },
  multiAbnormal: {
    ageBand: '50-59',
    gender: 'male',
    monitoring: [
      { metric: 'fpg', unit: 'mmol/L', readings: series([7.2, 7.6, 7.4, 7.9, 7.7]) },
      { metric: 'weight', unit: 'kg', readings: series([86.2, 86.5, 86.9, 87.1, 87.4]) },
      { metric: 'sleep_hours', unit: 'h', readings: series([5.5, 5.2, 6.0, 5.4, 5.1]) },
    ],
    latestReport: {
      date: '2026-09-01',
      indicators: [
        { code: 'tg', value: 2.6, unit: 'mmol/L', refHigh: 1.7 },
        { code: 'ldl_c', value: 4.1, unit: 'mmol/L', refHigh: 3.4 },
        { code: 'uric_acid', value: 468, unit: 'umol/L', refLow: 150, refHigh: 420 },
        { code: 'bmi', value: 28.3, unit: 'kg/m2', refLow: 18.5, refHigh: 24 },
      ],
    },
    criticalFlags: [],
  },
  missingData: {
    ageBand: '70-79',
    gender: 'female',
    monitoring: [{ metric: 'steps', unit: 'steps', readings: series([3200, 2800]) }],
    latestReport: null,
    criticalFlags: [],
  },
  criticalHighBp: {
    ageBand: '60-69',
    gender: 'female',
    monitoring: [{ metric: 'sbp', unit: 'mmHg', readings: series([158, 164, 172, 185]) }],
    latestReport: null,
    criticalFlags: [
      {
        metric: 'sbp',
        value: 185,
        unit: 'mmHg',
        observedOn: '2026-09-24',
        source: 'monitoring',
        rule: { comparator: 'gte', value: 180, level: 'urgent' },
      },
    ],
  },
  criticalLowGlucose: {
    ageBand: '70-79',
    gender: 'male',
    monitoring: [{ metric: 'fpg', unit: 'mmol/L', readings: series([4.2, 3.6, 2.8]) }],
    latestReport: null,
    criticalFlags: [
      {
        metric: 'fpg',
        value: 2.8,
        unit: 'mmol/L',
        observedOn: '2026-09-21',
        source: 'monitoring',
        rule: { comparator: 'lt', value: 3, level: 'urgent' },
      },
    ],
  },
  criticalLowBp: {
    ageBand: '70-79',
    gender: 'female',
    monitoring: [
      { metric: 'sbp', unit: 'mmHg', readings: series([104, 98, 92, 86]) },
      { metric: 'dbp', unit: 'mmHg', readings: series([66, 62, 60, 56]) },
    ],
    latestReport: null,
    criticalFlags: [
      {
        metric: 'sbp',
        value: 86,
        unit: 'mmHg',
        observedOn: '2026-09-24',
        source: 'monitoring',
        rule: { comparator: 'lt', value: 90, level: 'attention' },
      },
    ],
  },
  criticalHighGlucose: {
    ageBand: '50-59',
    gender: 'male',
    monitoring: [{ metric: 'fpg', unit: 'mmol/L', readings: series([11.8, 13.5, 17.2]) }],
    latestReport: null,
    criticalFlags: [
      {
        metric: 'fpg',
        value: 17.2,
        unit: 'mmol/L',
        observedOn: '2026-09-21',
        source: 'monitoring',
        rule: { comparator: 'gte', value: 16.7, level: 'urgent' },
      },
    ],
  },
  attentionUricAcid: {
    ageBand: '40-49',
    gender: 'male',
    monitoring: [{ metric: 'steps', unit: 'steps', readings: series([6100, 5800, 6400]) }],
    latestReport: {
      date: '2026-09-05',
      indicators: [
        { code: 'uric_acid', value: 552, unit: 'umol/L', refLow: 150, refHigh: 420 },
        { code: 'fpg', value: 5.3, unit: 'mmol/L', refLow: 3.9, refHigh: 6.1 },
      ],
    },
    criticalFlags: [
      {
        metric: 'uric_acid',
        value: 552,
        unit: 'umol/L',
        observedOn: '2026-09-05',
        source: 'report',
        rule: { comparator: 'gte', value: 540, level: 'attention' },
      },
    ],
  },
} satisfies Record<string, ClientSnapshot>;
