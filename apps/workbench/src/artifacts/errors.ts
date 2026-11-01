import { ApiError } from '../api/http';

export type ArtifactErrorKey =
  | 'busy'
  | 'tooMany'
  | 'readOnly'
  | 'notClientFacing'
  | 'formatNotAllowed'
  | 'signatureInvalid'
  | 'contentCheckFailed'
  | 'noCompanion'
  | 'notLatest'
  | 'notCurrentPlan'
  | 'sourceReportGone'
  | 'badRequest'
  | 'notFound'
  | 'conflict'
  | 'network'
  | 'unknown';

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
    // 只有专业版的产物（/面谈提纲）不能复制、导出
    if (err.reasons.includes('not_client_facing')) return { kind: 'error', key: 'notClientFacing' };
    // 同步给伴侣：客户没有绑定设备或已撤回同意（M6 规格 2.8）
    // 科普（M8）：这种产物不能用这个格式；署名不全；按当前规则有“禁止”类问题
    if (err.reasons.includes('format_not_allowed'))
      return { kind: 'error', key: 'formatNotAllowed' };
    if (err.reasons.includes('signature_invalid'))
      return { kind: 'error', key: 'signatureInvalid' };
    if (err.reasons.includes('content_check_failed')) {
      return { kind: 'error', key: 'contentCheckFailed' };
    }
    if (err.reasons.includes('no_companion')) return { kind: 'error', key: 'noCompanion' };
    if (err.reasons.includes('not_latest')) return { kind: 'error', key: 'notLatest' };
    if (err.reasons.includes('not_current_plan')) return { kind: 'error', key: 'notCurrentPlan' };
    // 依据的报告已不可用：不能按原报告重写
    if (err.reasons.includes('source_report_unavailable')) {
      return { kind: 'error', key: 'sourceReportGone' };
    }
    if (err.reasons.includes('not_latest_draft')) return { kind: 'stale' };
    // 没有具体原因的 409：状态已经变了，同样按过期处理并刷新
    return { kind: 'error', key: 'conflict' };
  }
  if (err.status === 400) return { kind: 'error', key: 'badRequest' };
  if (err.status === 404) return { kind: 'error', key: 'notFound' };
  return { kind: 'error', key: 'unknown' };
}
