import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defaultGoalParams,
  renderGoal,
  type ExerciseContent,
  type RecipeContent,
} from '@health-buddy/shared';
import {
  exerciseContentIssues,
  goalTemplateContentIssues,
  libraryContentIssues,
  loadPlanLibrarySeed,
  missingAllergenTags,
  recipeContentIssues,
} from './index.js';

/** 构建时检查（M5 规格 4.2、验收第 11 条）：种子文件每一条都要通过，CI 的 pnpm test 会跑 */
describe('plan library seed', () => {
  const seed = loadPlanLibrarySeed();

  it('has the seed scope from the spec (about 60 recipes, 30 exercises, 25 goal templates)', () => {
    expect(seed.recipes.length).toBeGreaterThanOrEqual(55);
    expect(seed.exercises.length).toBeGreaterThanOrEqual(28);
    expect(seed.goalTemplates.length).toBeGreaterThanOrEqual(25);
    const meals = (m: string) => seed.recipes.filter((r) => r.mealTypes.includes(m as never));
    expect(meals('breakfast').length).toBeGreaterThanOrEqual(15);
    expect(meals('lunch').length).toBeGreaterThanOrEqual(18);
    expect(meals('dinner').length).toBeGreaterThanOrEqual(18);
    expect(meals('snack').length).toBeGreaterThanOrEqual(9);
    for (const section of ['diet', 'exercise', 'routine', 'mind'] as const) {
      expect(seed.goalTemplates.some((g) => g.section === section)).toBe(true);
    }
    for (const category of ['aerobic', 'strength', 'flexibility', 'balance', 'relaxation']) {
      expect(seed.exercises.filter((e) => e.category === category).length).toBeGreaterThan(3);
    }
  });

  it('uses unique codes across each library', () => {
    for (const items of [seed.recipes, seed.exercises, seed.goalTemplates]) {
      const codes = items.map((i) => i.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('passes the banned-term, disease, drug and efficacy checks', () => {
    for (const r of seed.recipes) expect(recipeContentIssues(r), r.code).toEqual([]);
    for (const e of seed.exercises) expect(exerciseContentIssues(e), e.code).toEqual([]);
    for (const g of seed.goalTemplates) expect(goalTemplateContentIssues(g), g.code).toEqual([]);
  });

  it('writes the allergens of every recipe explicitly and does not miss obvious ones', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../seed/recipes.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>[];
    for (const r of raw) expect(Object.hasOwn(r, 'allergens'), String(r.code)).toBe(true);
    for (const r of seed.recipes) expect(missingAllergenTags(r), r.code).toEqual([]);
  });

  it('gives every exercise a manager caution', () => {
    for (const e of seed.exercises)
      expect(e.managerCautions.trim().length, e.code).toBeGreaterThan(5);
  });

  it('renders every goal template with its default params', () => {
    for (const g of seed.goalTemplates) {
      const text = renderGoal(g, defaultGoalParams(g.params));
      expect(text, g.code).not.toMatch(/[{}]/);
    }
    // 执行情况只看步数和睡眠时长（Q10），两个都要有模板
    expect(
      seed.goalTemplates
        .filter((g) => g.metric)
        .map((g) => g.metric)
        .sort(),
    ).toEqual(['sleep_hours', 'steps']);
  });

  it('does not use brand names or supplements in recipes', () => {
    const banned = ['保健品', '代餐', '膳食补充剂', '蛋白粉', '鱼油'];
    for (const r of seed.recipes) {
      const text = JSON.stringify(r);
      for (const b of banned) expect(text.includes(b), `${r.code}: ${b}`).toBe(false);
    }
  });
});

describe('library content check', () => {
  const recipe: RecipeContent = {
    code: 'x-recipe',
    name: '杂粮饭',
    mealTypes: ['lunch'],
    ingredients: [
      { name: '糙米', householdAmount: '一小把', grams: null, overseasAlternative: null },
    ],
    steps: ['煮熟'],
    nutritionPerServing: null,
    nutritionBasis: null,
    tags: [],
    allergens: [],
    sourceNote: '平台初稿',
  };
  const exercise: ExerciseContent = {
    code: 'x-exercise',
    name: '健步走',
    category: 'aerobic',
    intensity: 'moderate',
    setting: ['outdoor'],
    equipment: [],
    steps: ['快走'],
    keyPoints: ['抬头挺胸'],
    commonMistakes: [],
    managerCautions: '心脏病、近期手术的客户先请医生评估',
    met: null,
    sourceNote: '平台初稿',
  };

  it('flags banned terms, disease names, drugs and efficacy claims with their position', () => {
    const issues = recipeContentIssues({
      ...recipe,
      name: '降血糖杂粮饭',
      steps: ['煮熟', '适合糖尿病的人', '配二甲双胍', '可以根治'],
    });
    expect(issues).toEqual([
      { path: 'name', term: '降血糖', index: 0 },
      { path: 'steps.1', term: '糖尿病', index: 2 },
      { path: 'steps.2', term: '二甲双胍', index: 1 },
      { path: 'steps.3', term: '根治', index: 2 },
    ]);
  });

  it('catches obfuscated spellings', () => {
    expect(recipeContentIssues({ ...recipe, name: '护 肝·汤' }).map((i) => i.term)).toEqual([
      '护肝',
    ]);
  });

  it('checks ingredients and overseas alternatives', () => {
    const issues = recipeContentIssues({
      ...recipe,
      ingredients: [
        { name: '苦瓜', householdAmount: '半根', grams: null, overseasAlternative: '能降糖的瓜' },
      ],
    });
    expect(issues.map((i) => i.path)).toEqual(['ingredients.0.overseasAlternative']);
  });

  it('allows disease names in manager cautions but not banned terms', () => {
    expect(exerciseContentIssues(exercise)).toEqual([]);
    expect(
      exerciseContentIssues({ ...exercise, managerCautions: '先去医院诊断' }).map((i) => i.path),
    ).toEqual(['managerCautions']);
    expect(
      exerciseContentIssues({ ...exercise, keyPoints: ['燃脂效果好'] }).map((i) => i.term),
    ).toEqual(['燃脂']);
  });

  it('checks goal template text and units', () => {
    const g = {
      code: 'x-goal',
      section: 'exercise' as const,
      text: '每天步行 {steps} 步，保证见效',
      params: [{ name: 'steps', type: 'int' as const, min: 1, max: 2, default: 1, unit: '步' }],
      metric: null,
      metricParam: null,
      sourceNote: '平台初稿',
    };
    expect(libraryContentIssues('goal_template', g).map((i) => i.term)).toEqual(['保证', '见效']);
  });

  it('reports allergens the ingredient names suggest but the tags miss', () => {
    expect(
      missingAllergenTags({
        ingredients: [
          { name: '鸡蛋', householdAmount: '一个', grams: null, overseasAlternative: null },
          { name: '生抽', householdAmount: '一小勺', grams: null, overseasAlternative: null },
        ],
        allergens: ['egg'],
        steps: ['煮熟'],
      }),
    ).toEqual(['soy', 'gluten']);
    // 做法里的酱油、海外替代里的豆奶也算；“两面煎熟”不算面食
    expect(
      missingAllergenTags({
        ingredients: [
          { name: '水饺', householdAmount: '十个', grams: null, overseasAlternative: null },
          { name: '牛奶', householdAmount: '一杯', grams: null, overseasAlternative: '无糖豆奶' },
        ],
        allergens: ['gluten', 'dairy'],
        steps: ['蘸酱油吃', '两面煎熟'],
      }).sort(),
    ).toEqual(['soy']);
    expect(
      missingAllergenTags({
        ingredients: [
          { name: '三文鱼', householdAmount: '一掌心', grams: null, overseasAlternative: null },
        ],
        allergens: ['seafood'],
        steps: ['翻面再煎 2 分钟'],
      }),
    ).toEqual([]);
  });
});
