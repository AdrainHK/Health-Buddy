import { ApiError } from '../api/http';

export type TwinErrorKey =
  'badRequest' | 'notFound' | 'conflict' | 'tooMany' | 'network' | 'unknown';

/** 孪生、跟进、手动录入接口错误的分类，对应各自的 errors.* 文案 */
export function twinErrorKey(err: unknown): TwinErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'network') return 'network';
  if (err.status === 400) return 'badRequest';
  if (err.status === 404) return 'notFound';
  if (err.status === 409) return 'conflict';
  if (err.status === 429) return 'tooMany';
  return 'unknown';
}

/** 只显示日期部分（本地时区） */
export { displayDate } from '../record/errors';

/** 日期和时间（本地时区），如 2026-10-18 09:30 */
export function displayDateTime(value: string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
