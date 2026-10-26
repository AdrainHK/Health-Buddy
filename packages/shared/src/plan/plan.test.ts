import { describe, expect, it } from 'vitest';
import { adherence } from './adherence.js';
import { allergenConflicts, allergensInHistory } from './allergens.js';
import { addDaysIso, dateInTimeZone, isoWeekday, shiftWeekendToMonday } from './dates.js';
import {
  GoalParamError,
  defaultGoalParams,
  goalTemplateContentSchema,
  goalTemplateShapeError,
  recipeContentSchema,
  renderGoal,
  validateGoalParams,
  type GoalParam,
} from './library.js';
import {
  DEFAULT_VISIT_FREQUENCY_RULES,
  scheduleVisits,
  type ScheduleVisitsInput,
} from './visit-schedule.js';

/** 2026-10-26 是周一；北京时间上午 10 点 */
const MONDAY = new Date('2026-10-26T02:00:00Z');
const SH = 'Asia/Shanghai';

const base = (over: Partial<ScheduleVisitsInput> = {}): ScheduleVisitsInput => ({
  now: MONDAY,
  timeZone: SH,
  riskTier: 'high',
  rules: DEFAULT_VISIT_FREQUENCY_RULES,
  planReviewDate: null,
  hasUrgentFollowUp: false,
  ...over,
});
const brief = (input: ScheduleVisitsInput) =>
  scheduleVisits(input).visits.map((v) => `${v.dueDate} ${v.purpose} ${v.method}`);

describe('日期工具', () => {
  it('周末顺延到周一，工作日不变', () => {
    expect(isoWeekday('2026-10-26')).toBe(1);
    expect(shiftWeekendToMonday('2026-10-31')).toBe('2026-11-02');
    expect(shiftWeekendToMonday('2026-11-01')).toBe('2026-11-02');
    expect(shiftWeekendToMonday('2026-10-30')).toBe('2026-10-30');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('按时区取日历日', () => {
    const at = new Date('2026-10-25T20:00:00Z');
    expect(dateInTimeZone(at, SH)).toBe('2026-10-26');
    expect(dateInTimeZone(at, 'America/Los_Angeles')).toBe('2026-10-25');
  });
});

describe('scheduleVisits（第五节之二）', () => {
  it('高风险：每 14 天一次，没有方案时排 12 周，默认电话', () => {
    const r = scheduleVisits(base());
    expect(r.today).toBe('2026-10-26');
    expect(r.horizonEnd).toBe('2027-01-18');
    expect(r.visits.map((v) => v.dueDate)).toEqual([
      '2026-11-09',
      '2026-11-23',
      '2026-12-07',
      '2026-12-21',
      '2027-01-04',
      '2027-01-18',
    ]);
    expect(new Set(r.visits.map((v) => `${v.purpose} ${v.method}`))).toEqual(
      new Set(['routine phone']),
    );
  });

  it('中风险 30 天；未分层按 30 天；落在周末的顺延到周一', () => {
    expect(brief(base({ riskTier: 'medium' }))).toEqual([
      '2026-11-25 routine phone',
      '2026-12-25 routine phone',
    ]);
    expect(brief(base({ riskTier: null }))).toEqual(brief(base({ riskTier: 'medium' })));
    // 周四起算：30 天后是周六 → 下周一
    const thu = new Date('2026-10-29T02:00:00Z');
    expect(brief(base({ riskTier: 'medium', now: thu }))[0]).toBe('2026-11-30 routine phone');
  });

  it('低风险 90 天：12 周内排不出时至少保留第一次（周日顺延到周一），方式微信', () => {
    expect(brief(base({ riskTier: 'low' }))).toEqual(['2027-01-25 routine wechat']);
  });

  it('有 1、2 级未处理跟进项：第一次是不晚于 3 天后的跟进项回访，之后从这一天按间隔排', () => {
    expect(brief(base({ riskTier: 'medium', hasUrgentFollowUp: true }))).toEqual([
      '2026-10-29 follow_up phone',
      '2026-11-30 routine phone',
      '2026-12-28 routine phone',
    ]);
    // 周四：3 天内是周五、周六、周日，取最晚的工作日周五
    const thu = new Date('2026-10-29T02:00:00Z');
    expect(brief(base({ now: thu, hasUrgentFollowUp: true }))[0]).toBe(
      '2026-10-30 follow_up phone',
    );
    // 周五、规则改成 1 天：明天是周六，没有工作日，顺延到周一
    const fri = new Date('2026-10-30T02:00:00Z');
    const rules = { ...DEFAULT_VISIT_FREQUENCY_RULES, firstVisitWithinDays: 1 };
    expect(brief(base({ now: fri, rules, hasUrgentFollowUp: true }))[0]).toBe(
      '2026-11-02 follow_up phone',
    );
  });

  it('有方案：排到复评日期为止，那天是方案复评', () => {
    expect(brief(base({ riskTier: 'medium', planReviewDate: '2026-12-21' }))).toEqual([
      '2026-11-25 routine phone',
      '2026-12-21 plan_review phone',
    ]);
    expect(scheduleVisits(base({ planReviewDate: '2026-12-21' })).horizonEnd).toBe('2026-12-21');
  });

  it('和复评相隔不到 7 天的常规随访合并为一次；同一天的也合并', () => {
    // 高风险：12-21 的常规随访和 12-24 的复评相隔 3 天 → 合并
    expect(brief(base({ planReviewDate: '2026-12-24' }))).toEqual([
      '2026-11-09 routine phone',
      '2026-11-23 routine phone',
      '2026-12-07 routine phone',
      '2026-12-24 plan_review phone',
    ]);
    const sameDay = brief(base({ planReviewDate: '2026-12-21' }));
    expect(sameDay.at(-1)).toBe('2026-12-21 plan_review phone');
    expect(sameDay.filter((v) => v.startsWith('2026-12-21'))).toHaveLength(1);
  });

  it('复评日期落在周末顺延到周一；复评日期已过按没有方案处理', () => {
    expect(brief(base({ riskTier: 'medium', planReviewDate: '2026-12-26' })).at(-1)).toBe(
      '2026-12-28 plan_review phone',
    );
    expect(brief(base({ planReviewDate: '2026-10-01' }))).toEqual(brief(base()));
  });

  it('“今天”按健管师时区算', () => {
    const at = new Date('2026-10-25T20:00:00Z');
    const sh = scheduleVisits(base({ now: at, riskTier: 'medium' }));
    const la = scheduleVisits(
      base({ now: at, riskTier: 'medium', timeZone: 'America/Los_Angeles' }),
    );
    expect(sh.today).toBe('2026-10-26');
    expect(la.today).toBe('2026-10-25');
    expect(sh.visits[0]?.dueDate).toBe('2026-11-25');
    expect(la.visits[0]?.dueDate).toBe('2026-11-24');
  });

  it('日期都不早于今天、不超过 6 个月后，升序且不重复', () => {
    for (const riskTier of ['high', 'medium', 'low', null] as const) {
      for (const hasUrgentFollowUp of [true, false]) {
        const r = scheduleVisits(
          base({ riskTier, hasUrgentFollowUp, planReviewDate: '2027-01-18' }),
        );
        const dates = r.visits.map((v) => v.dueDate);
        expect([...dates].sort()).toEqual(dates);
        expect(new Set(dates).size).toBe(dates.length);
        for (const d of dates) {
          expect(d >= r.today && d <= '2027-04-26').toBe(true);
          expect(isoWeekday(d)).toBeLessThan(6);
        }
      }
    }
  });

  it('规则超出范围时拒绝', () => {
    const rules = {
      ...DEFAULT_VISIT_FREQUENCY_RULES,
      tiers: {
        ...DEFAULT_VISIT_FREQUENCY_RULES.tiers,
        high: { intervalDays: 3, defaultMethod: 'phone' as const },
      },
    };
    expect(() => scheduleVisits(base({ rules }))).toThrow();
  });
});

describe('allergenConflicts（Q16）', () => {
  const items = [
    { id: 'r-peanut', allergens: ['peanut' as const] },
    { id: 'r-shrimp', allergens: ['seafood' as const, 'egg' as const] },
    { id: 'r-plain', allergens: [] },
  ];

  it('按关键词匹配过敏史和条目的过敏原标签', () => {
    expect(allergenConflicts(['花生过敏，吃后起皮疹'], items)).toEqual([
      { itemId: 'r-peanut', allergen: 'peanut', keyword: '花生' },
    ]);
    expect(allergenConflicts(['对虾、蟹过敏'], items).map((c) => c.itemId)).toEqual(['r-shrimp']);
    expect(allergenConflicts(['Allergic to SHRIMP'], items).map((c) => c.itemId)).toEqual([
      'r-shrimp',
    ]);
    // 多条过敏史、多种过敏原
    expect(
      allergenConflicts(['花生', '鸡蛋'], items).map((c) => `${c.itemId}:${c.allergen}`),
    ).toEqual(['r-peanut:peanut', 'r-shrimp:egg']);
  });

  it('没有过敏、明确写“无过敏史”时没有冲突；不认识的过敏原不匹配', () => {
    expect(allergenConflicts([], items)).toEqual([]);
    expect(allergenConflicts(['无过敏史'], items)).toEqual([]);
    expect(allergenConflicts(['否认药物食物过敏史。'], items)).toEqual([]);
    expect(allergenConflicts(['青霉素过敏'], items)).toEqual([]);
  });

  it('从严：否定句也算匹配（宁可多提示一次）', () => {
    expect(allergensInHistory(['对花生不过敏，但对芒果过敏'])).toEqual([
      { allergen: 'peanut', keyword: '花生' },
    ]);
  });
});

describe('目标模板和 renderGoal', () => {
  const steps: GoalParam[] = [
    { name: 'steps', type: 'int', min: 4000, max: 10000, default: 6000, unit: '步' },
  ];
  const bedtime: GoalParam[] = [
    { name: 'time', type: 'time', min: '21:00', max: '24:00', default: '23:00' },
  ];

  it('模板 + 参数 → 文字', () => {
    expect(renderGoal({ text: '每天步行 {steps} 步', params: steps }, { steps: 8000 })).toBe(
      '每天步行 8000 步',
    );
    expect(renderGoal({ text: '每晚 {time} 前上床', params: bedtime }, { time: '22:30' })).toBe(
      '每晚 22:30 前上床',
    );
    expect(
      renderGoal({ text: '每晚 {time} 前上床', params: bedtime }, defaultGoalParams(bedtime)),
    ).toBe('每晚 23:00 前上床');
  });

  it('超出范围、类型不对、缺少或多余的参数都被拒绝，不会渲染', () => {
    expect(validateGoalParams(steps, { steps: 12000 })).toEqual([
      { param: 'steps', reason: 'out_of_range' },
    ]);
    expect(validateGoalParams(steps, { steps: 6000.5 })).toEqual([
      { param: 'steps', reason: 'wrong_type' },
    ]);
    expect(validateGoalParams(steps, {})).toEqual([{ param: 'steps', reason: 'missing' }]);
    expect(validateGoalParams(steps, { steps: 6000, kcal: 1 })).toEqual([
      { param: 'kcal', reason: 'unknown' },
    ]);
    expect(validateGoalParams(bedtime, { time: '20:59' })).toEqual([
      { param: 'time', reason: 'out_of_range' },
    ]);
    expect(validateGoalParams(bedtime, { time: '25:00' })).toEqual([
      { param: 'time', reason: 'wrong_type' },
    ]);
    expect(validateGoalParams(bedtime, { time: '24:00' })).toEqual([]);
    expect(() =>
      renderGoal({ text: '每天步行 {steps} 步', params: steps }, { steps: 3000 }),
    ).toThrow(GoalParamError);
  });

  it('模板形状：占位符和参数一一对应、默认值在范围内、关联指标必须指明目标参数', () => {
    const shape = {
      text: '每天步行 {steps} 步',
      params: steps,
      metric: 'steps' as const,
      metricParam: 'steps',
    };
    expect(goalTemplateShapeError(shape)).toBeNull();
    expect(goalTemplateShapeError({ ...shape, text: '每天步行 {step} 步' })).toMatch(
      /placeholders/,
    );
    expect(goalTemplateShapeError({ ...shape, text: '每天步行 {steps} 步 {' })).toMatch(/brace/);
    expect(goalTemplateShapeError({ ...shape, metricParam: null })).toMatch(/metric/);
    expect(
      goalTemplateShapeError({ ...shape, params: [{ ...steps[0]!, default: 3000 } as GoalParam] }),
    ).toMatch(/default/);
    expect(
      goalTemplateShapeError({
        text: '每晚 {time} 前上床',
        params: bedtime,
        metric: 'sleep_hours',
        metricParam: 'time',
      }),
    ).toMatch(/int param/);
    expect(
      goalTemplateContentSchema.safeParse({
        code: 'walk-daily',
        section: 'exercise',
        sourceNote: '待顾问审定',
        ...shape,
      }).success,
    ).toBe(true);
  });

  it('食谱的过敏原必须显式填写；营养数据要写计算依据', () => {
    const recipe = {
      code: 'oat-porridge',
      name: '燕麦粥',
      mealTypes: ['breakfast'],
      ingredients: [{ name: '燕麦', householdAmount: '半碗' }],
      steps: ['加水煮开后小火煮 5 分钟'],
      nutritionPerServing: null,
      nutritionBasis: null,
      tags: ['high_fiber'],
      allergens: [],
      sourceNote: '合成测试条目',
    };
    expect(recipeContentSchema.safeParse(recipe).success).toBe(true);
    const noAllergens: Partial<typeof recipe> = { ...recipe };
    delete noAllergens.allergens;
    expect(recipeContentSchema.safeParse(noAllergens).success).toBe(false);
    expect(
      recipeContentSchema.safeParse({
        ...recipe,
        nutritionPerServing: {
          energyKcal: 150,
          proteinG: 5,
          fatG: 3,
          carbG: 27,
          fiberG: 4,
          sodiumMg: 5,
        },
      }).success,
    ).toBe(false);
    expect(recipeContentSchema.safeParse({ ...recipe, tags: ['适合糖尿病'] }).success).toBe(false);
  });
});

describe('adherence（2.6、Q10）', () => {
  const goals = [
    { key: 'g-steps', metric: 'steps' as const, target: 6000 },
    { key: 'g-sleep', metric: 'sleep_hours' as const, target: 7 },
  ];
  /** 北京时间第 n 天前晚上 9 点 */
  const daysAgo = (n: number, hour = 13) =>
    new Date(Date.UTC(2026, 9, 26 - n, hour, 0, 0)).toISOString();

  it('近 7 天、近 14 天的平均值和达标天数', () => {
    const readings = [
      ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({
        metric: 'steps',
        value: n % 2 === 0 ? 8000 : 4000,
        measuredAt: daysAgo(n),
      })),
      ...[7, 8, 9, 10, 11, 12, 13].map((n) => ({
        metric: 'steps',
        value: 10000,
        measuredAt: daysAgo(n),
      })),
      // 14 天以前的不算
      { metric: 'steps', value: 99999, measuredAt: daysAgo(14) },
    ];
    const [steps, sleep] = adherence({ now: MONDAY, timeZone: SH, goals, readings });
    expect(steps).toEqual({
      key: 'g-steps',
      metric: 'steps',
      target: 6000,
      hasData: true,
      windows: [
        { days: 7, daysWithData: 7, average: 6286, daysMet: 4 },
        { days: 14, daysWithData: 14, average: 8143, daysMet: 11 },
      ],
    });
    expect(sleep).toMatchObject({
      hasData: false,
      windows: [{ average: null, daysMet: 0 }, { average: null }],
    });
  });

  it('一天多条取最后一条；按健管师时区归日；不合理的数值不算', () => {
    const readings = [
      { metric: 'sleep_hours', value: 5, measuredAt: daysAgo(1, 0) },
      { metric: 'sleep_hours', value: 7.5, measuredAt: daysAgo(1, 1) },
      { metric: 'sleep_hours', value: -1, measuredAt: daysAgo(2) },
      { metric: 'sleep_hours', value: 6.25, measuredAt: daysAgo(3) },
      { metric: 'weight', value: 60, measuredAt: daysAgo(1) },
    ];
    const [, sleep] = adherence({ now: MONDAY, timeZone: SH, goals, readings });
    expect(sleep?.windows[0]).toEqual({ days: 7, daysWithData: 2, average: 6.9, daysMet: 1 });
    // 北京时间今天 00:30（UTC 前一天 16:30）算今天，不算昨天
    const late = [{ metric: 'steps', value: 7000, measuredAt: '2026-10-25T16:30:00Z' }];
    const [steps] = adherence({ now: MONDAY, timeZone: SH, goals, readings: late });
    expect(steps?.windows[0]).toMatchObject({ daysWithData: 1, daysMet: 1 });
    // 将来的读数不算
    const future = [{ metric: 'steps', value: 7000, measuredAt: '2026-10-28T02:00:00Z' }];
    expect(adherence({ now: MONDAY, timeZone: SH, goals, readings: future })[0]?.hasData).toBe(
      false,
    );
  });
});
