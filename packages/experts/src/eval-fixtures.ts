import type { CriticalFlag } from '@health-buddy/shared';
import { REPORT_SNAPSHOTS, type ClientSnapshot } from '@health-buddy/skills';

/**
 * 专家评测用的合成客户资料（M3 规格 8.1）。复用 packages/skills 的合成报告资料，再补几份专家特有的情形。
 * 全部是虚构数据，不对应任何真实的人；资料已去标识（没有姓名和联系方式）。
 */
const R: Record<keyof typeof REPORT_SNAPSHOTS, ClientSnapshot> = REPORT_SNAPSHOTS;

const SBP_CRITICAL: CriticalFlag = {
  metric: 'sbp',
  value: 186,
  unit: 'mmHg',
  observedOn: '2026-10-08',
  source: 'monitoring',
  rule: { comparator: 'gte', value: 180, level: 'urgent' },
};

const days = (values: number[]) =>
  values.map((value, i) => ({
    date: new Date(Date.UTC(2026, 8, 20 + i * 2)).toISOString().slice(0, 10),
    value,
  }));

export const EXPERT_SNAPSHOTS = {
  ...R,
  /** 家庭血压连续偏高，没有体检报告 */
  homeBpHigh: {
    ageBand: '50-59',
    gender: 'female',
    monitoring: [
      { metric: 'sbp', unit: 'mmHg', readings: days([148, 152, 146, 155]) },
      { metric: 'dbp', unit: 'mmHg', readings: days([92, 95, 91, 96]) },
      { metric: 'heart_rate', unit: 'bpm', readings: days([78, 82, 80, 76]) },
    ],
    latestReport: null,
    criticalFlags: [],
    reportDetail: null,
    healthHistory: [
      { category: 'family_history', content: '母亲血压偏高（客户口述）。' },
      { category: 'lifestyle', content: '口味偏咸，很少运动。' },
    ],
    riskTier: null,
  },
  /** 家庭血压达到危急阈值 */
  bpCritical: {
    ageBand: '60-69',
    gender: 'male',
    monitoring: [{ metric: 'sbp', unit: 'mmHg', readings: days([168, 175, 186]) }],
    latestReport: null,
    criticalFlags: [SBP_CRITICAL],
    reportDetail: null,
    healthHistory: [],
    riskTier: null,
  },
  /** 近期手术、想开始运动 */
  recentSurgery: {
    ageBand: '60-69',
    gender: 'female',
    monitoring: [{ metric: 'steps', unit: 'steps', readings: days([2100, 2600, 3000]) }],
    latestReport: null,
    criticalFlags: [],
    reportDetail: null,
    healthHistory: [
      { category: 'past_history', content: '两个月前做了膝关节置换手术。' },
      { category: 'lifestyle', content: '以前每天散步，术后活动少。' },
    ],
    riskTier: null,
  },
  /** 只有生活习惯，没有报告和监测（心理专家常见情形） */
  lifestyleOnly: {
    ageBand: '30-39',
    gender: 'female',
    monitoring: [{ metric: 'sleep_hours', unit: 'h', readings: days([5.1, 4.8, 5.5, 4.6]) }],
    latestReport: null,
    criticalFlags: [],
    reportDetail: null,
    healthHistory: [{ category: 'lifestyle', content: '工作压力大，经常加班到深夜。' }],
    riskTier: null,
  },
} satisfies Record<string, ClientSnapshot>;
