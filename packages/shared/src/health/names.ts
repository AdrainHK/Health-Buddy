/**
 * 报告上的指标名称 → 指标目录编码（M2 规格 2.3 第 6 条）。
 *
 * 只收确定是同一项的写法（中文常用名、英文名和缩写）；意思不唯一的（如单写“血糖”“葡萄糖”，
 * 不知道是不是空腹）不收，对不上的作为“未收录指标”由健管师核对（Q10）。
 */
import type { ReportIndicatorCode } from './catalog.js';

const NAMES: Record<ReportIndicatorCode, string[]> = {
  height: ['身高', 'height'],
  weight: ['体重', 'weight', 'bodyweight'],
  bmi: ['体重指数', '体质指数', 'bmi', 'bodymassindex'],
  waist: ['腰围', 'waist', 'waistcircumference'],
  sbp: ['收缩压', 'systolic', 'systolicbloodpressure', 'sbp'],
  dbp: ['舒张压', 'diastolic', 'diastolicbloodpressure', 'dbp'],
  fpg: [
    '空腹血糖',
    '空腹葡萄糖',
    '空腹血浆葡萄糖',
    '葡萄糖空腹',
    'fpg',
    'fbg',
    'fastingglucose',
    'fastingplasmaglucose',
    'fastingbloodglucose',
    'glucosefasting',
  ],
  hba1c: ['糖化血红蛋白', '糖化血红蛋白a1c', 'hba1c', 'hemoglobina1c', 'glycatedhemoglobin'],
  tc: ['总胆固醇', '血清总胆固醇', 'tc', 'tcho', 'chol', 'totalcholesterol', 'cholesteroltotal'],
  tg: ['甘油三酯', '甘油三脂', '三酰甘油', 'tg', 'triglyceride', 'triglycerides'],
  ldl_c: [
    '低密度脂蛋白胆固醇',
    '低密度脂蛋白',
    'ldlc',
    'ldl',
    'ldlcholesterol',
    'lowdensitylipoproteincholesterol',
  ],
  hdl_c: [
    '高密度脂蛋白胆固醇',
    '高密度脂蛋白',
    'hdlc',
    'hdl',
    'hdlcholesterol',
    'highdensitylipoproteincholesterol',
  ],
  alt: ['丙氨酸氨基转移酶', '谷丙转氨酶', 'alt', 'gpt', 'sgpt', 'alanineaminotransferase'],
  ast: [
    '天门冬氨酸氨基转移酶',
    '天冬氨酸氨基转移酶',
    '谷草转氨酶',
    'ast',
    'got',
    'sgot',
    'aspartateaminotransferase',
  ],
  creatinine: ['肌酐', '血肌酐', '血清肌酐', 'cr', 'crea', 'creatinine', 'serumcreatinine'],
  uric_acid: ['尿酸', '血尿酸', '血清尿酸', 'ua', 'uricacid', 'serumuricacid'],
};

function normalizeName(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·.:：*]/g, '');
}

const LOOKUP = new Map<string, ReportIndicatorCode>();
for (const [code, names] of Object.entries(NAMES) as [ReportIndicatorCode, string[]][]) {
  for (const n of names) LOOKUP.set(normalizeName(n), code);
}

/**
 * 按名称找指标编码。依次尝试：整个名称、去掉括号里的内容、括号里的内容
 * （如“空腹血糖(GLU)”“甘油三酯 (TG)”）。都对不上时返回 null。
 */
export function mapIndicatorName(raw: string): ReportIndicatorCode | null {
  const full = normalizeName(raw);
  const direct = LOOKUP.get(full);
  if (direct) return direct;
  const outside = normalizeName(raw.normalize('NFKC').replace(/\([^)]*\)/g, ''));
  const byOutside = outside ? LOOKUP.get(outside) : undefined;
  if (byOutside) return byOutside;
  for (const m of raw.normalize('NFKC').matchAll(/\(([^)]*)\)/g)) {
    const inner = LOOKUP.get(normalizeName(m[1] ?? ''));
    if (inner) return inner;
  }
  return null;
}
