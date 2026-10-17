import type { ClientSnapshot, ReportIndicatorDetail } from './framework.js';

/**
 * 用报告的技能（/体检解读、/面谈提纲）的合成客户资料，供单元测试和评测使用（M2 规格 4.4）。
 * 全部是虚构数据，不对应任何真实的人。资料和线上一样已经去标识：没有姓名和联系方式。
 */

type Row = Partial<ReportIndicatorDetail> & Pick<ReportIndicatorDetail, 'value' | 'abnormal'>;

function row(r: Row): ReportIndicatorDetail {
  return {
    code: r.code ?? null,
    rawName: r.rawName ?? null,
    value: r.value,
    textValue: r.textValue ?? null,
    unit: r.unit ?? null,
    refText: r.refText ?? null,
    refLow: r.refLow ?? null,
    refHigh: r.refHigh ?? null,
    abnormal: r.abnormal,
    previous: r.previous ?? [],
  };
}

const steps = (values: number[]) =>
  values.map((value, i) => ({
    date: new Date(Date.UTC(2026, 8, 15 + i * 3)).toISOString().slice(0, 10),
    value,
  }));

const base = {
  monitoring: [] as ClientSnapshot['monitoring'],
  latestReport: null,
  criticalFlags: [] as ClientSnapshot['criticalFlags'],
  riskTier: null,
};

export const REPORT_SNAPSHOTS = {
  /** 全部在参考范围内，没有之前的报告 */
  allNormal: {
    ...base,
    ageBand: '40-49',
    gender: 'female',
    healthHistory: [{ category: 'lifestyle', content: '每周游泳两次，不吸烟。' }],
    reportDetail: {
      date: '2026-09-12',
      previousReportDates: [],
      indicators: [
        row({
          code: 'fpg',
          value: 5.2,
          unit: 'mmol/L',
          refText: '3.9-6.1',
          refLow: 3.9,
          refHigh: 6.1,
          abnormal: 'normal',
        }),
        row({
          code: 'tc',
          value: 4.4,
          unit: 'mmol/L',
          refText: '<5.2',
          refHigh: 5.2,
          abnormal: 'normal',
        }),
        row({
          code: 'bmi',
          value: 21.8,
          unit: 'kg/m2',
          refText: '18.5-24',
          refLow: 18.5,
          refHigh: 24,
          abnormal: 'normal',
        }),
      ],
    },
  },
  /** 单项高于参考范围（空腹血糖），去年同项在范围内 */
  singleAbnormal: {
    ...base,
    ageBand: '50-59',
    gender: 'male',
    monitoring: [{ metric: 'steps', unit: 'steps', readings: steps([5200, 4800, 6100]) }],
    healthHistory: [{ category: 'family_history', content: '父亲有血糖偏高的情况（客户口述）。' }],
    reportDetail: {
      date: '2026-09-12',
      previousReportDates: ['2025-09-10'],
      indicators: [
        row({
          code: 'fpg',
          value: 6.5,
          unit: 'mmol/L',
          refText: '3.9-6.1',
          refLow: 3.9,
          refHigh: 6.1,
          abnormal: 'high',
          previous: [{ date: '2025-09-10', value: 5.9 }],
        }),
        row({
          code: 'tc',
          value: 4.9,
          unit: 'mmol/L',
          refText: '<5.2',
          refHigh: 5.2,
          abnormal: 'normal',
          previous: [{ date: '2025-09-10', value: 5.0 }],
        }),
      ],
    },
  },
  /** 多项高于参考范围，有的比去年变差、有的变好 */
  multiAbnormal: {
    ...base,
    ageBand: '50-59',
    gender: 'male',
    monitoring: [{ metric: 'weight', unit: 'kg', readings: steps([86.2, 86.6, 87.1]) }],
    healthHistory: [
      { category: 'lifestyle', content: '应酬多，每周饮酒三到四次。' },
      { category: 'medication', content: '自述目前没有长期用药。' },
    ],
    riskTier: { tier: 'medium', setOn: '2026-03-01' },
    reportDetail: {
      date: '2026-09-12',
      previousReportDates: ['2025-09-10'],
      indicators: [
        row({
          code: 'tg',
          value: 2.1,
          unit: 'mmol/L',
          refText: '<1.7',
          refHigh: 1.7,
          abnormal: 'high',
          previous: [{ date: '2025-09-10', value: 1.8 }],
        }),
        row({
          code: 'ldl_c',
          value: 3.9,
          unit: 'mmol/L',
          refText: '<3.4',
          refHigh: 3.4,
          abnormal: 'high',
          previous: [{ date: '2025-09-10', value: 4.3 }],
        }),
        row({
          code: 'uric_acid',
          value: 468,
          unit: 'umol/L',
          refText: '150-420',
          refLow: 150,
          refHigh: 420,
          abnormal: 'high',
          previous: [{ date: '2025-09-10', value: 455 }],
        }),
        row({
          code: 'hdl_c',
          value: 0.9,
          unit: 'mmol/L',
          refText: '>1.0',
          refLow: 1.0,
          abnormal: 'low',
        }),
        row({
          code: 'bmi',
          value: 27.6,
          unit: 'kg/m2',
          refText: '18.5-24',
          refLow: 18.5,
          refHigh: 24,
          abnormal: 'high',
          previous: [{ date: '2025-09-10', value: 27.1 }],
        }),
      ],
    },
  },
  /** 报告没印参考范围的指标，以及未收录指标 */
  missingReference: {
    ...base,
    ageBand: '60-69',
    gender: 'female',
    healthHistory: [],
    reportDetail: {
      date: '2026-08-20',
      previousReportDates: [],
      indicators: [
        row({ code: 'alt', value: 52, unit: 'U/L', abnormal: 'no_reference' }),
        row({
          code: 'creatinine',
          value: 71,
          unit: 'umol/L',
          refText: '44-133',
          refLow: 44,
          refHigh: 133,
          abnormal: 'normal',
        }),
        row({
          rawName: '同型半胱氨酸',
          value: 16.8,
          unit: 'umol/L',
          refText: '0-15',
          refLow: 0,
          refHigh: 15,
          abnormal: 'high',
        }),
        row({ rawName: '尿蛋白', value: null, textValue: '阴性', abnormal: 'no_reference' }),
      ],
    },
  },
  /** 报告里有危急指标（空腹血糖，需尽快就医） */
  critical: {
    ...base,
    ageBand: '60-69',
    gender: 'male',
    healthHistory: [{ category: 'past_history', content: '自述三年前体检血糖偏高，未复查。' }],
    reportDetail: {
      date: '2026-09-05',
      previousReportDates: [],
      indicators: [
        row({
          code: 'fpg',
          value: 17.2,
          unit: 'mmol/L',
          refText: '3.9-6.1',
          refLow: 3.9,
          refHigh: 6.1,
          abnormal: 'high',
        }),
        row({
          code: 'tg',
          value: 1.9,
          unit: 'mmol/L',
          refText: '<1.7',
          refHigh: 1.7,
          abnormal: 'high',
        }),
        row({
          code: 'tc',
          value: 5.0,
          unit: 'mmol/L',
          refText: '<5.2',
          refHigh: 5.2,
          abnormal: 'normal',
        }),
      ],
    },
    criticalFlags: [
      {
        metric: 'fpg',
        value: 17.2,
        unit: 'mmol/L',
        observedOn: '2026-09-05',
        source: 'report',
        rule: { comparator: 'gte', value: 16.7, level: 'urgent' },
      },
    ],
  },
  /** 和去年相比变好 */
  improved: {
    ...base,
    ageBand: '40-49',
    gender: 'male',
    healthHistory: [{ category: 'lifestyle', content: '今年开始每天快走 40 分钟。' }],
    reportDetail: {
      date: '2026-09-18',
      previousReportDates: ['2025-09-20'],
      indicators: [
        row({
          code: 'tg',
          value: 1.5,
          unit: 'mmol/L',
          refText: '<1.7',
          refHigh: 1.7,
          abnormal: 'normal',
          previous: [{ date: '2025-09-20', value: 2.4 }],
        }),
        row({
          code: 'weight',
          value: 74.5,
          unit: 'kg',
          abnormal: 'no_reference',
          previous: [{ date: '2025-09-20', value: 79.0 }],
        }),
        row({
          code: 'alt',
          value: 45,
          unit: 'U/L',
          refText: '7-40',
          refLow: 7,
          refHigh: 40,
          abnormal: 'high',
          previous: [{ date: '2025-09-20', value: 68 }],
        }),
      ],
    },
  },
  /** 和去年相比变差：血糖、甘油三酯、BMI 上升，高密度脂蛋白下降 */
  worsened: {
    ...base,
    ageBand: '50-59',
    gender: 'female',
    healthHistory: [{ category: 'lifestyle', content: '今年换了工作，久坐，运动比去年少。' }],
    reportDetail: {
      date: '2026-09-22',
      previousReportDates: ['2025-09-18'],
      indicators: [
        row({
          code: 'fpg',
          value: 6.4,
          unit: 'mmol/L',
          refText: '3.9-6.1',
          refLow: 3.9,
          refHigh: 6.1,
          abnormal: 'high',
          previous: [{ date: '2025-09-18', value: 5.6 }],
        }),
        row({
          code: 'tg',
          value: 1.9,
          unit: 'mmol/L',
          refText: '<1.7',
          refHigh: 1.7,
          abnormal: 'high',
          previous: [{ date: '2025-09-18', value: 1.4 }],
        }),
        row({
          code: 'hdl_c',
          value: 0.95,
          unit: 'mmol/L',
          refText: '>1.0',
          refLow: 1.0,
          abnormal: 'low',
          previous: [{ date: '2025-09-18', value: 1.25 }],
        }),
        row({
          code: 'bmi',
          value: 26.3,
          unit: 'kg/m2',
          refText: '18.5-24',
          refLow: 18.5,
          refHigh: 24,
          abnormal: 'high',
          previous: [{ date: '2025-09-18', value: 24.6 }],
        }),
      ],
    },
  },
} satisfies Record<string, ClientSnapshot>;
