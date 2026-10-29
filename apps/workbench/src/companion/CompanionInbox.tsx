import type { CompanionInboxResponse } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ackCompanionOffline } from '../api/companion';
import care from '../care/Care.module.css';
import { displayDateTime } from '../twin/errors';
import styles from '../twin/Twin.module.css';
import { AlertItem, caseErrorText, HandoffItem, ObservationItem } from './CompanionCases';
import companion from './Companion.module.css';

export interface CompanionInboxState {
  status: 'loading' | 'ready' | 'error';
  data: CompanionInboxResponse | null;
}

/** 角标：未处理的预警、转交、待确认的测量三组相加（规格 2.8，设备离线不算） */
export function companionInboxCount(data: CompanionInboxResponse | null): number {
  if (!data) return 0;
  return data.alerts.length + data.handoffs.length + data.pendingReadings.length;
}

/**
 * 今日跟进的“伴侣”分组（M6 规格 2.5、2.8、N14、N18）：未处理的预警置顶（红色），
 * 转交（超过 48 小时标“已超时”），待确认的测量，离线超过 24 小时的设备。
 */
export function CompanionInboxGroup({
  state,
  onRetry,
  onOpenClient,
  onChanged,
}: {
  state: CompanionInboxState;
  onRetry: () => void;
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const data = state.data;
  const empty =
    data &&
    !data.alerts.length &&
    !data.handoffs.length &&
    !data.pendingReadings.length &&
    !data.offlineDevices.length;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className={care.groupTitle}>
        {t('followUps.groups.companion')}
        {data && (
          <span className={care.groupCount}>
            {t('followUps.groups.count', { count: companionInboxCount(data) })}
          </span>
        )}
      </h2>
      {state.status === 'loading' && !data && (
        <p className={styles.muted} role="status">
          {t('followUps.loading')}
        </p>
      )}
      {state.status === 'error' && !data && (
        <div role="alert">
          <p className={styles.error}>{t('companion.inbox.loadFailed')}</p>
          <Button onClick={onRetry}>{t('followUps.retry')}</Button>
        </div>
      )}
      {empty && <p className={styles.muted}>{t('companion.inbox.empty')}</p>}
      {data && data.alerts.length > 0 && (
        <ul className={companion.planList} aria-label={t('companion.inbox.alerts')}>
          {data.alerts.map((a) => (
            <AlertItem
              key={a.id}
              alert={a}
              showClient
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {data && data.handoffs.length > 0 && (
        <ul className={companion.planList} aria-label={t('companion.inbox.handoffs')}>
          {data.handoffs.map((h) => (
            <HandoffItem
              key={h.id}
              handoff={h}
              showClient
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {data && data.pendingReadings.length > 0 && (
        <ul className={companion.planList} aria-label={t('companion.inbox.pendingReadings')}>
          {data.pendingReadings.map((o) => (
            <ObservationItem
              key={o.id}
              observation={o}
              clientName={o.clientName}
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {data && data.offlineDevices.length > 0 && (
        <ul className={companion.planList} aria-label={t('companion.inbox.offline')}>
          {data.offlineDevices.map((d) => (
            <OfflineItem
              key={d.clientId}
              device={d}
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function OfflineItem({
  device,
  onOpenClient,
  onChanged,
}: {
  device: CompanionInboxResponse['offlineDevices'][number];
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className={companion.caseItem} data-kind="offline">
      <div className={companion.planHeader}>
        <strong>{t('companion.inbox.offlineTitle')}</strong>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => onOpenClient(device.clientId)}
        >
          {device.clientName}
        </button>
      </div>
      <p className={styles.cardLine}>
        {device.lastSeenAt
          ? t('companion.inbox.lastSeen', { time: displayDateTime(device.lastSeenAt) })
          : t('companion.inbox.neverSeen')}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            ackCompanionOffline(device.clientId)
              .then(onChanged)
              .catch((err: unknown) => setError(caseErrorText(t, err)))
              .finally(() => setBusy(false));
          }}
        >
          {t('companion.inbox.ack')}
        </Button>
      </div>
    </li>
  );
}
