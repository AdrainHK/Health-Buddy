import { ApiError } from '../api/http';

export type UploadErrorKey =
  | 'quotaExceeded'
  | 'notConfigured'
  | 'unsupportedType'
  | 'fileTooLarge'
  | 'tooManyFiles'
  | 'tooManyPages'
  | 'duplicateFile'
  | 'dailyLimit'
  | 'retryLimit'
  | 'tooMany'
  | 'notFound'
  | 'conflict'
  | 'badRequest'
  | 'network'
  | 'unknown';

/** 上传、重新识别、修改识别结果时的错误 → 提示文字的键 */
export function uploadErrorKey(err: unknown): UploadErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'network') return 'network';
  if (err.code === 'not_configured') return 'notConfigured';
  if (err.status === 415) return 'unsupportedType';
  if (err.status === 413) {
    if (err.reasons.includes('too_many_files')) return 'tooManyFiles';
    if (err.reasons.includes('too_many_pages')) return 'tooManyPages';
    return 'fileTooLarge';
  }
  // 套餐的本月识别页数用完（M7 规格 2.5）：提示人工查看原件
  if (err.code === 'quota_exceeded') return 'quotaExceeded';
  if (err.status === 429)
    return err.reasons.includes('daily_page_limit') ? 'dailyLimit' : 'tooMany';
  if (err.status === 409) {
    if (err.reasons.includes('duplicate_file')) return 'duplicateFile';
    if (err.reasons.includes('retry_limit')) return 'retryLimit';
    return 'conflict';
  }
  if (err.status === 404) return 'notFound';
  if (err.status === 400) return 'badRequest';
  return 'unknown';
}
