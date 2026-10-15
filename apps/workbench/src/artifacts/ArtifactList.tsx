import type { ArtifactSummary } from '@health-buddy/shared';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSkillName } from '../i18n/dynamic';
import styles from './ArtifactList.module.css';
import { StatusBadge } from './ArtifactView';

/** 新的在前：先按生成时间，同一时间按版本号 */
export function sortArtifacts(items: readonly ArtifactSummary[]): ArtifactSummary[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version);
}

export interface ArtifactListProps {
  artifacts: readonly ArtifactSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** 当前任务的产物列表，每一版一行，带状态 */
export function ArtifactList({ artifacts, selectedId, onSelect }: ArtifactListProps) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  return (
    <ul className={styles.list} aria-label={t('results.artifacts.list')}>
      {sortArtifacts(artifacts).map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={styles.item}
            aria-current={item.id === selectedId ? true : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span className={styles.name}>
              {t('results.artifacts.item', {
                name: skillName(item.skillId),
                version: item.version,
              })}
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
