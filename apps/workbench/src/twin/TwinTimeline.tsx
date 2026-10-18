import {
  TWIN_TIMELINE_TYPES,
  type TwinTimelineEvent,
  type TwinTimelineType,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAbortError } from '../api/http';
import { getTwinTimeline } from '../api/twin';
import { useExpertName } from '../experts/ExpertsContext';
import { useSkillName } from '../i18n/dynamic';
import { displayDate, displayDateTime } from './errors';
import { useMetricName } from './format';
import styles from './Twin.module.css';

type Load = 'loading' | 'ready' | 'error';

/** 一条事件的显示文字（规格 2.5）。更正不显示数值；产物不显示内容 */
function useEventText(): (e: TwinTimelineEvent) => string {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const expertName = useExpertName();
  const skillName = useSkillName();
  return useCallback(
    (e: TwinTimelineEvent) => {
      switch (e.type) {
        case 'report':
          return (
            t('twin.timeline.report', { date: e.reportDate, count: e.abnormalCount }) +
            (e.hasCritical ? ` · ${t('twin.timeline.reportCritical')}` : '')
          );
        case 'monitoring_alert':
          return t('twin.timeline.monitoringAlert', {
            metric: metricName(e.metric),
            date: e.date,
            rule: t(`twin.timeline.alertRule.${e.method}`),
          });
        case 'correction':
          return t('twin.timeline.correction', {
            metric: e.metric ? metricName(e.metric) : t('twin.timeline.correctionUnknown'),
            actor: e.actorName ?? t('twin.timeline.someone'),
          });
        case 'health_history':
          return t('twin.timeline.healthHistory', {
            category: t(`record.history.categories.${e.category}`),
            action: t(`twin.timeline.historyAction.${e.action}`),
            summary: e.summary,
          });
        case 'risk_tier':
          return t('twin.timeline.riskTier', {
            tier: t(`record.tier.levels.${e.tier}`),
            actor: e.setByName ?? t('twin.timeline.someone'),
            reason: e.reason,
          });
        case 'status_change': {
          const triggerKey = e.trigger as
            'rules_changed' | 'thresholds_changed' | 'backfill' | 'seed';
          const origin =
            e.origin === 'computed' &&
            ['rules_changed', 'thresholds_changed', 'backfill', 'seed'].includes(e.trigger)
              ? t(`twin.timeline.trigger.${triggerKey}`)
              : t(`twin.timeline.origin.${e.origin}`);
          const domain = t(`twin.domains.${e.domain}`);
          const to = t(`twin.levels.${e.to}`);
          return e.from
            ? t('twin.timeline.statusChange', {
                domain,
                from: t(`twin.levels.${e.from}`),
                to,
                origin,
              })
            : t('twin.timeline.statusFirst', { domain, to, origin });
        }
        case 'follow_up': {
          const extra = e.resolution
            ? ` · ${t(`followUps.form.resolutions.${e.resolution as 'other'}`, { defaultValue: '' })}`
            : e.dismissReason
              ? ` · ${t(`followUps.form.dismissReasons.${e.dismissReason as 'other'}`, { defaultValue: '' })}`
              : '';
          return (
            t('twin.timeline.followUp', {
              kind: t(`followUps.kinds.${e.kind}`),
              action: t(`twin.timeline.followUpAction.${e.action}`),
            }) + extra
          );
        }
        case 'expert':
          return t('twin.timeline.expert', {
            experts:
              e.expertIds.map((id) => expertName(id)).join(t('followUps.basis.separator')) ||
              t('twin.timeline.expertUnknown'),
          });
        case 'artifact':
          return t('twin.timeline.artifact', {
            kind: skillName(e.kind),
            action: t(`twin.timeline.artifactAction.${e.action}`),
          });
      }
    },
    [t, metricName, expertName, skillName],
  );
}

/**
 * 时间轴（规格 2.5）：按时间倒序、按月分组，可以按类型筛选，加载更早的。
 */
export function TwinTimeline({ clientId, refreshKey }: { clientId: string; refreshKey: number }) {
  const { t } = useTranslation();
  const text = useEventText();
  const filterId = useId();
  const [type, setType] = useState<TwinTimelineType | 'all'>('all');
  const [events, setEvents] = useState<TwinTimelineEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [state, setState] = useState<Load>('loading');
  const [more, setMore] = useState<Load>('ready');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    getTwinTimeline(clientId, { types: type === 'all' ? [] : [type] }, controller.signal)
      .then((res) => {
        setEvents(res.events);
        setNextBefore(res.nextBefore);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setState('error');
      });
    return () => controller.abort();
  }, [clientId, type, refreshKey]);

  const loadMore = () => {
    if (!nextBefore) return;
    setMore('loading');
    getTwinTimeline(clientId, { before: nextBefore, types: type === 'all' ? [] : [type] })
      .then((res) => {
        setEvents((list) => [
          ...list,
          ...res.events.filter((e) => !list.some((x) => x.id === e.id)),
        ]);
        setNextBefore(res.nextBefore);
        setMore('ready');
      })
      .catch(() => setMore('error'));
  };

  const groups: { key: string; year: number; month: number; events: TwinTimelineEvent[] }[] = [];
  for (const e of events) {
    const d = new Date(e.at);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(e);
    else groups.push({ key, year: d.getFullYear(), month: d.getMonth() + 1, events: [e] });
  }

  return (
    <>
      <label className={styles.filter} htmlFor={filterId}>
        {t('twin.timeline.filter')}
        <select
          id={filterId}
          className={styles.select}
          value={type}
          onChange={(e) => setType(e.target.value as TwinTimelineType | 'all')}
        >
          <option value="all">{t('twin.timeline.all')}</option>
          {TWIN_TIMELINE_TYPES.map((v) => (
            <option key={v} value={v}>
              {t(`twin.timeline.types.${v}`)}
            </option>
          ))}
        </select>
      </label>
      {state === 'loading' && events.length === 0 && (
        <p className={styles.muted} role="status">
          {t('twin.timeline.loading')}
        </p>
      )}
      {state === 'error' && (
        <p className={styles.error} role="alert">
          {t('twin.timeline.loadFailed')}
        </p>
      )}
      {state === 'ready' && events.length === 0 && (
        <p className={styles.muted}>{t('twin.timeline.empty')}</p>
      )}
      {groups.map((g) => (
        <section key={g.key} className={styles.month} aria-label={t('twin.timeline.month', g)}>
          <h6 className={styles.monthTitle}>{t('twin.timeline.month', g)}</h6>
          <ol className={styles.events}>
            {g.events.map((e) => (
              <li key={e.id} className={styles.event} data-type={e.type}>
                <span className={styles.eventType}>{t(`twin.timeline.types.${e.type}`)}</span>
                <span className={styles.eventText}>{text(e)}</span>
                <time className={styles.muted} dateTime={e.at} title={displayDateTime(e.at)}>
                  {displayDate(e.at)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {nextBefore && (
        <div>
          <Button onClick={loadMore} disabled={more === 'loading'}>
            {t('twin.timeline.loadMore')}
          </Button>
          {more === 'error' && (
            <p className={styles.error} role="alert">
              {t('twin.timeline.loadFailed')}
            </p>
          )}
        </div>
      )}
    </>
  );
}
