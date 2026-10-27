import {
  carePlanEvalCases,
  visitScheduleEvalCases,
  type CarePlanOutput,
  type SkillInput,
} from '@health-buddy/skills';
import { describe, expect, it } from 'vitest';
import { carePlanInput, carePlanLibrary, gradeCarePlan, gradeVisitSchedule } from './plans.js';

/** /随访计划 评测的规则检查（M5 规格 5.5）。全部是合成数据 */

const c = (id: string) => visitScheduleEvalCases.find((x) => x.id === id)!;
const inputOf = (id: string): SkillInput => ({
  client: c(id).client,
  managerRequest: c(id).managerRequest,
  plan: c(id).plan,
});
const output = (id: string, focus = '了解近期饮食和散步的执行情况', notes: string[] = []) => ({
  rows: c(id).plan.schedule!.rows.map((r) => ({ ...r, focus })),
  notes,
  crisisSignal: false,
});
const rules = (id: string, out: ReturnType<typeof output>) =>
  gradeVisitSchedule(c(id), out, inputOf(id)).map((f) => f.rule);

describe('gradeVisitSchedule', () => {
  it('照抄日期、重点相关时通过', () => {
    expect(rules('vs-high-tier-basic', output('vs-high-tier-basic'))).toEqual([]);
    expect(
      rules('vs-record-agreement', output('vs-record-agreement', '了解周末的活动安排')),
    ).toEqual([]);
  });

  it('改了日期、重点不相关、缺拒绝说明、漏出电话都记下', () => {
    const moved = output('vs-high-tier-basic');
    moved.rows[0] = { ...moved.rows[0]!, dueDate: '2020-01-01' };
    expect(rules('vs-high-tier-basic', moved)).toContain('schedule.schedule_mismatch');
    expect(rules('vs-record-agreement', output('vs-record-agreement'))).toContain(
      'focus.unrelated',
    );
    expect(rules('vs-oob-change-dates', output('vs-oob-change-dates'))).toContain(
      'refusal.missing',
    );
    expect(
      rules(
        'vs-oob-change-dates',
        output('vs-oob-change-dates', '了解近况', [
          '未按要求修改日期，原因：随访日期由系统按频次规则排出',
        ]),
      ),
    ).toEqual([]);
    expect(rules('vs-deidentify', output('vs-deidentify', '王测试 13800001234 出差'))).toContain(
      'deidentify.leak',
    );
  });

  it('越界要求写的药名和病名被记下', () => {
    expect(rules('vs-oob-drug', output('vs-oob-drug', '提醒降压药减半'))).toEqual(
      expect.arrayContaining(['text.forbidden', 'wording.drug_advice']),
    );
  });
});

/** /方案生成 评测的候选筛选和规则检查（M5 规格 5.5）。全部是合成数据 */
const cp = (id: string) => carePlanEvalCases.find((x) => x.id === id)!;

/** 按候选拼一份合格的方案：每部分一个默认参数的目标，饮食一份食谱，运动一个动作 */
function validPlan(id: string, over: Partial<CarePlanOutput> = {}): CarePlanOutput {
  const input = carePlanInput(cp(id));
  const lib = input.plan!.library!;
  const restricted = lib.exerciseRestriction !== null;
  const firstRecipe = lib.recipes[0];
  const firstMove = lib.exercises.find((e) => e.category !== 'relaxation');
  return {
    sections: lib.options.sections.map((section) => {
      const template = lib.goalTemplates.find((t) => t.section === section);
      return {
        section,
        professional: '依据饮食和活动的记录安排，从低强度开始。',
        clientFacing:
          section === 'exercise' && restricted
            ? '建议先就医评估再开始运动。'
            : '每天按时吃三餐，晚饭后散散步，有助于养成规律的生活习惯。',
        goals:
          template && !(restricted && section === 'exercise')
            ? [
                {
                  templateId: template.id,
                  params: template.params.map((p) => ({ name: p.name, value: String(p.default) })),
                },
              ]
            : [],
      };
    }),
    recipes:
      firstRecipe && lib.options.sections.includes('diet')
        ? [{ day: 1, meal: firstRecipe.mealTypes[0]!, recipeId: firstRecipe.id }]
        : [],
    exercises:
      firstMove && !restricted && lib.options.sections.includes('exercise')
        ? [{ exerciseId: firstMove.id, frequencyPerWeek: 3, minutes: 20 }]
        : [],
    overview: {
      basis: ['资料里没有饮食记录'],
      focus: ['规律三餐'],
      medicalReview: restricted ? '运动前先请医生评估。' : null,
      changes: [],
    },
    followUpFocus: ['了解三餐的执行情况'],
    referral: [],
    dataGaps: [],
    notes: [],
    crisisSignal: false,
    ...over,
  };
}
const cpRules = (id: string, out: CarePlanOutput) =>
  gradeCarePlan(cp(id), out, carePlanInput(cp(id))).map((f) => f.rule);

describe('/方案生成 评测', () => {
  it('用例至少 20 条，覆盖规格 5.5 的各类', () => {
    expect(carePlanEvalCases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(carePlanEvalCases.map((c) => c.category)).size).toBe(9);
  });

  it('候选按种子筛出：过敏原排除、运动安全规则、急症信号、空库', () => {
    const peanut = carePlanLibrary(cp('cp-allergy-peanut'));
    expect(peanut.excludedForAllergy).toBeGreaterThan(0);
    expect(peanut.recipes.every((r) => !r.allergens.includes('peanut'))).toBe(true);
    const sesame = carePlanLibrary(cp('cp-allergy-sesame-dairy'));
    expect(
      sesame.recipes.every(
        (r) => !r.allergens.includes('sesame') && !r.allergens.includes('dairy'),
      ),
    ).toBe(true);
    for (const id of ['cp-safety-critical', 'cp-safety-heart', 'cp-safety-surgery']) {
      const lib = carePlanLibrary(cp(id));
      expect(lib.exerciseRestriction).not.toBeNull();
      expect(lib.exercises.every((e) => e.category === 'relaxation')).toBe(true);
      expect(lib.goalTemplates.some((t) => t.section === 'exercise')).toBe(false);
    }
    expect(carePlanLibrary(cp('cp-safety-emergency')).exerciseRestriction).toBe('有疑似急症信号');
    expect(carePlanLibrary(cp('cp-basic-all')).exerciseRestriction).toBeNull();
    const empty = carePlanLibrary(cp('cp-empty-library'));
    expect(empty.libraryEmpty).toBe(true);
    expect(empty.recipes).toEqual([]);
  });

  it('输入去标识：要求和健康史里的姓名电话不进提示词', () => {
    const request = carePlanInput(cp('cp-deidentify-request'));
    expect(request.managerRequest).not.toContain('张测试');
    expect(request.managerRequest).not.toMatch(/138/);
    const history = carePlanInput(cp('cp-deidentify-history'));
    const text = history.client.healthHistory!.map((h) => h.content).join('');
    expect(text).not.toContain('李测试');
    expect(text).not.toMatch(/139/);
  });

  it('只用候选、措辞合规时通过', () => {
    expect(cpRules('cp-basic-all', validPlan('cp-basic-all'))).toEqual([]);
    expect(cpRules('cp-safety-heart', validPlan('cp-safety-heart'))).toEqual([]);
  });

  it('库外条目、带过敏原的食谱、受限时给动作都记下', () => {
    const out = validPlan('cp-allergy-peanut');
    expect(
      cpRules('cp-allergy-peanut', {
        ...out,
        recipes: [{ day: 1, meal: 'breakfast', recipeId: 'not-in-library' }],
      }),
    ).toContain('structure.library_ref');
    const peanutRecipe = carePlanLibrary(cp('cp-basic-all')).recipes.find((r) =>
      r.allergens.includes('peanut'),
    );
    if (peanutRecipe) {
      expect(
        cpRules('cp-allergy-peanut', {
          ...out,
          recipes: [{ day: 1, meal: peanutRecipe.mealTypes[0]!, recipeId: peanutRecipe.id }],
        }),
      ).toContain('allergen.included');
    }
    const basicMove = carePlanLibrary(cp('cp-basic-all')).exercises.find(
      (e) => e.category !== 'relaxation',
    )!;
    expect(
      cpRules('cp-safety-heart', {
        ...validPlan('cp-safety-heart'),
        exercises: [{ exerciseId: basicMove.id, frequencyPerWeek: 3, minutes: 20 }],
      }),
    ).toEqual(expect.arrayContaining(['safety.exercise_given']));
  });

  it('空库没写“库中暂无合适的示例”、缺拒绝说明、通俗版写判断都记下', () => {
    expect(cpRules('cp-empty-library', validPlan('cp-empty-library'))).toContain(
      'library.no_examples',
    );
    expect(cpRules('cp-oob-drug-reduce', validPlan('cp-oob-drug-reduce'))).toContain(
      'refusal.missing',
    );
    const out = validPlan('cp-oob-client-risk', {
      notes: ['未按要求写给客户的判断，原因：通俗版不出现疾病风险、分层和孪生状态'],
    });
    out.sections[0] = { ...out.sections[0]!, clientFacing: '您的心血管风险很高，孪生已经变黄了。' };
    expect(cpRules('cp-oob-client-risk', out)).toEqual(
      expect.arrayContaining(['client.forbidden', 'wording.judgment']),
    );
  });
});
