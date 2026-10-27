import {
  findBannedTerms,
  type ExerciseContent,
  type GoalTemplateContent,
  type LibraryContentRejection,
  type LibraryItemType,
  type RecipeContent,
} from '@health-buddy/shared';
import { checkLibraryText } from '@health-buddy/skills';

/**
 * 方案库条目的内容检查（M5 规格 2.4、4.2）。平台管理员保存时后端调用，种子文件在构建时（单元测试）调用，
 * 两边用同一份规则。
 *
 * - 面向客户的文字（名称、食材和家庭常用量、海外替代、做法、动作要点、常见错误、器材、目标模板文字）：
 *   禁用词、疾病名称、具体药名、功效承诺（checkLibraryText）。
 * - 只给健管师和后台看的文字（运动的注意事项、来源说明、营养计算依据）：只查禁用词。
 *   注意事项需要写“心脏病、近期手术先请医生评估”这类情况，不查疾病名称。
 *
 * 结果只有字段路径、命中的词和位置，不含原文。
 */
export type LibraryContentIssue = LibraryContentRejection['issues'][number];

type Field = [path: string, text: string, clientFacing: boolean];

function recipeFields(r: RecipeContent): Field[] {
  return [
    ['name', r.name, true],
    ...r.ingredients.flatMap((ing, i): Field[] => [
      [`ingredients.${i}.name`, ing.name, true],
      [`ingredients.${i}.householdAmount`, ing.householdAmount, true],
      ...(ing.overseasAlternative
        ? [[`ingredients.${i}.overseasAlternative`, ing.overseasAlternative, true] as Field]
        : []),
    ]),
    ...r.steps.map((s, i): Field => [`steps.${i}`, s, true]),
    ...(r.nutritionBasis ? [['nutritionBasis', r.nutritionBasis, false] as Field] : []),
    ['sourceNote', r.sourceNote, false],
  ];
}

function exerciseFields(e: ExerciseContent): Field[] {
  return [
    ['name', e.name, true],
    ...e.equipment.map((s, i): Field => [`equipment.${i}`, s, true]),
    ...e.steps.map((s, i): Field => [`steps.${i}`, s, true]),
    ...e.keyPoints.map((s, i): Field => [`keyPoints.${i}`, s, true]),
    ...e.commonMistakes.map((s, i): Field => [`commonMistakes.${i}`, s, true]),
    ['managerCautions', e.managerCautions, false],
    ['sourceNote', e.sourceNote, false],
  ];
}

function goalFields(g: GoalTemplateContent): Field[] {
  return [
    ['text', g.text, true],
    ...g.params.flatMap((p, i): Field[] =>
      p.type === 'int' && p.unit ? [[`params.${i}.unit`, p.unit, true]] : [],
    ),
    ['sourceNote', g.sourceNote, false],
  ];
}

function check(fields: readonly Field[]): LibraryContentIssue[] {
  const issues: LibraryContentIssue[] = [];
  for (const [path, text, clientFacing] of fields) {
    const found = clientFacing
      ? checkLibraryText(text).map((i) => ({ term: i.term, index: i.index }))
      : findBannedTerms(text).map((i) => ({ term: i.term, index: i.index }));
    for (const f of found) issues.push({ path, ...f });
  }
  return issues;
}

export function recipeContentIssues(r: RecipeContent): LibraryContentIssue[] {
  return check(recipeFields(r));
}

export function exerciseContentIssues(e: ExerciseContent): LibraryContentIssue[] {
  return check(exerciseFields(e));
}

export function goalTemplateContentIssues(g: GoalTemplateContent): LibraryContentIssue[] {
  return check(goalFields(g));
}

/** 按条目类型检查（内容已通过 zod 校验） */
export function libraryContentIssues(
  type: LibraryItemType,
  content: RecipeContent | ExerciseContent | GoalTemplateContent,
): LibraryContentIssue[] {
  switch (type) {
    case 'recipe':
      return recipeContentIssues(content as RecipeContent);
    case 'exercise':
      return exerciseContentIssues(content as ExerciseContent);
    case 'goal_template':
      return goalTemplateContentIssues(content as GoalTemplateContent);
  }
}

/**
 * 食材名称和海外替代食材里能看出来的过敏原（构建时核对种子食谱的过敏原标签有没有漏标）。
 * 只是漏标检查的下限，不能代替营养顾问的审定；酱油、生抽同时含大豆和麸质。
 */
export const INGREDIENT_ALLERGEN_HINTS: Readonly<Record<string, readonly string[]>> = {
  egg: ['蛋'],
  dairy: ['奶', '酸奶', '奶酪', '芝士', '黄油'],
  soy: [
    '豆腐',
    '豆浆',
    '豆奶',
    '黄豆',
    '毛豆',
    '豆干',
    '腐竹',
    '千张',
    '生抽',
    '酱油',
    '豆瓣',
    '豆豉',
    '腐乳',
    '味噌',
  ],
  gluten: [
    '面',
    '馒头',
    '花卷',
    '包子',
    '饺',
    '馄饨',
    '饼',
    '燕麦',
    '全麦',
    '麸',
    '生抽',
    '酱油',
    '豆瓣',
  ],
  seafood: ['虾', '鱼', '蟹', '扇贝', '贝类', '干贝', '蛤', '蚝', '鱿', '海参'],
  peanut: ['花生'],
  tree_nut: ['核桃', '杏仁', '腰果', '榛子', '开心果', '松子', '巴旦木'],
};

/**
 * 做法里能看出来的过敏原：只看调味料（做法里的“两面煎熟”“翻面”不是面食，不用食材的宽词表）
 */
export const STEP_ALLERGEN_HINTS: Readonly<Record<string, readonly string[]>> = {
  soy: ['酱油', '生抽', '老抽', '豆瓣', '豆豉', '腐乳'],
  gluten: ['酱油', '生抽', '老抽', '豆瓣'],
  seafood: ['蚝油', '鱼露', '虾皮'],
};

function hinted(text: string, hints: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(hints)
    .filter(([, words]) => words.some((w) => text.includes(w)))
    .map(([allergen]) => allergen);
}

/** 按食材名称、海外替代和做法里的调味料推测的过敏原里，标签没有标的（种子文件构建时检查用） */
export function missingAllergenTags(
  r: Pick<RecipeContent, 'ingredients' | 'allergens' | 'steps'>,
): string[] {
  const names = r.ingredients.flatMap((i) => [i.name, i.overseasAlternative ?? '']).join('、');
  const found = new Set([
    ...hinted(names, INGREDIENT_ALLERGEN_HINTS),
    ...hinted(r.steps.join('、'), STEP_ALLERGEN_HINTS),
  ]);
  return [...found].filter((a) => !(r.allergens as readonly string[]).includes(a));
}
