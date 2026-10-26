/**
 * 方案和随访用到的日期工具。日期一律是 YYYY-MM-DD 字符串（按健管师时区的“日历日”），
 * 计算时按 UTC 处理，不受运行环境时区影响。
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): Date {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError('invalid ISO date');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== date) throw new RangeError('invalid ISO date');
  return d;
}

export function isIsoDate(date: string): boolean {
  try {
    parse(date);
    return true;
  } catch {
    return false;
  }
}

export function addDaysIso(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** b - a 的天数 */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** ISO 星期：1 = 周一 … 7 = 周日 */
export function isoWeekday(date: string): number {
  const day = parse(date).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWeekend(date: string): boolean {
  return isoWeekday(date) >= 6;
}

/** 周六、周日顺延到下周一（规格第五节之二） */
export function shiftWeekendToMonday(date: string): string {
  const wd = isoWeekday(date);
  return wd === 6 ? addDaysIso(date, 2) : wd === 7 ? addDaysIso(date, 1) : date;
}

/** 按 IANA 时区取某一时刻的日历日。时区不存在时抛 RangeError（Intl 的行为） */
export function dateInTimeZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
