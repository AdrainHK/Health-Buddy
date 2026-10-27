import { ALLERGENS, type Allergen } from './library.js';

/**
 * 过敏原排除（M5 规格 Q16、3.2）：按健康史“过敏史”里的关键词确定性匹配食谱的过敏原标签。
 * 过敏是安全问题，不能只靠模型。关键词表是候选，待营养顾问审定。
 *
 * 匹配从严：不判断否定句（如“对花生不过敏”也算匹配），宁可多提示一次，
 * 由健管师在审核栏勾选“已核对过敏原”。只有“无过敏史”这类整句明确说没有过敏的条目不参与匹配。
 */
export const ALLERGEN_KEYWORDS: Readonly<Record<Allergen, readonly string[]>> = {
  peanut: ['花生', 'peanut'],
  tree_nut: [
    '坚果',
    '核桃',
    '杏仁',
    '腰果',
    '榛子',
    '开心果',
    '松子',
    '夏威夷果',
    '碧根果',
    '板栗',
    'tree nut',
    'walnut',
    'almond',
    'cashew',
    'hazelnut',
    'pistachio',
  ],
  dairy: [
    '乳制品',
    '奶制品',
    '牛奶',
    '牛乳',
    '羊奶',
    '乳糖',
    '奶酪',
    '芝士',
    '酸奶',
    '奶粉',
    'milk',
    'dairy',
    'lactose',
    'cheese',
  ],
  egg: ['鸡蛋', '鸭蛋', '鹅蛋', '鹌鹑蛋', '蛋类', '禽蛋', '蛋清', '蛋黄', 'egg'],
  seafood: [
    '海鲜',
    '海产',
    '水产',
    '鱼',
    '虾',
    '蟹',
    '贝类',
    '扇贝',
    '蛤',
    '蚌',
    '牡蛎',
    '生蚝',
    '鱿鱼',
    '墨鱼',
    '章鱼',
    'seafood',
    'shellfish',
    'fish',
    'shrimp',
    'prawn',
    'crab',
    'oyster',
  ],
  soy: ['大豆', '黄豆', '豆制品', '豆浆', '豆腐', '豆干', '腐竹', 'soy', 'soya', 'tofu'],
  gluten: ['麸质', '小麦', '面筋', '麦麸', '大麦', '黑麦', 'gluten', 'wheat', 'barley', 'rye'],
  sesame: ['芝麻', '麻酱', '香油', '麻油', 'sesame', 'tahini'],
};

/** 整条只是在说“没有过敏”（如“无过敏史”“否认药物食物过敏史”），不参与匹配 */
const NO_ALLERGY = /^(无|否认|没有|暂无|未发现|无已知)[^，,。；;]{0,12}过敏(史)?[。.]?$/;

export interface AllergenMatch {
  allergen: Allergen;
  /** 命中的关键词（关键词表里的原词，不是客户原文） */
  keyword: string;
}

/** 从过敏史文字里找出涉及的过敏原（按 ALLERGENS 的顺序，每种只报一次） */
export function allergensInHistory(allergyTexts: readonly string[]): AllergenMatch[] {
  const texts = allergyTexts
    .map((t) => t.normalize('NFKC').trim())
    .filter((t) => t && !NO_ALLERGY.test(t.replace(/\s+/g, '')))
    .map((t) => t.toLowerCase());
  const out: AllergenMatch[] = [];
  for (const allergen of ALLERGENS) {
    const keyword = ALLERGEN_KEYWORDS[allergen].find((k) =>
      texts.some((t) => t.includes(k.toLowerCase())),
    );
    if (keyword) out.push({ allergen, keyword });
  }
  return out;
}

export interface AllergenConflict extends AllergenMatch {
  itemId: string;
}

/**
 * 过敏史文字 + 条目过敏原标签 → 冲突列表（规格 6.3）。
 * 生成方案前用来排除候选食谱，审核时用来提示“已核对过敏原”。
 */
export function allergenConflicts(
  allergyTexts: readonly string[],
  items: readonly { id: string; allergens: readonly Allergen[] }[],
): AllergenConflict[] {
  const matches = allergensInHistory(allergyTexts);
  if (!matches.length) return [];
  const out: AllergenConflict[] = [];
  for (const item of items) {
    for (const m of matches) {
      if (item.allergens.includes(m.allergen)) out.push({ itemId: item.id, ...m });
    }
  }
  return out;
}
