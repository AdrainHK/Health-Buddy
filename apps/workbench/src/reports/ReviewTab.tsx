import type { ClientSummary, ReportUploadSummary } from '@health-buddy/shared';
import { EmptyState } from '@health-buddy/ui';
import { ClipboardCheck, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './Reports.module.css';
import { ReviewView } from './ReviewView';
import { UploadButton } from './UploadButton';
import { UploadCard } from './UploadCard';

export interface ReviewTabProps {
  client: ClientSummary | null;
  /** 这位客户的识别记录，新的在前；null 表示看不到（非健管师）或还在加载 */
  uploads: ReportUploadSummary[] | null;
  selectedId: string | null;
  onSelect: (uploadId: string | null) => void;
  /** 识别记录有变化：重新加载列表和档案 */
  onChanged: () => void;
  taskId?: string | null;
  readOnly?: boolean;
}

/** 结果区“核对”标签：识别记录列表（带进度）和核对界面（规格 2.4） */
export function ReviewTab({
  client,
  uploads,
  selectedId,
  onSelect,
  onChanged,
  taskId = null,
  readOnly = false,
}: ReviewTabProps) {
  const { t } = useTranslation();
  if (selectedId) {
    return <ReviewView uploadId={selectedId} onChanged={onChanged} onBack={() => onSelect(null)} />;
  }
  if (!client) {
    return (
      <EmptyState
        icon={<ClipboardCheck size={20} />}
        title={t('reports.tab.noClient')}
        description={t('reports.tab.noClientHint')}
      />
    );
  }
  // 只显示还需要处理的和最近核对的；放弃的不显示
  const shown = (uploads ?? []).filter((u) => u.status !== 'discarded');
  return (
    <div className={styles.review}>
      {!readOnly && (
        <UploadButton
          clientId={client.id}
          taskId={taskId}
          label={t('reports.upload.button')}
          icon={<Upload size={16} />}
          onUploaded={() => onChanged()}
        />
      )}
      {uploads === null ? (
        <p className={styles.muted} role="status">
          {t('reports.tab.loading')}
        </p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={20} />}
          title={t('reports.tab.empty')}
          description={t('reports.tab.emptyHint')}
        />
      ) : (
        <ul className={styles.rows} aria-label={t('reports.tab.list')}>
          {shown.map((u) => (
            <li key={`${u.id}-${u.attempts}`}>
              <UploadCard
                upload={u}
                readOnly={readOnly}
                onReview={onSelect}
                onChanged={() => onChanged()}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
