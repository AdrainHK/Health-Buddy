import type { FollowUpListResponse } from '@health-buddy/shared';
import { compareFollowUps } from '@health-buddy/shared';
import { Button, EmptyState, IconButton } from '@health-buddy/ui';
import { BellRing, Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FollowUpCard } from './FollowUpCard';
import { followUpTwinRef, useCanAskExpert, useTwinActions } from './TwinActions';
import styles from './Twin.module.css';

export interface FollowUpListState {
  status: 'loading' | 'ready' | 'error';
  data: FollowUpListResponse | null;
}

export interface FollowUpCenterProps {
  narrow: boolean;
  onOpenMenu: () => void;
  state: FollowUpListState;
  onRetry: () => void;
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
}

/**
 * 中间区域的“今日跟进”清单（规格 2.6，Q12）：健管师所有客户的未处理项目，
 * 严重程度（1 级最先）→ 同级按最近触发时间从新到旧。“今日”按健管师时区（Q13）。
 */
export function FollowUpCenter({
  narrow,
  onOpenMenu,
  state,
  onRetry,
  onOpenClient,
  onChanged,
}: FollowUpCenterProps) {
  const { t } = useTranslation();
  const items = [...(state.data?.items ?? [])].sort(compareFollowUps);
  const { askExpert } = useTwinActions();
  const canAskExpert = useCanAskExpert();
  return (
    <main className={styles.center}>
      <header className={styles.topbar}>
        {narrow && (
          <IconButton
            label={t('nav.openMenu')}
            icon={<Menu size={18} />}
            aria-controls="hb-sidebar"
            onClick={onOpenMenu}
          />
        )}
        <h1 className={styles.topbarTitle}>{t('followUps.title')}</h1>
      </header>
      <div className={styles.scroll}>
        <div className={styles.column}>
          {state.data && (
            <p className={styles.intro}>
              {t('followUps.intro', { timeZone: state.data.timeZone })}
            </p>
          )}
          {state.status === 'loading' && !state.data && (
            <p className={styles.muted} role="status">
              {t('followUps.loading')}
            </p>
          )}
          {state.status === 'error' && !state.data && (
            <div role="alert">
              <p className={styles.error}>{t('followUps.loadFailed')}</p>
              <Button onClick={onRetry}>{t('followUps.retry')}</Button>
            </div>
          )}
          {state.data && items.length === 0 && (
            <EmptyState icon={<BellRing size={20} />} title={t('followUps.empty')} />
          )}
          {items.length > 0 && (
            <ul className={styles.followUpList} aria-label={t('followUps.list')}>
              {items.map((item) => {
                const ref = canAskExpert ? followUpTwinRef(item) : null;
                return (
                  <FollowUpCard
                    key={item.id}
                    item={item}
                    showClient
                    onOpenClient={onOpenClient}
                    onChanged={onChanged}
                    {...(ref && askExpert
                      ? {
                          onAskExpert: () =>
                            askExpert({
                              client: { id: item.clientId, displayName: item.clientName },
                              ref,
                              followUpItemId: item.id,
                            }),
                        }
                      : {})}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
