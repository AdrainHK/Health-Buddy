import { describe, expect, it } from 'vitest';
import { EXPERTS } from './registry.js';
import { suggestExpert } from './suggest.js';

const ALL = new Set(EXPERTS.map((e) => e.meta.id));

describe('主对话问一问的专家建议（Q6）', () => {
  it('问题明显属于某位专家时建议这位专家', () => {
    expect(suggestExpert('空腹血糖偏高要注意什么？', ALL)).toBe('endocrine-metabolism');
    expect(suggestExpert('家里测的血压一直不稳', ALL)).toBe('cardiovascular');
    expect(suggestExpert('晚饭应该怎么吃', ALL)).toBe('nutrition');
    expect(suggestExpert('每周锻炼几次合适', ALL)).toBe('exercise-rehab');
    expect(suggestExpert('客户最近压力很大，睡不好', ALL)).toBe('mental-health');
    expect(suggestExpert('这个指标什么意思', ALL)).toBe('lab-interpretation');
  });

  it('没有命中、或命中的专家不可用（预览关闭、平台暂停）时不建议', () => {
    expect(suggestExpert('下周面谈安排在什么时候？', ALL)).toBeUndefined();
    expect(suggestExpert('空腹血糖偏高要注意什么？', new Set())).toBeUndefined();
    const withoutEndocrine = new Set([...ALL].filter((id) => id !== 'endocrine-metabolism'));
    expect(suggestExpert('空腹血糖偏高要注意什么？', withoutEndocrine)).toBeUndefined();
  });

  it('同时命中多位时按注册表顺序只建议一位', () => {
    expect(suggestExpert('血糖高，饮食怎么调整', ALL)).toBe('endocrine-metabolism');
  });
});
