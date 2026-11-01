import { describe, expect, it } from 'vitest';
import { HOME_DEFAULT_SKILLS, orderShortcuts } from './home.js';

describe('首页快捷入口排序（M8 Q8）', () => {
  const available = ['client-recent-summary', 'care-plan', 'visit-script', 'report-interpretation'];

  it('先按使用次数，再按默认顺序补齐；没上线的技能跳过，最多 limit 个', () => {
    expect(orderShortcuts(['visit-script'], HOME_DEFAULT_SKILLS, available, 3)).toEqual([
      'visit-script',
      'report-interpretation',
      'care-plan',
    ]);
  });

  it('套餐里没有的（不在 available 里）即使用过也不显示；不重复', () => {
    expect(
      orderShortcuts(['care-plan', 'care-plan'], HOME_DEFAULT_SKILLS, ['client-recent-summary'], 6),
    ).toEqual(['client-recent-summary']);
  });

  it('没有记录也没有默认值时按可用顺序', () => {
    expect(orderShortcuts([], [], ['b', 'a'], 3)).toEqual(['b', 'a']);
  });
});
