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

/** 各种括号统一成半角圆括号（NFKC 不处理【】〔〕[] 等） */
function unifyBrackets(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[[【〔〖]/g, '(')
    .replace(/[\]】〕〗]/g, ')');
}

/** 名称前的序号（“1.”“2、”“(3)”）和名称后的高低箭头（报告上常和名称印在一起） */
function stripDecorations(raw: string): string {
  return raw
    .replace(/^\s*(?:\d{1,3}\s*[.、)]|\(\d{1,3}\))\s*/, '')
    .replace(/[↑↓▲▼]+/g, '')
    .trim();
}

function lookupWhole(raw: string): ReportIndicatorCode | null {
  const full = normalizeName(raw);
  const direct = LOOKUP.get(full);
  if (direct) return direct;
  const outside = normalizeName(raw.replace(/\([^)]*\)/g, ''));
  const byOutside = outside ? LOOKUP.get(outside) : undefined;
  if (byOutside) return byOutside;
  for (const m of raw.matchAll(/\(([^)]*)\)/g)) {
    const inner = LOOKUP.get(normalizeName(m[1] ?? ''));
    if (inner) return inner;
  }
  return null;
}

const CJK = /[\u3400-\u9fff]/;

/**
 * 中文名和英文缩写之间只隔空格、没有括号（“空腹血糖 GLU”“TC 总胆固醇”“空腹血糖GLU”）：
 * 中文部分能对上，英文部分对不上（如 GLU 单独不收）或对上同一项时才算；
 * 两部分对上不同的指标时不猜。
 */
function lookupMixed(raw: string): ReportIndicatorCode | null {
  // 括号里的字（如“(尿)”）也算进中文部分，避免把尿肌酐当成血肌酐
  const s = raw.replace(/[()]/g, ' ');
  if (!CJK.test(s) || !/[a-z]/i.test(s)) return null;
  const cjk = s.replace(/[^\u3400-\u9fff]/g, '');
  const latin = s.replace(/[\u3400-\u9fff]/g, ' ');
  const byCjk = LOOKUP.get(normalizeName(cjk));
  if (!byCjk) return null;
  const tokens = latin
    .split(/[\s/,，;；]+/)
    .map(normalizeName)
    .filter(Boolean);
  for (const t of tokens) {
    const other = LOOKUP.get(t);
    if (other && other !== byCjk) return null;
  }
  return byCjk;
}

/**
 * 按名称找指标编码。依次尝试：整个名称、去掉括号里的内容、括号里的内容
 * （如“空腹血糖(GLU)”“甘油三酯 (TG)”“空腹血糖【GLU】”），再试中文名加英文缩写
 * （“空腹血糖 GLU”）。名称前的序号和后面的高低箭头先去掉。都对不上时返回 null。
 */
export function mapIndicatorName(raw: string): ReportIndicatorCode | null {
  const cleaned = stripDecorations(unifyBrackets(raw));
  return lookupWhole(cleaned) ?? lookupMixed(cleaned);
}
