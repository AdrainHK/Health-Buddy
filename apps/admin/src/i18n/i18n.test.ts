import {
  ALLERGENS,
  EXERCISE_CATEGORIES,
  EXERCISE_INTENSITIES,
  EXERCISE_SETTINGS,
  GOAL_METRICS,
  LIBRARY_ITEM_STATUSES,
  LIBRARY_ITEM_TYPES,
  LIBRARY_TAGS,
  MEAL_TYPES,
  PLAN_SECTIONS,
  VISIT_METHODS,
  VISIT_RISK_TIERS,
  findBannedTerms,
} from '@health-buddy/shared';
import zhCN from './locales/zh-CN.json';

type Tree = { [key: string]: string | Tree };

function strings(node: string | Tree, path: string): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`));
}

const lookup = (path: string): Tree => {
  let node: string | Tree = zhCN as Tree;
  for (const k of path.split('.')) node = (node as Tree)[k]!;
  return node as Tree;
};

/** M5 验收第 21 条：后台新增的界面文字不含禁用词；枚举的每个取值都有中文名称 */
describe('后台界面文字', () => {
  it('所有词条都不含禁用词（诊断、筛查、治愈、根治等）', () => {
    const all = strings(zhCN as Tree, 'zh-CN');
    expect(all.length).toBeGreaterThan(100);
    const issues = all.flatMap(([path, text]) =>
      findBannedTerms(text).map((issue) => `${path}: ${issue.term}`),
    );
    expect(issues).toEqual([]);
  });

  it.each([
    ['planLibrary.tabs', LIBRARY_ITEM_TYPES],
    ['planLibrary.status', LIBRARY_ITEM_STATUSES],
    ['planLibrary.meals', MEAL_TYPES],
    ['planLibrary.tags', LIBRARY_TAGS],
    ['planLibrary.allergens', ALLERGENS],
    ['planLibrary.categories', EXERCISE_CATEGORIES],
    ['planLibrary.intensities', EXERCISE_INTENSITIES],
    ['planLibrary.settings', EXERCISE_SETTINGS],
    ['planLibrary.sections', PLAN_SECTIONS],
    ['planLibrary.metrics', ['none', ...GOAL_METRICS]],
    ['visitFrequency.tiers', VISIT_RISK_TIERS],
    ['visitFrequency.methods', VISIT_METHODS],
  ] as const)('%s 覆盖全部取值', (path, values) => {
    expect(Object.keys(lookup(path)).sort()).toEqual([...values].sort());
  });
});
