import { describe, expect, it } from 'vitest';
import { markConflicts, processItem, type RawItem } from './process-values.js';

const raw = (over: Partial<RawItem>): RawItem => ({
  rawName: '空腹血糖',
  rawValue: '5.1',
  rawUnit: 'mmol/L',
  refText: '3.9-6.1',
  page: 1,
  snippet: null,
  unreadable: false,
  ...over,
});

describe('识别结果的确定性处理', () => {
  it('mg/dL 的血糖换算成 mmol/L，参考范围一起换算，标为已换算', () => {
    const r = processItem(raw({ rawValue: '99', rawUnit: 'mg/dL', refText: '70-110' }));
    expect(r).toMatchObject({ code: 'fpg', value: 5.495, unit: 'mmol/L', refLow: 3.885 });
    expect(r.flags).toEqual(['unit_converted']);
  });

  it('单位不认识：不换算，数值留空，标出', () => {
    const r = processItem(raw({ rawUnit: 'g/L' }));
    expect(r).toMatchObject({ value: null, unit: null, flags: ['unit_unknown'] });
  });

  it('超出合理范围、读不出数字、未收录指标分别标出', () => {
    expect(processItem(raw({ rawValue: '80' })).flags).toEqual(['out_of_bounds']);
    expect(processItem(raw({ rawValue: '5.l' })).flags).toEqual(['unreadable']);
    expect(processItem(raw({ rawValue: '<5' })).value).toBeNull();
    expect(processItem(raw({ rawName: '血糖' }))).toMatchObject({ code: null, flags: ['unmapped'] });
    // 健管师指定按未收录保存
    expect(processItem(raw({}), null).code).toBeNull();
  });

  it('同一报告日期已有的值：相同标为重复，不同标为冲突；同一次上传同一指标两行也是冲突', () => {
    const items = [processItem(raw({})), processItem(raw({ rawName: 'FPG', rawValue: '5.2' }))];
    expect(markConflicts(items, new Map()).map((i) => i.flags)).toEqual([[], ['conflict']]);
    expect(markConflicts([items[0]!], new Map([['fpg', [5.1]]]))[0]!.flags).toEqual(['duplicate']);
    expect(markConflicts([items[0]!], new Map([['fpg', [6]]]))[0]!.flags).toEqual(['conflict']);
  });
});
