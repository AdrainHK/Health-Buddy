import type { PlanEvalCase } from './eval-types.js';
import { REPORT_SNAPSHOTS } from './report-fixtures.js';

/** 想一想“新客户完整评估”（M2 规格 2.9、Q22）：同一份资料依次生成解读和提纲 */
export const assessmentPlanEvalCases: PlanEvalCase[] = [
  {
    id: 'plan-new-client-multi-abnormal',
    planId: 'new-client-assessment',
    client: REPORT_SNAPSHOTS.multiAbnormal,
    managerRequest: '新客户，帮我做个完整评估。',
  },
  {
    id: 'plan-new-client-critical',
    planId: 'new-client-assessment',
    client: REPORT_SNAPSHOTS.critical,
    managerRequest: '新客户，帮我做个完整评估。',
  },
];
