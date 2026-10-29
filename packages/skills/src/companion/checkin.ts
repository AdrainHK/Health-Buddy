/**
 * 打卡回答的规则识别（M6 规格 2.3、5.4 第 5 条），不依赖模型：
 * - 服药：吃了 / 忘了、没吃 / 今天不用吃；运动：做了 / 做了一部分 / 没做；
 * - 测量：从识别出的文字里取数（阿拉伯数字和中文数字都认），按项目整理成监测读数；
 * - 复述确认：客户说“对”“是的”才写入，说“不对”就请再说一遍。
 * 认不出就返回 null，交给普通对话，不猜。
 */
import type { CheckinKind, CheckinMetric, CheckinStatus } from '@health-buddy/shared';

/** 去掉空白 */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

const MEDICATION_SKIPPED = /不用吃|不需要吃|不吃了|医生说停|停了|没让吃|今天不吃/;
const MEDICATION_MISSED = /忘了|忘记|没吃|还没吃|漏了|没顾上吃|没来得及吃/;
const MEDICATION_DONE = /吃了|吃过|吃完|已经吃|按时吃|刚吃/;

const EXERCISE_PARTIAL = /一部分|一半|没做完|没走完|做了点|做了一点|少做|走了一会|练了一会/;
const EXERCISE_MISSED = /没做|没练|没走|没去|没运动|没锻炼|没动|不想动|今天不做/;
const EXERCISE_DONE = /做了|做完|练了|练完|走了|走完|运动了|锻炼了|动了/;

/** 服药、运动的回答；测量类、认不出时为 null */
export function parseCheckinStatus(kind: CheckinKind, text: string): CheckinStatus | null {
  const t = compact(text);
  if (kind === 'medication') {
    if (MEDICATION_SKIPPED.test(t)) return 'skipped';
    if (MEDICATION_MISSED.test(t)) return 'missed';
    if (MEDICATION_DONE.test(t)) return 'done';
    return null;
  }
  if (kind === 'exercise') {
    if (EXERCISE_PARTIAL.test(t)) return 'partial';
    if (EXERCISE_MISSED.test(t)) return 'missed';
    if (EXERCISE_DONE.test(t)) return 'done';
  }
  return null;
}

/** 复述后客户的确认：yes / no；认不出为 null（“不对”优先于“对”） */
export function parseConfirmation(text: string): 'yes' | 'no' | null {
  const t = compact(text).replace(/[，。！？,.!?]/g, '');
  if (/不对|不是|错了|说错|不太对|不准/.test(t)) return 'no';
  if (/^(?:嗯+|对+|是+|好+)$/.test(t)) return 'yes';
  if (/对的|对啊|对呀|没错|是的|是啊|是呀|正确|对对|就是这个|就这个数|没问题/.test(t)) return 'yes';
  if (/^(?:对|是|嗯)/.test(t)) return 'yes';
  return null;
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  幺: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

/** 中文整数（一百三十二、十五、八千五百、一万二、一三二） */
function cnInteger(s: string): number | null {
  if (!s) return null;
  // 逐位念的“一三二”
  if (/^[零〇一幺二两三四五六七八九]{2,}$/.test(s)) {
    return Number([...s].map((c) => CN_DIGITS[c]).join(''));
  }
  const wan = s.indexOf('万');
  if (wan >= 0) {
    const high = cnInteger(s.slice(0, wan) || '一');
    const rest = s.slice(wan + 1);
    if (high === null) return null;
    // “一万二” = 12000（省略了“千”）
    if (/^[一二两三四五六七八九]$/.test(rest)) return high * 10000 + CN_DIGITS[rest]! * 1000;
    const low = rest ? cnInteger(rest.replace(/^零/, '')) : 0;
    return low === null ? null : high * 10000 + low;
  }
  let total = 0;
  let digit: number | null = null;
  let lastUnit = 10000;
  for (const c of s) {
    if (c in CN_DIGITS) {
      digit = CN_DIGITS[c]!;
    } else if (c in CN_UNITS) {
      const unit = CN_UNITS[c]!;
      total += (digit ?? (unit === 10 ? 1 : 0)) * unit;
      if (digit === null && unit !== 10) return null;
      digit = null;
      lastUnit = unit;
    } else {
      return null;
    }
  }
  if (digit !== null) {
    // “一百三” = 130、“八千五” = 8500（省略了末位的单位）
    total +=
      lastUnit >= 100 && lastUnit < 10000 && /[百千][一二两三四五六七八九]$/.test(s)
        ? digit * (lastUnit / 10)
        : digit;
  }
  return total;
}

/** 中文数（可带“点”的小数） */
function cnNumber(s: string): number | null {
  const [int, frac, ...more] = s.split('点');
  if (more.length) return null;
  const i = cnInteger(int ?? '');
  if (i === null) return null;
  if (frac === undefined) return i;
  if (!/^[零〇一二两三四五六七八九]+$/.test(frac)) return null;
  return Number(`${i}.${[...frac].map((c) => CN_DIGITS[c]).join('')}`);
}

const NUMBER_TOKEN = /\d+(?:\.\d+)?|[零〇一幺二两三四五六七八九十百千万点]+/g;

/** 文字里的数，按出现顺序；“半”跟在数后面算 0.5（“七个半小时”） */
export function extractNumbers(text: string): number[] {
  // 千分位逗号只在“12,000 步”这种说法里合并；“86，132”是两个数
  const t = compact(text).replace(/(\d),(\d{3})(?=步)/g, '$1$2');
  const out: number[] = [];
  for (const m of t.matchAll(NUMBER_TOKEN)) {
    const token = m[0];
    // 单独的“点”“十”这类不是数；“一点”这种时间说法也会被当成数，靠复述确认挡住
    const value = /^\d/.test(token) ? Number(token) : cnNumber(token);
    if (value === null || !Number.isFinite(value)) continue;
    if (token === '点') continue;
    const after = t.slice((m.index ?? 0) + token.length);
    out.push(/^个?半/.test(after) ? value + 0.5 : value);
  }
  return out;
}

/**
 * 测量回答里的数值，按 CHECKIN_METRIC_READINGS 的顺序（血压是高压、低压）。
 * 数的个数不对时为 null；超出合理范围的照样返回，由调用方决定请客户再说一遍。
 * 体重说“斤”时换算成公斤；血压两个数按大小分高压、低压（客户常先说低压）。
 */
export function parseCheckinReading(metric: CheckinMetric, text: string): number[] | null {
  const t = compact(text);
  const nums = extractNumbers(t).filter((n) => n > 0 || metric === 'steps');
  if (metric === 'bp') {
    if (nums.length !== 2) return null;
    const [a, b] = nums as [number, number];
    return a >= b ? [a, b] : [b, a];
  }
  if (nums.length !== 1) return null;
  let value = nums[0]!;
  if (metric === 'weight' && /斤/.test(t) && !/公斤|千克/.test(t)) value = value / 2;
  return [Math.round(value * 1000) / 1000];
}

/** 中文念法：132 → 一百三十二；7.8 → 七点八（合成语音时数字念得更准） */
export function spokenNumber(n: number): string {
  const DIGITS = '零一二三四五六七八九';
  const [intPart, fracPart] = String(Math.round(n * 1000) / 1000).split('.');
  const int = Number(intPart);
  const say = (x: number): string => {
    if (x < 10) return DIGITS[x]!;
    if (x < 20) return `十${x % 10 ? DIGITS[x % 10] : ''}`;
    const units: [number, string][] = [
      [10000, '万'],
      [1000, '千'],
      [100, '百'],
      [10, '十'],
    ];
    let out = '';
    let rest = x;
    let zero = false;
    for (const [u, name] of units) {
      const d = Math.floor(rest / u);
      rest %= u;
      if (d) {
        if (zero) out += '零';
        out += (u === 10000 ? say(d) : DIGITS[d]) + name;
        zero = false;
      } else if (out) {
        zero = true;
      }
    }
    if (rest) out += (zero ? '零' : '') + DIGITS[rest];
    return out;
  };
  const head = say(int);
  if (!fracPart) return head;
  return `${head}点${[...fracPart].map((d) => DIGITS[Number(d)]).join('')}`;
}

/** 测量项目的口语名（替换 reminder_measurement 的 {metric}） */
export const CHECKIN_METRIC_SPOKEN: Readonly<Record<CheckinMetric, string>> = {
  bp: '血压',
  fpg: '空腹血糖',
  weight: '体重',
  steps: '步数',
  sleep_hours: '睡眠时间',
};

/** 复述的内容（替换 checkin_confirm_reading 的 {reading}）：只复述，不评价 */
export function spokenReading(metric: CheckinMetric, values: readonly number[]): string {
  const [a = 0, b = 0] = values;
  switch (metric) {
    case 'bp':
      return `高压${spokenNumber(a)}，低压${spokenNumber(b)}`;
    case 'fpg':
      return `空腹血糖${spokenNumber(a)}`;
    case 'weight':
      return `体重${spokenNumber(a)}公斤`;
    case 'steps':
      return `走了${spokenNumber(a)}步`;
    case 'sleep_hours':
      return `睡了${spokenNumber(a)}个小时`;
  }
}

/** 替换话术里的占位符；没有给值的占位符原样保留（调用方保证都给了） */
export function renderCompanionScript(
  text: string,
  vars: Readonly<Record<string, string>>,
): string {
  return text.replace(/\{([a-z]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
