import type { ArtifactSummary } from '@health-buddy/shared';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './ArtifactList.module.css';
import { StatusBadge } from './ArtifactView';
import { useArtifactSource, useArtifactTitle } from './artifactTitle';

/** 新的在前：先按生成时间，同一时间按版本号 */
export function sortArtifacts(items: readonly ArtifactSummary[]): ArtifactSummary[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version);
}

export interface ArtifactListProps {
  artifacts: readonly ArtifactSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 客户称呼，放进标题（验收反馈）；没有关联客户时省略 */
  clientName?: string | null;
  /** 列表的无障碍名称，默认“本任务的产物” */
  label?: string;
}

/** 当前任务的产物列表，每一版一行，带状态；名称是“称呼 内容概括 日期 第几版”，悬停显示依据的报告 */
export function ArtifactList({
  artifacts,
  selectedId,
  onSelect,
  clientName = null,
  label,
}: ArtifactListProps) {
  const { t } = useTranslation();
  const title = useArtifactTitle();
  const source = useArtifactSource();
  return (
    <ul className={styles.list} aria-label={label ?? t('results.artifacts.list')}>
      {sortArtifacts(artifacts).map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={styles.item}
            aria-current={item.id === selectedId ? true : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span className={styles.name} title={source(item)}>
              {title(item, clientName)}
            </span>
            {item.hasCriticalFlags && (
              <span className={styles.critical} title={t('results.artifacts.criticalBadge')}>
                <TriangleAlert size={14} aria-hidden />
                <span className={styles.srOnly}>{t('results.artifacts.criticalBadge')}</span>
              </span>
            )}
            <StatusBadge status={item.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}
