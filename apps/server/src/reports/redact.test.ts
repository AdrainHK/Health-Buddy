import { describe, expect, it } from 'vitest';
import type { RawItem } from './process-values.js';
import { redactExtraction } from './redact.js';

const item = (over: Partial<RawItem>): RawItem => ({
  rawName: '空腹血糖',
  rawValue: '5.6',
  rawUnit: 'mmol/L',
  refText: '3.9-6.1',
  page: 1,
  snippet: '空腹血糖 5.6 mmol/L 3.9-6.1',
  unreadable: false,
  ...over,
});

describe('识别结果写入前去掉电话和证件号', () => {
  it('原文片段、检查机构、指标名里的电话和证件号（含空格、短横线）被替换', () => {
    const out = redactExtraction({
      reportDate: '2026-08-15',
      institution: '合成体检中心 电话 139-0000-0000',
      items: [
        item({ snippet: '受检者 139 0000 0000 空腹血糖 5.6' }),
        item({ rawName: '证件号 110101 19900101 1234', snippet: null }),
        item({ snippet: '+86 13900000000，110101199001011234' }),
      ],
    });
    expect(out.institution).toBe('合成体检中心 电话 [电话]');
    expect(out.items.map((i) => i.snippet)).toEqual([
      '受检者 [电话] 空腹血糖 5.6',
      null,
      '[电话]，[证件号]',
    ]);
    expect(out.items[1]?.rawName).toBe('证件号 [证件号]');
    expect(out.reportDate).toBe('2026-08-15');
  });

  it('普通的指标行原样保留', () => {
    const rows = [item({}), item({ rawName: '白细胞', snippet: '白细胞 6.2 10^9/L 3.5-9.5' })];
    const out = redactExtraction({ institution: null, items: rows });
    expect(out).toEqual({ institution: null, items: rows });
  });
});
