import { REPORT_UPLOAD_LIMITS, type ReportUploadSummary } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { CircleAlert, FileSearch, FileCheck2, Loader } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isActive, retryUpload } from '../api/reports';
import { uploadErrorKey } from './errors';
import styles from './Reports.module.css';
import { useUploadStatus } from './useUploadStatus';

export interface UploadCardProps {
  upload: ReportUploadSummary;
  /** 打开核对界面 */
  onReview?: (uploadId: string) => void;
  /** 状态变了（识别完成、重新识别） */
  onChanged?: (upload: ReportUploadSummary) => void;
  /** 核对确认后“生成解读”（规格 2.5 第 1 条）；只在对话区里提供 */
  onInterpret?: () => void;
  readOnly?: boolean;
}

/**
 * 识别进度卡片（对话区和核对标签里都用，规格 2.3 第 7 条）。
 * 只显示状态和页数，不显示任何识别出的数值。
 */
export function UploadCard({
  upload: initial,
  onReview,
  onChanged,
  onInterpret,
  readOnly,
}: UploadCardProps) {
  const { t } = useTranslation();
  const [override, setOverride] = useState<ReportUploadSummary | null>(null);
  const base = override && override.id === initial.id ? newer(override, initial) : initial;
  const upload = useUploadStatus(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 识别结束（待核对、失败）时通知上层刷新列表和角标
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const prevStatus = useRef(upload.status);
  useEffect(() => {
    if (isActive(prevStatus.current) && !isActive(upload.status)) onChangedRef.current?.(upload);
    prevStatus.current = upload.status;
  }, [upload]);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await retryUpload(upload.id);
      setOverride(next);
      onChanged?.(next);
    } catch (err) {
      setError(t(`reports.errors.${uploadErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const canRetry =
    !readOnly && upload.status === 'failed' && upload.attempts < REPORT_UPLOAD_LIMITS.maxAttempts;

  return (
    <section
      className={styles.card}
      data-status={upload.status}
      aria-label={t('reports.card.label')}
      aria-busy={upload.status === 'queued' || upload.status === 'processing'}
    >
      <p className={styles.cardTitle}>
        {upload.status === 'queued' || upload.status === 'processing' ? (
          <Loader size={14} className={styles.spin} aria-hidden />
        ) : upload.status === 'failed' ? (
          <CircleAlert size={14} aria-hidden />
        ) : upload.status === 'verified' ? (
          <FileCheck2 size={14} aria-hidden />
        ) : (
          <FileSearch size={14} aria-hidden />
        )}
        <span role="status">{statusText(t, upload)}</span>
      </p>
      {upload.status === 'processing' && (
        <progress
          className={styles.progress}
          max={upload.pageCount}
          value={upload.progressPage}
          aria-label={t('reports.card.progressLabel')}
        />
      )}
      {upload.status === 'failed' && upload.failureCategory && (
        <p className={styles.muted}>{t(`reports.failure.${upload.failureCategory}`)}</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {upload.status === 'needs_review' && onReview && (
          <Button variant="primary" onClick={() => onReview(upload.id)}>
            {t('reports.card.review')}
          </Button>
        )}
        {upload.status === 'verified' && upload.reportId && onInterpret && !readOnly && (
          <Button variant="primary" onClick={onInterpret}>
            {t('reports.card.interpret')}
          </Button>
        )}
        {upload.status === 'verified' && onReview && (
          <Button variant="ghost" onClick={() => onReview(upload.id)}>
            {t('reports.card.view')}
          </Button>
        )}
        {canRetry && (
          <Button onClick={() => void retry()} disabled={busy}>
            {t('reports.card.retry')}
          </Button>
        )}
      </div>
    </section>
  );
}

/** 本地重新识别后的状态和外面刷新出来的状态，用次数和状态较新的那个 */
function newer(a: ReportUploadSummary, b: ReportUploadSummary): ReportUploadSummary {
  if (a.attempts !== b.attempts) return a.attempts > b.attempts ? a : b;
  return b;
}

type T = ReturnType<typeof useTranslation>['t'];

export function statusText(t: T, upload: ReportUploadSummary): string {
  switch (upload.status) {
    case 'queued':
      return t('reports.status.queued', { pages: upload.pageCount });
    case 'processing':
      return t('reports.status.processing', {
        page: Math.max(upload.progressPage, 1),
        total: upload.pageCount,
      });
    case 'needs_review':
      return t('reports.status.needs_review');
    case 'verified':
      return t('reports.status.verified');
    case 'failed':
      return t('reports.status.failed');
    case 'discarded':
      return t('reports.status.discarded');
  }
}
