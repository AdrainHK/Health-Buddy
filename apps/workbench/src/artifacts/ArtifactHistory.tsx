import type { ArtifactDetailResponse, ArtifactEvent } from '@health-buddy/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ArtifactHistory.module.css';
import { StatusBadge } from './ArtifactView';
import { useArtifactSource, useArtifactTitle } from './artifactTitle';

/** 确认时勾选了“已知悉”危急指标，后端记在 reason 里 */
const CRITICAL_ACKNOWLEDGED = 'critical_acknowledged';

export interface ArtifactHistoryProps {
  detail: ArtifactDetailResponse;
  onOpenVersion: (artifactId: string) => void;
  /** 客户称呼，放进版本标题（验收反馈：只写“第 1 版”难以识别） */
  clientName?: string | null;
}

/**
 * 版本列表和修改、审核、复制、导出记录。
 * 只显示谁、什么时候、做了什么，不显示内容（退回原因也不显示）。
 */
export function ArtifactHistory({
  detail,
  onOpenVersion,
  clientName = null,
}: ArtifactHistoryProps) {
  const { t, i18n } = useTranslation();
  const title = useArtifactTitle();
  const source = useArtifactSource();
  const format = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const versionOf = new Map(detail.versions.map((v) => [v.id, v.version]));
  const events = [...detail.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const describe = (event: ArtifactEvent) => {
    const action = t(`results.history.actions.${event.action}`);
    const extra: string[] = [];
    if (event.format) extra.push(t(`results.history.format.${event.format}`));
    if (event.action === 'approved' && event.reason === CRITICAL_ACKNOWLEDGED) {
      extra.push(t('results.history.acknowledged'));
    }
    return extra.length
      ? t('results.history.withDetail', {
          action,
          detail: extra.join(t('results.history.separator')),
        })
      : action;
  };

  return (
    <div className={styles.root}>
      <h3 className={styles.title}>{title(detail.artifact, clientName)}</h3>
      <section aria-labelledby="hb-history-versions">
        <h3 id="hb-history-versions" className={styles.heading}>
          {t('results.history.versions')}
        </h3>
        <ul className={styles.versions}>
          {[...detail.versions]
            .sort((a, b) => b.version - a.version)
            .map((v) => {
              const current = v.id === detail.artifact.id;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    className={styles.version}
                    aria-current={current ? true : undefined}
                    aria-label={t('results.history.open', { version: v.version })}
                    onClick={() => onOpenVersion(v.id)}
                  >
                    <span className={styles.versionName} title={source(v)}>
                      {title(v, clientName)}
                    </span>
                    <time className={styles.time} dateTime={v.createdAt}>
                      {format.format(new Date(v.createdAt))}
                    </time>
                    <StatusBadge status={v.status} />
                  </button>
                </li>
              );
            })}
        </ul>
      </section>

      <section aria-labelledby="hb-history-events">
        <h3 id="hb-history-events" className={styles.heading}>
          {t('results.history.events')}
        </h3>
        {events.length === 0 ? (
          <p className={styles.empty}>{t('results.history.noEvents')}</p>
        ) : (
          <ol className={styles.events}>
            {events.map((event) => {
              const version = versionOf.get(event.artifactId);
              return (
                <li key={event.id} className={styles.event}>
                  <span>
                    {t('results.history.entry', {
                      actor:
                        event.actorId === null
                          ? t('results.history.actorSystem')
                          : t('results.history.actorSelf'),
                      action: describe(event),
                    })}
                  </span>
                  <span className={styles.meta}>
                    {version !== undefined && (
                      <span>{t('results.history.versionTag', { version })}</span>
                    )}
                    <time dateTime={event.createdAt}>
                      {format.format(new Date(event.createdAt))}
                    </time>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
