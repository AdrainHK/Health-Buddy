import type {
  AdherenceResponse,
  CarePlan,
  ExerciseManagerView,
  GoalTemplateManagerView,
  RecipeManagerView,
  TodayVisitsResponse,
  Visit,
  VisitRecord,
} from '@health-buddy/shared';
import { ids, NOW } from './mockApi';

/** 方案与随访测试用的合成数据。全部是虚构数据，不含真实客户信息。 */

export const careIds = {
  plan: 'a1000000-0000-4000-8000-000000000001',
  oldPlan: 'a1000000-0000-4000-8000-000000000002',
  stepsGoal: 'a2000000-0000-4000-8000-000000000001',
  relaxGoal: 'a2000000-0000-4000-8000-000000000002',
  visit1: 'a3000000-0000-4000-8000-000000000001',
  visit2: 'a3000000-0000-4000-8000-000000000002',
  record: 'a4000000-0000-4000-8000-000000000001',
  addendum: 'a4100000-0000-4000-8000-000000000001',
  recipe: 'a5000000-0000-4000-8000-000000000001',
  exercise: 'a6000000-0000-4000-8000-000000000001',
};

export const STEPS_TEMPLATE: GoalTemplateManagerView = {
  id: careIds.stepsGoal,
  version: 1,
  code: 'daily_steps',
  section: 'exercise',
  text: '每天步行 {steps} 步',
  params: [{ name: 'steps', type: 'int', min: 4000, max: 10000, default: 6000, unit: '步' }],
  metric: 'steps',
  metricParam: 'steps',
  sourceNote: '合成来源说明',
};

export const RELAX_TEMPLATE: GoalTemplateManagerView = {
  id: careIds.relaxGoal,
  version: 1,
  code: 'daily_relax',
  section: 'mind',
  text: '每天做 {minutes} 分钟放松练习',
  params: [{ name: 'minutes', type: 'int', min: 5, max: 30, default: 10, unit: '分钟' }],
  metric: null,
  metricParam: null,
  sourceNote: '合成来源说明',
};

export function makeCarePlan(overrides: Partial<CarePlan> = {}): CarePlan {
  return {
    id: careIds.plan,
    clientId: ids.clientA,
    artifactId: ids.artifact,
    sections: ['exercise', 'mind'],
    cycleWeeks: 8,
    startDate: '2026-10-01',
    reviewDate: '2026-11-26',
    status: 'active',
    endReason: null,
    approvedAt: NOW,
    endedAt: null,
    snapshot: {
      structured: {
        sections: [
          {
            section: 'exercise',
            professional: '合成专业版运动',
            clientFacing: '合成通俗版运动',
            goals: [{ templateId: careIds.stepsGoal, params: { steps: 7000 } }],
          },
          {
            section: 'mind',
            professional: '合成专业版心理',
            clientFacing: '合成通俗版心理',
            goals: [{ templateId: careIds.relaxGoal, params: { minutes: 10 } }],
          },
        ],
        recipes: [],
        exercises: [],
      },
      content: {
        professional: '## 合成方案专业版\n- 合成要点',
        clientFacing: '合成方案通俗版\n\n仅供参考，非医疗诊断',
      },
      libraryVersions: [],
    },
    ...overrides,
  };
}

export const ADHERENCE: AdherenceResponse = {
  planId: careIds.plan,
  asOf: '2026-10-15',
  timeZone: 'Asia/Shanghai',
  goals: [
    {
      templateId: careIds.stepsGoal,
      metric: 'steps',
      target: 7000,
      hasData: true,
      windows: [
        { days: 7, daysWithData: 6, average: 6543.21, daysMet: 3 },
        { days: 14, daysWithData: 0, average: null, daysMet: 0 },
      ],
    },
  ],
  untrackedTemplateIds: [careIds.relaxGoal],
};

export function makeVisit(overrides: Partial<Visit> = {}): Visit {
  return {
    id: careIds.visit1,
    clientId: ids.clientA,
    dueDate: '2026-10-20',
    method: 'phone',
    purpose: 'routine',
    focus: '了解合成客户的散步情况',
    origin: 'schedule',
    status: 'planned',
    cancelReason: null,
    note: null,
    carePlanId: null,
    followUpItemId: null,
    recordId: null,
    rescheduledFrom: null,
    doneAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function todayVisits(items: TodayVisitsResponse['items']): TodayVisitsResponse {
  return { items, count: items.length, date: '2026-10-15', timeZone: 'Asia/Shanghai' };
}

export const RECORD: VisitRecord = {
  id: careIds.record,
  clientId: ids.clientA,
  visitId: null,
  visitDate: '2026-10-10',
  method: 'wechat',
  excerpt: '合成客户说最近晚饭后散步',
  approvedAt: NOW,
  snapshot: {
    visitDate: '2026-10-10',
    method: 'wechat',
    summary: '合成客户说最近晚饭后散步，每周约 4 次。',
    feedback: [{ topic: 'exercise', items: ['合成客户说晚饭后散步 20 分钟'] }],
    planProgress: ['步数目标大部分天做到'],
    agreements: ['下次随访了解周末的安排'],
    attentionPoints: [],
    historySuggestions: [{ category: 'lifestyle', content: '每周散步约 4 次' }],
    openQuestions: [],
  },
  addenda: [],
};

export const RECIPE: RecipeManagerView = {
  id: careIds.recipe,
  version: 2,
  code: 'oat_porridge',
  name: '合成燕麦粥',
  mealTypes: ['breakfast'],
  ingredients: [
    { name: '燕麦', householdAmount: '半碗', grams: 40, overseasAlternative: null },
    { name: '牛奶', householdAmount: '一杯', grams: null, overseasAlternative: null },
  ],
  steps: ['燕麦加水煮软', '加入牛奶'],
  nutritionPerServing: null,
  nutritionBasis: null,
  tags: ['high_fiber'],
  allergens: ['dairy', 'gluten'],
  sourceNote: '合成来源说明',
};

export const EXERCISE: ExerciseManagerView = {
  id: careIds.exercise,
  version: 1,
  code: 'brisk_walk',
  name: '合成快走',
  category: 'aerobic',
  intensity: 'moderate',
  setting: ['outdoor'],
  equipment: [],
  steps: ['抬头挺胸', '步幅自然'],
  keyPoints: ['微微出汗、能说话'],
  commonMistakes: [],
  managerCautions: '合成注意事项：有胸闷时先问医生',
  met: 4.3,
  sourceNote: '合成来源说明',
};
