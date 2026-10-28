import { describe, expect, it } from 'vitest';
import { planSectionExperts } from './plan-routing.js';

/** /方案生成 按方案部分命中专家（M5 规格 2.5） */
describe('planSectionExperts', () => {
  it('饮食 → 营养，运动 → 运动康复；作息没有对应专家', () => {
    expect(planSectionExperts(['diet', 'exercise', 'routine'], [])).toEqual([
      { expertId: 'nutrition', section: 'diet' },
      { expertId: 'exercise-rehab', section: 'exercise' },
    ]);
  });

  it('心理只有在资料里有情绪、压力、睡眠描述时才请心理专家', () => {
    expect(planSectionExperts(['mind'], ['每天晚饭后散步'])).toEqual([]);
    expect(planSectionExperts(['mind'], ['最近工作压力 大，入睡难'])).toEqual([
      { expertId: 'mental-health', section: 'mind' },
    ]);
  });
});
