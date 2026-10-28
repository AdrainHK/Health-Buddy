/**
 * 问一问读方案、随访和方案库（M5 规格 2.11）：当前方案、执行情况、最近的随访记录，
 * @食谱、@动作 引用的条目，以及问到吃什么、怎么运动时的候选条目。只读，问一问不能改方案、不能排随访。
 */
import type { Allergen, ExerciseCategory, LibraryTag, MealType } from '@health-buddy/shared';
import {
  EXERCISE_CATEGORY_ZH,
  MEAL_ZH,
  describePlanContext,
  type PlanContext,
  type PlanLibraryContext,
} from './plan-input.js';

const ALLERGEN_ZH: Record<Allergen, string> = {
  peanut: '花生',
  tree_nut: '坚果',
  dairy: '奶类',
  egg: '蛋类',
  seafood: '海鲜',
  soy: '大豆',
  gluten: '麸质',
  sesame: '芝麻',
};

const TAG_ZH: Record<LibraryTag, string> = {
  low_oil: '少油',
  low_salt: '少盐',
  high_fiber: '高纤维',
  quality_protein: '优质蛋白',
  mixed_grains: '粗细搭配',
  vegetable_rich: '蔬菜多',
  low_sugar: '少糖',
  quick: '做法简单',
  vegetarian: '素食',
};

/** @ 引用的一个库条目（后端按健管师能看到的条目读出；过敏原冲突和运动安全规则由后端算好） */
export type AskLibraryItem =
  | {
      type: 'recipe';
      name: string;
      mealTypes: MealType[];
      tags: LibraryTag[];
      allergens: Allergen[];
      ingredients: { name: string; householdAmount: string }[];
      steps: string[];
      energyKcal: number | null;
      /** 和这位客户过敏史冲突的过敏原（没有引用客户或没有冲突时为空） */
      conflicts: Allergen[];
    }
  | {
      type: 'exercise';
      name: string;
      category: ExerciseCategory;
      intensity: 'low' | 'moderate';
      steps: string[];
      keyPoints: string[];
      managerCautions: string;
      /** 这位客户的运动安全规则（原因类别）；不限制或没有引用客户时为 null */
      restriction: string | null;
    };

/** 问一问的方案和随访资料：当前方案、执行情况、最近的随访记录 */
export function describeAskPlan(plan: PlanContext): string {
  const lines = [describePlanContext(plan)];
  if (plan.adherence) {
    lines.push('', '## 方案执行情况（系统按监测数据算出）');
    if (!plan.adherence.length) lines.push('没有关联监测数据的目标。');
    for (const a of plan.adherence) lines.push(`- ${a}`);
  }
  return lines.join('\n');
}

/** @ 引用的库条目：全部内容 */
export function describeLibraryItems(items: readonly AskLibraryItem[]): string {
  const lines = ['## 这次引用的方案库条目'];
  for (const item of items) {
    if (item.type === 'recipe') {
      const energy = item.energyKcal === null ? '' : `，约 ${item.energyKcal} 千卡/份`;
      lines.push(
        '',
        `### 食谱：${item.name}`,
        `- 餐次：${item.mealTypes.map((m) => MEAL_ZH[m]).join('、')}${energy}`,
        `- 特点：${item.tags.map((t) => TAG_ZH[t]).join('、') || '无'}`,
        `- 过敏原：${item.allergens.map((a) => ALLERGEN_ZH[a]).join('、') || '未标过敏原'}`,
        `- 食材：${item.ingredients.map((i) => `${i.name} ${i.householdAmount}`).join('、')}`,
        `- 做法：${item.steps.join(' ')}`,
      );
      if (item.conflicts.length) {
        lines.push(
          `- **过敏原提示（系统按健康史比对）**：该客户健康史里有${item.conflicts.map((a) => ALLERGEN_ZH[a]).join('、')}过敏，这份食谱含这些过敏原，不适合该客户。`,
        );
      }
    } else {
      lines.push(
        '',
        `### ${EXERCISE_CATEGORY_ZH[item.category]}：${item.name}`,
        `- 强度：${item.intensity === 'low' ? '低强度' : '中等强度'}`,
        `- 做法：${item.steps.join(' ')}`,
        `- 要点：${item.keyPoints.join(' ')}`,
        `- 给健管师的注意事项：${item.managerCautions}`,
      );
      if (item.restriction && item.category !== 'relaxation') {
        lines.push(
          `- **运动安全规则（系统判断）**：${item.restriction}，该客户开始这类运动前需要先就医评估，不要建议强度、频率和时长。`,
        );
      }
    }
  }
  return lines.join('\n');
}

/** 问到吃什么、怎么运动时：已按过敏史和运动安全规则筛过的候选条目（只列名称） */
export function describeLibraryCandidates(lib: PlanLibraryContext): string {
  const lines = ['## 方案库里适合该客户的条目（已按过敏史和运动安全规则筛过）'];
  if (lib.libraryEmpty) {
    lines.push('方案库待审定，暂时没有可用的条目。');
    return lines.join('\n');
  }
  for (const meal of Object.keys(MEAL_ZH) as MealType[]) {
    const names = lib.recipes.filter((r) => r.mealTypes.includes(meal)).map((r) => r.name);
    if (names.length) lines.push(`- ${MEAL_ZH[meal]}：${names.join('、')}`);
  }
  if (lib.excludedForAllergy) lines.push(`（因过敏史排除了 ${lib.excludedForAllergy} 份食谱）`);
  if (lib.exerciseRestriction) {
    lines.push(`- 运动安全规则：${lib.exerciseRestriction}，运动需先就医评估；只列放松练习。`);
  }
  const exercises = lib.exercises.map(
    (e) =>
      `${e.name}（${EXERCISE_CATEGORY_ZH[e.category]}，${e.intensity === 'low' ? '低强度' : '中等强度'}）`,
  );
  if (exercises.length) lines.push(`- 运动和放松练习：${exercises.join('、')}`);
  return lines.join('\n');
}

/** 问的是吃什么、怎么运动（读候选条目）；不问这些时不带候选，省提示词 */
const LIBRARY_QUESTION =
  /食谱|菜谱|早餐|午餐|晚餐|早饭|午饭|晚饭|夜宵|加餐|零食|主食|水果|吃什么|吃啥|怎么吃|能不能吃|能吃|吃些|喝什么|饮食|运动|锻炼|动作|练习|放松|散步|走路|快走|跑步|游泳|瑜伽|太极|八段锦|健身|拉伸/;

export function asksAboutLibrary(question: string): boolean {
  return LIBRARY_QUESTION.test(question);
}

/** 读到方案、随访或库条目时追加的回答规则（2.11） */
export const ASK_PLAN_RULES = `方案、随访和方案库的回答要求：
1. 问方案执行得怎么样、随访谈了什么时，依据资料里的“当前方案”“方案执行情况”“最近的随访记录”回答，引用数字时写明是近几天的数据；资料里没有的写“没有这项数据”。
2. 问一问不能修改方案、不能安排随访。健管师要求改方案、换食谱、排随访时，说明要用 /方案生成 或 /随访计划 生成草稿、审核后才生效，不在回答里替他改。
3. 推荐食谱和动作时只能从资料里列出的方案库条目选，写条目名称，不编造库外的菜名和动作；资料里没有列出方案库条目时，不举具体菜名和动作，提示健管师用 @食谱、@动作 引用条目或在方案库查看。资料里标了过敏原提示或运动安全规则的，先说明不适合，不推荐。
4. 谈到方案、目标、执行情况、食谱和动作时都不承诺效果，不写“降血糖”“降血压”“减肥”“治好”这类说法，写“有助于养成……的习惯”；不把食物和用药联系起来，饮食和药物的注意事项写“请向开药医生确认”。`;
