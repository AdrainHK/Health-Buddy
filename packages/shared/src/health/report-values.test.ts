import { describe, expect, it } from 'vitest';
import { mapIndicatorName } from './names.js';
import {
  abnormalFromColumns,
  classifyAgainstReference,
  inclusiveRange,
  parseReferenceRange,
} from './reference.js';
import { normalizeUnit, parseNumericValue, unitConversion } from './units.js';

describe('unit conversion (Q11)', () => {
  it('converts glucose mg/dL to mmol/L with a fixed factor', () => {
    const c = unitConversion('fpg', 'mg/dL');
    expect(c.status).toBe('converted');
    if (c.status === 'unknown') throw new Error('unreachable');
    expect(c.unit).toBe('mmol/L');
    expect(c.convert(117)).toBe(6.494);
    expect(c.convert(100)).toBe(5.55);
  });

  it('converts lipids, creatinine, uric acid, HbA1c and blood pressure', () => {
    const conv = (code: Parameters<typeof unitConversion>[0], unit: string, v: number) => {
      const c = unitConversion(code, unit);
      if (c.status === 'unknown') throw new Error(`${code} ${unit} should convert`);
      return c.convert(v);
    };
    expect(conv('tc', 'mg/dl', 200)).toBe(5.172);
    expect(conv('tg', 'MG/DL', 150)).toBe(1.694);
    expect(conv('ldl_c', 'mg/dL', 130)).toBe(3.362);
    expect(conv('hdl_c', 'mg/dL', 40)).toBe(1.034);
    expect(conv('creatinine', 'mg/dL', 1)).toBe(88.42);
    expect(conv('uric_acid', 'mg/dL', 7)).toBe(416.36);
    expect(conv('hba1c', 'mmol/mol', 48)).toBe(6.543);
    expect(conv('sbp', 'kPa', 16)).toBe(120.01);
    expect(conv('weight', 'lbs', 150)).toBe(68.039);
    expect(conv('height', 'm', 1.72)).toBe(172);
  });

  it('treats different spellings of the catalog unit as the same unit', () => {
    for (const [code, unit] of [
      ['fpg', 'mmol/l'],
      ['fpg', 'ｍｍｏｌ／Ｌ'],
      ['creatinine', 'μmol/L'],
      ['creatinine', 'µmol/L'],
      ['alt', 'IU/L'],
      ['bmi', 'kg/m²'],
    ] as const) {
      expect(unitConversion(code, unit).status, `${code} ${unit}`).toBe('same');
    }
  });

  it('does not convert units it does not know, or a missing unit', () => {
    expect(unitConversion('fpg', 'g/L').status).toBe('unknown');
    expect(unitConversion('fpg', null).status).toBe('unknown');
    expect(unitConversion('alt', 'mg/dL').status).toBe('unknown');
    expect(normalizeUnit('  ')).toBeNull();
  });

  it('parses only plain numbers', () => {
    expect(parseNumericValue('6.5')).toBe(6.5);
    expect(parseNumericValue(' ６.５ ')).toBe(6.5);
    expect(parseNumericValue('<0.5')).toBeNull();
    expect(parseNumericValue('5,6')).toBeNull();
    expect(parseNumericValue('阴性')).toBeNull();
    expect(parseNumericValue('')).toBeNull();
  });
});

describe('reference range (Q10)', () => {
  it('parses the common printed forms', () => {
    expect(parseReferenceRange('3.9-6.1')).toEqual({
      low: 3.9,
      high: 6.1,
      lowInclusive: true,
      highInclusive: true,
    });
    expect(parseReferenceRange('3.9～6.1')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('3.9 — 6.1')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('<1.7')).toMatchObject({
      low: null,
      high: 1.7,
      highInclusive: false,
    });
    expect(parseReferenceRange('≤5.2')).toMatchObject({ high: 5.2, highInclusive: true });
    expect(parseReferenceRange('>1.0')).toMatchObject({ low: 1, lowInclusive: false });
    expect(parseReferenceRange('≥1.04')).toMatchObject({ low: 1.04, lowInclusive: true });
    expect(parseReferenceRange('5.2以下')).toMatchObject({ high: 5.2 });
    expect(parseReferenceRange('阴性')).toBeNull();
    expect(parseReferenceRange('6.1-3.9')).toBeNull();
    expect(parseReferenceRange(null)).toBeNull();
  });

  it('reads ranges wrapped in brackets, followed by a unit, or written with 至', () => {
    // 验收反馈 7：核对时看得到参考范围，但带单位或括号的写法以前解析不出，高低标记变成“未提供”
    expect(parseReferenceRange('0-15 μmol/L')).toMatchObject({ low: 0, high: 15 });
    expect(parseReferenceRange('3.90-6.10mmol/L')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('<5.2 mmol/L')).toMatchObject({ high: 5.2, highInclusive: false });
    expect(parseReferenceRange('（0-15）')).toMatchObject({ low: 0, high: 15 });
    expect(parseReferenceRange('[3.9-6.1]')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('3.9 至 6.1')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('3.9--6.1')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('30 ~ 400 ng/mL')).toMatchObject({ low: 30, high: 400 });
    expect(parseReferenceRange('4.0-10.0×10^9/L')).toMatchObject({ low: 4, high: 10 });
    // 两端都带单位（检验科表格常见，验收反馈 7）
    expect(parseReferenceRange('2.0%-10.0%')).toMatchObject({ low: 2, high: 10 });
    expect(parseReferenceRange('0.1%-1.0%')).toMatchObject({ low: 0.1, high: 1 });
    expect(parseReferenceRange('3.9mmol/L-6.1mmol/L')).toMatchObject({ low: 3.9, high: 6.1 });
    expect(parseReferenceRange('2.0-10.0%')).toMatchObject({ low: 2, high: 10 });
    // 两端单位不一样：不猜
    expect(parseReferenceRange('2.0%-10.0MFI')).toBeNull();
    expect(parseReferenceRange('<5.2%')).toMatchObject({ high: 5.2 });
    expect(parseReferenceRange('3.9-')).toBeNull();
    expect(parseReferenceRange('12')).toBeNull();
  });

  it('boundary values of an inclusive range are normal', () => {
    const r = parseReferenceRange('3.9-6.1');
    expect(classifyAgainstReference(3.9, r)).toBe('normal');
    expect(classifyAgainstReference(6.1, r)).toBe('normal');
    expect(classifyAgainstReference(6.11, r)).toBe('high');
    expect(classifyAgainstReference(3.89, r)).toBe('low');
  });

  it('a strict bound printed on the report makes the bound itself abnormal', () => {
    expect(classifyAgainstReference(1.7, parseReferenceRange('<1.7'))).toBe('high');
    expect(classifyAgainstReference(1.69, parseReferenceRange('<1.7'))).toBe('normal');
    expect(classifyAgainstReference(1.7, parseReferenceRange('≤1.7'))).toBe('normal');
    expect(classifyAgainstReference(1.0, parseReferenceRange('>1.0'))).toBe('low');
    expect(classifyAgainstReference(1.0, parseReferenceRange('≥1.0'))).toBe('normal');
  });

  it('has no high or low without a printed range', () => {
    expect(classifyAgainstReference(30, null)).toBe('no_reference');
    expect(classifyAgainstReference(null, inclusiveRange(1, 2))).toBe('no_reference');
    expect(abnormalFromColumns(9, null, null, null)).toBe('no_reference');
  });

  it('reads stored columns, taking strictness from the printed text', () => {
    expect(abnormalFromColumns(1.7, null, 1.7, '<1.7')).toBe('high');
    expect(abnormalFromColumns(1.7, null, 1.7, null)).toBe('normal');
    // 换算过单位：数值列已换算，原文里的数字不再用来比较，只取不等号
    expect(abnormalFromColumns(5.55, 3.885, 6.105, '70-110')).toBe('normal');
    expect(abnormalFromColumns(6.2, 3.885, 6.105, '70-110')).toBe('high');
  });
});

describe('indicator names', () => {
  it('maps common Chinese and English names to catalog codes', () => {
    expect(mapIndicatorName('空腹血糖')).toBe('fpg');
    expect(mapIndicatorName('空腹血糖(GLU)')).toBe('fpg');
    expect(mapIndicatorName('甘油三酯 (TG)')).toBe('tg');
    expect(mapIndicatorName('LDL-C')).toBe('ldl_c');
    expect(mapIndicatorName('Fasting Glucose')).toBe('fpg');
    expect(mapIndicatorName('谷丙转氨酶')).toBe('alt');
    expect(mapIndicatorName('尿酸')).toBe('uric_acid');
  });

  it('maps a Chinese name followed by an abbreviation without brackets (feedback 7)', () => {
    expect(mapIndicatorName('空腹血糖 GLU')).toBe('fpg');
    expect(mapIndicatorName('空腹血糖GLU')).toBe('fpg');
    expect(mapIndicatorName('糖化血红蛋白 HbA1c')).toBe('hba1c');
    expect(mapIndicatorName('TC 总胆固醇')).toBe('tc');
    expect(mapIndicatorName('谷丙转氨酶 ALT')).toBe('alt');
    expect(mapIndicatorName('空腹血糖【GLU】')).toBe('fpg');
    expect(mapIndicatorName('空腹血糖[GLU]')).toBe('fpg');
    expect(mapIndicatorName('1. 空腹血糖')).toBe('fpg');
    expect(mapIndicatorName('2、尿酸')).toBe('uric_acid');
    expect(mapIndicatorName('总胆固醇 TC ↑')).toBe('tc');
  });

  it('does not map when the Chinese name and the abbreviation disagree', () => {
    expect(mapIndicatorName('HDL-C 低密度脂蛋白胆固醇')).toBeNull();
    expect(mapIndicatorName('尿葡萄糖 GLU')).toBeNull();
    expect(mapIndicatorName('肌酐 Cr (尿)')).toBeNull();
  });

  it('does not guess ambiguous or unknown names', () => {
    expect(mapIndicatorName('血糖')).toBeNull();
    expect(mapIndicatorName('葡萄糖')).toBeNull();
    expect(mapIndicatorName('尿肌酐')).toBeNull();
    expect(mapIndicatorName('同型半胱氨酸')).toBeNull();
  });
});
