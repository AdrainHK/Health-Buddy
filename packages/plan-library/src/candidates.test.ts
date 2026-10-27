import { PLAN_SECTIONS } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATES_MAX,
  allergyTextsOf,
  exerciseRestriction,
  restrictExercise,
  seedCandidatePool,
  selectPlanCandidates,
} from './candidates.js';
import { loadPlanLibrarySeed } from './seed.js';

/** /方案生成 的候选筛选（M5 规格 5.2、Q8、Q16）。确定性代码，用种子内容测 */
const pool = seedCandidatePool(loadPlanLibrarySeed());
const all = { sections: [...PLAN_SECTIONS], cycleWeeks: 8 as const };

describe('selectPlanCandidates', () => {
  it('全选时食谱、动作、目标模板都有，每个餐次不超过 40 条', () => {
    const lib = selectPlanCandidates(pool, { options: all, allergyTexts: [], restriction: null });
    expect(lib.recipes.length).toBeGreaterThan(0);
    expect(lib.exercises.length).toBeGreaterThan(0);
    expect(lib.exercises.length).toBeLessThanOrEqual(CANDIDATES_MAX);
    expect(new Set(lib.goalTemplates.map((t) => t.section))).toEqual(new Set(PLAN_SECTIONS));
    expect(lib.libraryEmpty).toBe(false);
    expect(lib.excludedForAllergy).toBe(0);
  });

  it('过敏史排除带对应过敏原的食谱（芝麻、海鲜），并记下数量', () => {
    const lib = selectPlanCandidates(pool, {
      options: all,
      allergyTexts: ['芝麻过敏', '吃虾会起疹子'],
      restriction: null,
    });
    expect(lib.excludedForAllergy).toBeGreaterThan(0);
    for (const r of lib.recipes) {
      expect(r.allergens).not.toContain('sesame');
      expect(r.allergens).not.toContain('seafood');
    }
  });

  it('只选作息：没有食谱和动作，目标模板只有作息', () => {
    const lib = selectPlanCandidates(pool, {
      options: { sections: ['routine'], cycleWeeks: 4 },
      allergyTexts: [],
      restriction: null,
    });
    expect(lib.recipes).toEqual([]);
    expect(lib.exercises).toEqual([]);
    expect(lib.goalTemplates.every((t) => t.section === 'routine')).toBe(true);
  });

  it('只选心理：只有放松练习', () => {
    const lib = selectPlanCandidates(pool, {
      options: { sections: ['mind'], cycleWeeks: 8 },
      allergyTexts: [],
      restriction: null,
    });
    expect(lib.exercises.length).toBeGreaterThan(0);
    expect(lib.exercises.every((e) => e.category === 'relaxation')).toBe(true);
  });

  it('运动安全规则：去掉运动动作和运动目标；急症信号同样处理', () => {
    const lib = selectPlanCandidates(pool, {
      options: all,
      allergyTexts: [],
      restriction: '有危急指标',
    });
    expect(lib.exerciseRestriction).toBe('有危急指标');
    expect(lib.exercises.every((e) => e.category === 'relaxation')).toBe(true);
    expect(lib.goalTemplates.some((t) => t.section === 'exercise')).toBe(false);
    const open = selectPlanCandidates(pool, { options: all, allergyTexts: [], restriction: null });
    const later = restrictExercise(open, '有疑似急症信号');
    expect(later.exercises.map((e) => e.id)).toEqual(lib.exercises.map((e) => e.id));
    expect(later.exerciseRestriction).toBe('有疑似急症信号');
  });

  it('库为空时标出 libraryEmpty', () => {
    const lib = selectPlanCandidates(
      { recipes: [], exercises: [], goalTemplates: [] },
      { options: all, allergyTexts: [], restriction: null },
    );
    expect(lib.libraryEmpty).toBe(true);
  });
});

describe('exerciseRestriction', () => {
  const base = {
    ageBand: '50-59',
    gender: 'male' as const,
    monitoring: [],
    latestReport: null,
    criticalFlags: [],
  };

  it('健康史里有心脏、手术、骨关节记录时限制；家族史不算', () => {
    expect(exerciseRestriction(base)).toBeNull();
    expect(
      exerciseRestriction({
        ...base,
        healthHistory: [{ category: 'past_history', content: '冠心病，放过支架' }],
      }),
    ).not.toBeNull();
    expect(
      exerciseRestriction({
        ...base,
        healthHistory: [{ category: 'past_history', content: '上个月做完膝关节置换' }],
      }),
    ).not.toBeNull();
    expect(
      exerciseRestriction({
        ...base,
        healthHistory: [{ category: 'family_history', content: '父亲有冠心病' }],
      }),
    ).toBeNull();
  });

  it('过敏史只取过敏类', () => {
    expect(
      allergyTextsOf({
        ...base,
        healthHistory: [
          { category: 'allergy', content: '花生过敏' },
          { category: 'lifestyle', content: '爱吃芝麻酱' },
        ],
      }),
    ).toEqual(['花生过敏']);
  });
});
