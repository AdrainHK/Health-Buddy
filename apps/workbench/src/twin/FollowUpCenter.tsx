import type { FollowUpListResponse, TodayVisitsResponse } from '@health-buddy/shared';
import { compareFollowUps } from '@health-buddy/shared';
import { Button, EmptyState, IconButton } from '@health-buddy/ui';
import { BellRing, Menu } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import care from '../care/Care.module.css';
import { CompanionInboxGroup, type CompanionInboxState } from '../companion/CompanionInbox';
import { VisitCard } from '../care/VisitCard';
import { FollowUpCard } from './FollowUpCard';
import { followUpTwinRef, useCanAskExpert, useTwinActions } from './TwinActions';
import styles from './Twin.module.css';

export interface FollowUpListState {
  status: 'loading' | 'ready' | 'error';
  data: FollowUpListResponse | null;
}

export interface TodayVisitsState {
  status: 'loading' | 'ready' | 'error';
  data: TodayVisitsResponse | null;
}

export interface FollowUpCenterProps {
  narrow: boolean;
  onOpenMenu: () => void;
  state: FollowUpListState;
  onRetry: () => void;
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
  /** 今日随访（M5 规格 2.7，Q19）；没有传时不显示这个分组 */
  visits?: TodayVisitsState;
  onVisitsRetry?: () => void;
  onVisitsChanged?: () => void;
  /** 伴侣（M6 规格 2.8）：预警置顶；没有传时不显示这个分组 */
  companion?: CompanionInboxState;
  onCompanionRetry?: () => void;
  onCompanionChanged?: () => void;
}

/**
 * 中间区域的“今日跟进”清单（规格 2.6，Q12）：健管师所有客户的未处理项目，
 * 严重程度（1 级最先）→ 同级按最近触发时间从新到旧。“今日”按健管师时区（Q13）。
 * M5 起分两组（M5 规格 2.7，Q19）：“异常跟进”（M4 原样）和“今日随访”（今天到期和逾期未处理的随访，
 * 按逾期天数 → 目的 → 时间排序，后端排好）。
 * M6 起最上面加“伴侣”分组（M6 规格 2.8）：福宝的预警置顶，转交、待确认的测量、设备离线。
 */
export function FollowUpCenter({
  narrow,
  onOpenMenu,
  state,
  onRetry,
  onOpenClient,
  onChanged,
  visits,
  onVisitsRetry,
  onVisitsChanged,
  companion,
  onCompanionRetry,
  onCompanionChanged,
}: FollowUpCenterProps) {
  const { t } = useTranslation();
  const alertsId = useId();
  const visitsId = useId();
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
          {companion && (
            <CompanionInboxGroup
              state={companion}
              onRetry={onCompanionRetry ?? onRetry}
              onOpenClient={onOpenClient}
              onChanged={onCompanionChanged ?? onChanged}
            />
          )}
          {visits && (
            <h2 id={alertsId} className={care.groupTitle}>
              {t('followUps.groups.alerts')}
              {state.data && (
                <span className={care.groupCount}>
                  {t('followUps.groups.count', { count: state.data.openCount })}
                </span>
              )}
            </h2>
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
            <ul
              className={styles.followUpList}
              aria-label={visits ? t('followUps.groups.alerts') : t('followUps.list')}
            >
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
          {visits && (
            <section aria-labelledby={visitsId}>
              <h2 id={visitsId} className={care.groupTitle}>
                {t('followUps.groups.visits')}
                {visits.data && (
                  <span className={care.groupCount}>
                    {t('followUps.groups.count', { count: visits.data.count })}
                  </span>
                )}
              </h2>
              {visits.status === 'loading' && !visits.data && (
                <p className={styles.muted} role="status">
                  {t('followUps.loading')}
                </p>
              )}
              {visits.status === 'error' && !visits.data && (
                <div role="alert">
                  <p className={styles.error}>{t('followUps.visitsLoadFailed')}</p>
                  {onVisitsRetry && <Button onClick={onVisitsRetry}>{t('followUps.retry')}</Button>}
                </div>
              )}
              {visits.data && visits.data.items.length === 0 && (
                <p className={styles.muted}>{t('followUps.visitsEmpty')}</p>
              )}
              {visits.data && visits.data.items.length > 0 && (
                <ul className={styles.followUpList} aria-label={t('followUps.groups.visits')}>
                  {visits.data.items.map((v) => (
                    <VisitCard
                      key={v.id}
                      visit={v}
                      clientName={v.clientName}
                      overdueDays={v.overdueDays}
                      onOpenClient={onOpenClient}
                      onChanged={onVisitsChanged ?? onChanged}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
