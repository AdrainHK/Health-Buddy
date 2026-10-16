import { ApiError } from '../api/http';

export type RecordErrorKey = 'notFound' | 'badRequest' | 'tooMany' | 'network' | 'unknown';

/** 档案接口错误的分类，对应 record.errors.* 文案 */
export function recordErrorKey(err: unknown): RecordErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'network') return 'network';
  if (err.status === 400) return 'badRequest';
  if (err.status === 404) return 'notFound';
  if (err.status === 429) return 'tooMany';
  return 'unknown';
}

/** 只显示日期部分：已是 YYYY-MM-DD 的原样返回，时间戳按本地时区取日期 */
export function displayDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
