import { describe, expect, it } from 'vitest';
import {
  carePlan,
  carePlanStructured,
  validateCarePlan,
  type CarePlanOutput,
} from './care-plan/index.js';
import type { SkillInput } from './framework.js';
import type { PlanLibraryContext } from './plan-input.js';
import { getSkill, skillSummaries } from './registry.js';
import { visitScheduleEvalCases } from './visit-schedule/evals/cases.js';
import { visitSchedule, validateVisitSchedule } from './visit-schedule/index.js';

/** M5 /随访计划（规格 2.7、5.2、5.5）。全部是合成数据 */

const evalCase = visitScheduleEvalCases.find((c) => c.id === 'vs-plan-review')!;
const input: SkillInput = {
  client: evalCase.client,
  managerRequest: '请排随访计划',
  plan: evalCase.plan,
};
const rows = evalCase.plan.schedule!.rows;
const output = (over: Partial<Parameters<typeof validateVisitSchedule>[0]> = {}) => ({
  rows: rows.map((r) => ({ ...r, focus: '了解晚餐调整的执行情况' })),
  notes: [],
  crisisSignal: false,
  ...over,
});

describe('/随访计划', () => {
  it('登记在技能表里：只有专业版、读方案上下文、不接专家', () => {
    expect(getSkill('visit-schedule')).toBe(visitSchedule);
    expect(visitSchedule).toMatchObject({
      kind: 'visit_schedule',
      clientFacing: false,
      planContext: 'visit_schedule',
      experts: 'none',
    });
    expect(skillSummaries().find((s) => s.id === 'visit-schedule')).toMatchObject({
      clientFacing: false,
      allowsEmptyRequest: true,
    });
  });

  it('用户消息里有当前方案、随访记录和系统排好的日期；日期和目的不能改', () => {
    const message = visitSchedule.buildUserMessage(input);
    expect(message).toContain('## 当前方案');
    expect(message).toContain('每天步行 7000 步');
    expect(message).toContain('## 系统排好的随访日期');
    for (const r of rows) expect(message).toContain(r.dueDate);
    expect(message).toContain('日期和目的不能改');
  });

  it('结构校验：行数、日期、目的和输入一致才通过；重点超长也不合格', () => {
    expect(validateVisitSchedule(output(), input)).toEqual([]);
    expect(validateVisitSchedule(output({ rows: output().rows.slice(1) }), input)).toEqual([
      'schedule_mismatch',
    ]);
    const swapped = output().rows.map((r, i) =>
      i === 0 ? { ...r, purpose: r.purpose === 'routine' ? 'follow_up' : 'routine' } : r,
    ) as ReturnType<typeof output>['rows'];
    expect(validateVisitSchedule(output({ rows: swapped }), input)).toEqual(['schedule_mismatch']);
    const long = output().rows.map((r) => ({ ...r, focus: '了'.repeat(201) }));
    expect(validateVisitSchedule(output({ rows: long }), input)).toEqual(['focus_too_long']);
  });

  it('渲染：日期和目的照抄输入，结构化内容可以直接确认；没有通俗版', () => {
    const rendered = visitSchedule.render(output({ notes: ['第一次随访排在方案开始后'] }), input);
    expect(rendered.clientFacing).toBe('');
    expect(rendered.structured).toEqual({
      rows: rows.map((r) => ({ ...r, focus: '了解晚餐调整的执行情况' })),
    });
    expect(rendered.professional).toContain('方案复评');
    expect(rendered.professional).toContain('随访日期由系统按平台的随访频次规则排出');
  });

  it('措辞检查：重点里的疾病名称、用药建议、判断说法都拦下', () => {
    const bad = output({
      rows: output().rows.map((r, i) =>
        i === 0 ? { ...r, focus: '确认高血压病情，提醒把降压药减半' } : r,
      ),
    });
    const categories = new Set(visitSchedule.checkOutput!(bad, input).map((i) => i.category));
    expect(categories.has('presumed_disease')).toBe(true);
    expect(categories.has('judgment')).toBe(true);
    expect(visitSchedule.checkOutput!(output(), input)).toEqual([]);
    // 说明里照抄“按风险分层排的间隔”不算判断说法
    expect(
      visitSchedule.checkOutput!(
        output({ notes: ['按风险分层“中”的间隔 30 天排，属于中风险客户，第一次随访在方案开始后'] }),
        input,
      ),
    ).toEqual([]);
  });

  it('评测用例至少 8 条，日期表都非空', () => {
    expect(visitScheduleEvalCases.length).toBeGreaterThanOrEqual(8);
    for (const c of visitScheduleEvalCases) expect(c.plan.schedule?.rows.length).toBeGreaterThan(0);
  });
});

/** M5 /方案生成（规格 2.2–2.5、5.2–5.4）。候选库是手写的合成条目 */
const LIBRARY: PlanLibraryContext = {
  options: { sections: ['diet', 'exercise', 'mind'], cycleWeeks: 8 },
  recipes: [
    {
      id: 'r-oat',
      version: 1,
      name: '燕麦粥配水煮蛋',
      mealTypes: ['breakfast'],
      tags: ['high_fiber'],
      allergens: ['egg'],
      ingredients: [{ name: '燕麦片', householdAmount: '半碗' }],
      steps: ['燕麦加水煮 5 分钟'],
      energyKcal: null,
    },
    {
      id: 'r-fish',
      version: 1,
      name: '清蒸鱼配糙米饭',
      mealTypes: ['lunch', 'dinner'],
      tags: ['quality_protein'],
      allergens: ['seafood'],
      ingredients: [{ name: '鲈鱼', householdAmount: '一掌' }],
      steps: ['鱼蒸 8 分钟'],
      energyKcal: 450,
    },
  ],
  exercises: [
    {
      id: 'x-walk',
      version: 1,
      name: '健步走',
      category: 'aerobic',
      intensity: 'moderate',
      steps: ['先慢走 5 分钟热身'],
      keyPoints: ['抬头挺胸'],
      managerCautions: '近期胸闷的客户先请医生评估',
    },
    {
      id: 'x-breath',
      version: 1,
      name: '腹式呼吸',
      category: 'relaxation',
      intensity: 'low',
      steps: ['吸气时腹部鼓起'],
      keyPoints: ['呼气比吸气慢'],
      managerCautions: '无特殊注意事项',
    },
  ],
  goalTemplates: [
    {
      id: 'g-veg',
      version: 1,
      section: 'diet',
      text: '每天吃蔬菜 {portions} 份',
      params: [{ name: 'portions', type: 'int', min: 3, max: 6, default: 4, unit: '份' }],
      metric: null,
    },
    {
      id: 'g-walk',
      version: 1,
      section: 'exercise',
      text: '每周快走 {times} 次',
      params: [{ name: 'times', type: 'int', min: 2, max: 7, default: 3, unit: '次' }],
      metric: null,
    },
  ],
  excludedForAllergy: 1,
  exerciseRestriction: null,
  libraryEmpty: false,
};
const planInput = (lib: Partial<PlanLibraryContext> = {}): SkillInput => ({
  client: visitScheduleEvalCases[0]!.client,
  managerRequest: '请生成方案',
  plan: { currentPlan: null, recentRecords: [], library: { ...LIBRARY, ...lib } },
});
const carePlanOutput = (over: Partial<CarePlanOutput> = {}): CarePlanOutput => ({
  sections: [
    {
      section: 'diet',
      professional: '晚餐主食偏多，选高纤维早餐。',
      clientFacing: '早餐换成燕麦粥，晚餐多一份蔬菜。',
      goals: [{ templateId: 'g-veg', params: [{ name: 'portions', value: '4' }] }],
    },
    {
      section: 'exercise',
      professional: '从低强度开始。',
      clientFacing: '晚饭后快走，微微出汗就好。',
      goals: [{ templateId: 'g-walk', params: [{ name: 'times', value: '3' }] }],
    },
    {
      section: 'mind',
      professional: '下班后安排放松时间。',
      clientFacing: '睡前做几分钟腹式呼吸。',
      goals: [],
    },
  ],
  recipes: [
    { day: 2, meal: 'lunch', recipeId: 'r-fish' },
    { day: 1, meal: 'breakfast', recipeId: 'r-oat' },
  ],
  exercises: [
    { exerciseId: 'x-walk', frequencyPerWeek: 3, minutes: 20 },
    { exerciseId: 'x-breath', frequencyPerWeek: 7, minutes: 5 },
  ],
  overview: {
    basis: ['资料里没有饮食记录'],
    focus: ['规律三餐'],
    medicalReview: null,
    changes: [],
  },
  followUpFocus: ['了解早餐调整的执行情况'],
  referral: [],
  dataGaps: ['没有饮食记录'],
  notes: [],
  crisisSignal: false,
  ...over,
});

describe('/方案生成', () => {
  it('登记在技能表里：有通俗版、读方案上下文、带方案选项条', () => {
    expect(getSkill('care-plan')).toBe(carePlan);
    expect(carePlan).toMatchObject({
      kind: 'care_plan',
      clientFacing: true,
      planContext: 'care_plan',
    });
    expect(skillSummaries().find((s) => s.id === 'care-plan')).toMatchObject({
      usesPlanOptions: true,
      allowsEmptyRequest: true,
    });
  });

  it('用户消息里有方案选项、候选 id、目标模板的参数范围和运动安全规则', () => {
    const message = carePlan.buildUserMessage(planInput());
    expect(message).toContain('## 方案选项');
    expect(message).toContain('r-oat');
    expect(message).toContain('x-walk');
    expect(message).toContain('portions：整数 3–6 份，默认 4');
    expect(message).toContain('因过敏史排除了 1 份食谱');
    expect(message).not.toContain('运动安全规则');
    const restricted = carePlan.buildUserMessage(planInput({ exerciseRestriction: '有危急指标' }));
    expect(restricted).toContain('## 运动安全规则：有危急指标');
  });

  it('结构校验：合格时通过；部分不一致、参数超范围、库外条目、餐次不对都拦下', () => {
    const input = planInput();
    expect(validateCarePlan(carePlanOutput(), input)).toEqual([]);
    expect(
      validateCarePlan(carePlanOutput({ sections: carePlanOutput().sections.slice(0, 2) }), input),
    ).toEqual(['section_mismatch']);
    const bad = carePlanOutput();
    bad.sections[0] = {
      ...bad.sections[0]!,
      goals: [{ templateId: 'g-veg', params: [{ name: 'portions', value: '9' }] }],
    };
    expect(validateCarePlan(bad, input)).toEqual(['goal_invalid']);
    const wrongSection = carePlanOutput();
    wrongSection.sections[0] = {
      ...wrongSection.sections[0]!,
      goals: [{ templateId: 'g-walk', params: [{ name: 'times', value: '3' }] }],
    };
    expect(validateCarePlan(wrongSection, input)).toEqual(['goal_invalid']);
    expect(
      validateCarePlan(
        carePlanOutput({ recipes: [{ day: 1, meal: 'dinner', recipeId: 'r-oat' }] }),
        input,
      ),
    ).toEqual(['library_ref']);
    expect(
      validateCarePlan(
        carePlanOutput({
          recipes: [
            { day: 1, meal: 'lunch', recipeId: 'r-fish' },
            { day: 1, meal: 'lunch', recipeId: 'r-fish' },
          ],
        }),
        input,
      ),
    ).toEqual(['library_ref']);
    expect(
      validateCarePlan(
        carePlanOutput({ exercises: [{ exerciseId: 'x-run', frequencyPerWeek: 3, minutes: 20 }] }),
        input,
      ),
    ).toEqual(['library_ref']);
  });

  it('运动安全规则：选了运动动作拦下，放松练习可以', () => {
    const input = planInput({ exerciseRestriction: '有危急指标' });
    expect(validateCarePlan(carePlanOutput(), input)).toContain('exercise_restricted');
    expect(
      validateCarePlan(
        carePlanOutput({
          exercises: [{ exerciseId: 'x-breath', frequencyPerWeek: 7, minutes: 5 }],
        }),
        input,
      ),
    ).not.toContain('exercise_restricted');
  });

  it('心理危机：可以不写心理部分；渲染时去掉心理部分和放松练习，专业版置顶危机提示', () => {
    const input = planInput();
    const crisis = carePlanOutput({
      crisisSignal: true,
      sections: carePlanOutput().sections.filter((s) => s.section !== 'mind'),
    });
    expect(validateCarePlan(crisis, input)).toEqual([]);
    const rendered = carePlan.render(carePlanOutput({ crisisSignal: true }), input);
    const structured = rendered.structured as ReturnType<typeof carePlanStructured>;
    expect(structured.sections.map((s) => s.section)).toEqual(['diet', 'exercise']);
    expect(structured.exercises.map((x) => x.exerciseId)).toEqual(['x-walk']);
    expect(rendered.professional.startsWith('## 心理危机提示')).toBe(true);
    // 只选了心理又有危机：留一句转给健管师的话，方案不为空
    const mindOnly = planInput({ options: { sections: ['mind'], cycleWeeks: 8 } });
    const onlyMind = carePlanStructured(
      carePlanOutput({ crisisSignal: true, sections: [], recipes: [], exercises: [] }),
      mindOnly,
    );
    expect(onlyMind.sections).toHaveLength(1);
    expect(onlyMind.sections[0]!.clientFacing).toContain('健管师');
  });

  it('渲染：结构化内容按部分和日期排好；通俗版写库里的做法，注意事项只在专业版', () => {
    const rendered = carePlan.render(carePlanOutput(), planInput());
    const structured = rendered.structured as ReturnType<typeof carePlanStructured>;
    expect(structured.recipes.map((r) => r.recipeId)).toEqual(['r-oat', 'r-fish']);
    expect(structured.sections[0]!.goals).toEqual([
      { templateId: 'g-veg', params: { portions: 4 } },
    ]);
    expect(rendered.clientFacing).toContain('每天吃蔬菜 4 份');
    expect(rendered.clientFacing).toContain('燕麦加水煮 5 分钟');
    expect(rendered.clientFacing).toContain('健步走：每周 3 次，每次约 20 分钟');
    expect(rendered.clientFacing).toContain('**放松练习**');
    expect(rendered.clientFacing).not.toContain('胸闷');
    expect(rendered.professional).toContain('近期胸闷的客户先请医生评估');
    expect(rendered.professional).toContain('周期：8 周');
  });

  it('措辞检查：通俗版的判断、分层、孪生颜色和功效承诺，方案里的药名都拦下', () => {
    const input = planInput();
    expect(carePlan.checkOutput!(carePlanOutput(), input)).toEqual([]);
    const bad = carePlanOutput();
    bad.sections[0] = {
      ...bad.sections[0]!,
      clientFacing: '您属于高风险人群，孪生已经变成黄色，坚持下去可以降血糖。',
    };
    bad.sections[1] = { ...bad.sections[1]!, professional: '提醒客户按时服用二甲双胍。' };
    const categories = new Set(carePlan.checkOutput!(bad, input).map((i) => i.category));
    for (const c of ['judgment', 'risk_tier', 'twin_term', 'efficacy_claim', 'drug_name']) {
      expect(categories.has(c as never), c).toBe(true);
    }
  });

  it('带 /方案生成 的计划也带方案选项条', () => {
    for (const s of skillSummaries()) {
      if (s.planSkills.includes('care-plan')) expect(s.usesPlanOptions).toBe(true);
    }
  });
});
