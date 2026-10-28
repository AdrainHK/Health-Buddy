import { renderHook } from '@testing-library/react';
import { useRoutingReasonLabel } from './labels';

/** 选中专家的原因（M3 规格 2.6；M5 规格 2.5 按方案部分命中） */
describe('useRoutingReasonLabel', () => {
  it('方案部分命中写明是哪一部分', () => {
    const { result } = renderHook(() => useRoutingReasonLabel());
    expect(result.current({ kind: 'plan_section', section: 'diet' })).toBe('方案包含饮食部分');
    expect(result.current({ kind: 'plan_section', section: 'mind' })).toBe('方案包含心理部分');
  });
});
