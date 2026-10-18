/**
 * 按健管师时区算“今日”（M4 规格 2.6，Q13）。只用 Intl，不依赖服务器的时区。
 */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(instant: number, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instant))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** 某个时刻在这个时区是哪一天（YYYY-MM-DD） */
export function localDate(instant: Date | number, tz: string): string {
  const p = parts(typeof instant === 'number' ? instant : instant.getTime(), tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 这个时区在某个时刻比 UTC 快多少毫秒 */
function offsetMs(instant: number, tz: string): number {
  const p = parts(instant, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** 这个时区某一天的 0 点对应的 UTC 时刻（考虑夏令时） */
export function zonedDayStart(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetMs(wall, tz);
  // 夏令时切换当天偏移可能不同，按算出的时刻再校正一次
  t = wall - offsetMs(t, tz);
  return new Date(t);
}

/** 日期加天数（YYYY-MM-DD） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 两个日期相差几天（b - a） */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
