import { ApiError } from '../api/http';

export type ArtifactErrorKey =
  'busy' | 'tooMany' | 'readOnly' | 'badRequest' | 'notFound' | 'conflict' | 'network' | 'unknown';

/**
 * 产物接口错误的分类。stale 表示版本号或内容指纹已过期（别处改过），
 * 调用方需要提示并重新加载。
 */
export type ArtifactErrorKind = { kind: 'stale' } | { kind: 'error'; key: ArtifactErrorKey };

export function classifyArtifactError(err: unknown): ArtifactErrorKind {
  if (!(err instanceof ApiError)) return { kind: 'error', key: 'unknown' };
  if (err.code === 'network') return { kind: 'error', key: 'network' };
  if (err.status === 429) return { kind: 'error', key: 'tooMany' };
  if (err.status === 409) {
    if (err.reasons.includes('read_only')) return { kind: 'error', key: 'readOnly' };
    if (err.reasons.includes('busy')) return { kind: 'error', key: 'busy' };
    if (err.reasons.includes('not_latest_draft')) return { kind: 'stale' };
    // 没有具体原因的 409：状态已经变了，同样按过期处理并刷新
    return { kind: 'error', key: 'conflict' };
  }
  if (err.status === 400) return { kind: 'error', key: 'badRequest' };
  if (err.status === 404) return { kind: 'error', key: 'notFound' };
  return { kind: 'error', key: 'unknown' };
}
