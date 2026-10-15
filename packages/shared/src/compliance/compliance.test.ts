import { describe, expect, it } from 'vitest';
import { DISCLAIMER, findBannedTerms } from './index.js';

describe('findBannedTerms', () => {
  it('returns nothing for compliant copy', () => {
    expect(findBannedTerms('坚持快走30分钟，有助于改善血糖控制。')).toEqual([]);
  });

  it('finds every occurrence with its position, in order', () => {
    const issues = findBannedTerms('本产品可以筛查糖尿病，坚持使用可以根治，筛查很准。');
    expect(issues.map((i) => [i.term, i.index])).toEqual([
      ['筛查', 5],
      ['根治', 17],
      ['筛查', 20],
    ]);
  });

  it('allows the standard disclaimer', () => {
    expect(findBannedTerms(`血压偏高，建议复测。${DISCLAIMER}`)).toEqual([]);
  });

  it('still flags 诊断 outside the disclaimer', () => {
    const issues = findBannedTerms(`AI 诊断结果：高血压。${DISCLAIMER}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.term).toBe('诊断');
  });
});
