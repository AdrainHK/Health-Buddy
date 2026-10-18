import type { AdminExpert, CurrentUser, ExpertAvailabilityEvent } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { History, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listAdminExperts, listAvailabilityEvents, setExpertAvailability } from '../api/experts';
import { Dialog } from '../thresholds/Dialog';
import base from '../thresholds/Thresholds.module.css';
import styles from './Experts.module.css';

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; experts: AdminExpert[]; from: string; to: string };

type HistoryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; events: ExpertAvailabilityEvent[] };

/**
 * 平台总后台的专家管理（M3 规格 1.3，Q11、Q14）。只有平台管理员能看到这个版块：
 * 各专家的版本、知识来源版本、状态、评测用例条数、有用/没用汇总，可以暂停和恢复（二次确认），
 * 并查看暂停、恢复记录。真正的权限在后端（其他角色 403）。
 */
export function ExpertsPage({ user }: { user: CurrentUser }) {
  const { t, i18n } = useTranslation();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [confirming, setConfirming] = useState<AdminExpert | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<AdminExpert | null>(null);
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' });
  const [historyVersion, setHistoryVersion] = useState(0);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );

  useEffect(() => {
    let cancelled = false;
    listAdminExperts()
      .then((res) => !cancelled && setList({ status: 'ready', ...res }))
      .catch(() => !cancelled && setList({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const historyId = historyOf?.id ?? null;
  useEffect(() => {
    if (!historyId) return;
    let cancelled = false;
    setHistory({ status: 'loading' });
    listAvailabilityEvents(historyId)
      .then((events) => !cancelled && setHistory({ status: 'ready', events }))
      .catch(() => !cancelled && setHistory({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [historyId, historyVersion]);

  const reload = () => {
    setList({ status: 'loading' });
    setVersion((v) => v + 1);
  };

  const submit = async (expert: AdminExpert) => {
    const enabled = !expert.enabled;
    setWorking(true);
    try {
      await setExpertAvailability(expert.id, enabled);
      setConfirming(null);
      setNotice(t(enabled ? 'experts.resumedDone' : 'experts.pausedDone', { name: expert.name }));
      setVersion((v) => v + 1);
      if (historyId === expert.id) setHistoryVersion((v) => v + 1);
    } catch {
      setConfirming(null);
      setActionError(t('experts.actionFailed'));
    } finally {
      setWorking(false);
    }
  };

  const actorLabel = (event: ExpertAvailabilityEvent) => {
    if (event.actorId === null) return t('experts.history.unknown');
    // 只有平台管理员能暂停专家；接口只给操作人 id，不暴露姓名
    return event.actorId === user.id ? t('experts.history.self') : t('experts.history.platform');
  };

  return (
    <section className={base.page} aria-labelledby="experts-title">
      <div className={base.titleRow}>
        <div>
          <h1 id="experts-title" className={base.title}>
            {t('experts.title')}
          </h1>
          <p className={base.subtitle}>{t('experts.subtitle')}</p>
        </div>
      </div>

      {actionError && (
        <p className={base.error} role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className={base.notice} role="status">
          {notice}
        </p>
      )}

      {list.status === 'loading' && (
        <p className={base.muted} role="status">
          {t('experts.loading')}
        </p>
      )}
      {list.status === 'error' && (
        <div className={base.error} role="alert">
          <span>{t('experts.loadFailed')}</span>
          <Button variant="ghost" onClick={reload}>
            {t('experts.retry')}
          </Button>
        </div>
      )}
      {list.status === 'ready' && (
        <>
          <p className={styles.note}>
            {t('experts.period', { from: list.from, to: list.to })} {t('experts.evalNote')}
          </p>
          <table className={base.table}>
            <thead>
              <tr>
                <th scope="col">{t('experts.columns.name')}</th>
                <th scope="col">{t('experts.columns.version')}</th>
                <th scope="col">{t('experts.columns.sourcesVersion')}</th>
                <th scope="col">{t('experts.columns.status')}</th>
                <th scope="col">{t('experts.columns.evals')}</th>
                <th scope="col">{t('experts.columns.enabled')}</th>
                <th scope="col">{t('experts.columns.calls')}</th>
                <th scope="col">{t('experts.columns.feedback')}</th>
                <th scope="col">{t('experts.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.experts.map((expert) => (
                <tr key={expert.id} className={expert.enabled ? undefined : base.disabledRow}>
                  <th scope="row" data-label={t('experts.columns.name')}>
                    {expert.name}
                  </th>
                  <td data-label={t('experts.columns.version')} className={styles.mono}>
                    {expert.version}
                  </td>
                  <td data-label={t('experts.columns.sourcesVersion')} className={styles.mono}>
                    {expert.sourcesVersion}
                  </td>
                  <td data-label={t('experts.columns.status')}>
                    <div className={styles.stack}>
                      <span>
                        {t(`experts.status.${expert.status}`, { defaultValue: expert.status })}
                      </span>
                      {!expert.statusAllowed && (
                        <span className={styles.hint}>{t('experts.statusNotAllowed')}</span>
                      )}
                      {expert.sourcesPending && (
                        <span className={styles.hint}>{t('experts.sourcesPending')}</span>
                      )}
                    </div>
                  </td>
                  <td data-label={t('experts.columns.evals')} className={styles.number}>
                    {t('experts.evalCount', {
                      count: expert.evalCases,
                      target: expert.evalTarget,
                    })}
                  </td>
                  <td data-label={t('experts.columns.enabled')}>
                    <div className={styles.stack}>
                      <span
                        className={`${styles.badge} ${expert.enabled ? styles.on : styles.off}`}
                      >
                        {expert.enabled ? t('experts.enabled') : t('experts.paused')}
                      </span>
                      {expert.updatedAt && (
                        <time className={styles.hint} dateTime={expert.updatedAt}>
                          {dateFormat.format(new Date(expert.updatedAt))}
                        </time>
                      )}
                    </div>
                  </td>
                  <td data-label={t('experts.columns.calls')} className={styles.number}>
                    {expert.calls}
                  </td>
                  <td data-label={t('experts.columns.feedback')} className={styles.number}>
                    {t('experts.feedback', {
                      useful: expert.useful,
                      notUseful: expert.notUseful,
                    })}
                  </td>
                  <td data-label={t('experts.columns.actions')}>
                    <div className={base.rowActions}>
                      <Button
                        variant="ghost"
                        icon={
                          expert.enabled ? (
                            <Pause size={16} aria-hidden />
                          ) : (
                            <Play size={16} aria-hidden />
                          )
                        }
                        aria-label={t(
                          expert.enabled
                            ? 'experts.actions.pauseExpert'
                            : 'experts.actions.resumeExpert',
                          { name: expert.name },
                        )}
                        onClick={() => {
                          setNotice(null);
                          setActionError(null);
                          setConfirming(expert);
                        }}
                      >
                        {expert.enabled ? t('experts.actions.pause') : t('experts.actions.resume')}
                      </Button>
                      <Button
                        variant="ghost"
                        icon={<History size={16} aria-hidden />}
                        aria-label={t('experts.actions.historyOf', { name: expert.name })}
                        aria-expanded={historyId === expert.id}
                        onClick={() => setHistoryOf(historyId === expert.id ? null : expert)}
                      >
                        {t('experts.actions.history')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {historyOf && (
        <section className={styles.history} aria-labelledby="expert-history-title">
          <div className={styles.historyHeader}>
            <h2 id="expert-history-title" className={styles.historyTitle}>
              {t('experts.history.title', { name: historyOf.name })}
            </h2>
            <Button variant="ghost" onClick={() => setHistoryOf(null)}>
              {t('experts.history.close')}
            </Button>
          </div>
          {history.status === 'loading' && (
            <p className={base.muted} role="status">
              {t('experts.history.loading')}
            </p>
          )}
          {history.status === 'error' && (
            <p className={base.error} role="alert">
              {t('experts.history.loadFailed')}
            </p>
          )}
          {history.status === 'ready' && history.events.length === 0 && (
            <p className={base.muted}>{t('experts.history.empty')}</p>
          )}
          {history.status === 'ready' && history.events.length > 0 && (
            <ol className={styles.events}>
              {history.events.map((event) => (
                <li key={event.id} className={styles.event}>
                  <span
                    className={`${styles.badge} ${event.action === 'paused' ? styles.off : styles.on}`}
                  >
                    {t(`experts.history.${event.action}`)}
                  </span>
                  <span>{actorLabel(event)}</span>
                  <time className={styles.hint} dateTime={event.createdAt}>
                    {dateFormat.format(new Date(event.createdAt))}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {confirming && (
        <Dialog
          title={t(
            confirming.enabled ? 'experts.confirm.pauseTitle' : 'experts.confirm.resumeTitle',
            {
              name: confirming.name,
            },
          )}
          onClose={() => !working && setConfirming(null)}
        >
          <p className={base.dialogBody}>
            {t(confirming.enabled ? 'experts.confirm.pauseBody' : 'experts.confirm.resumeBody')}
          </p>
          <div className={base.dialogActions}>
            <Button autoFocus disabled={working} onClick={() => setConfirming(null)}>
              {t('experts.confirm.cancel')}
            </Button>
            <Button variant="primary" disabled={working} onClick={() => void submit(confirming)}>
              {working
                ? t('experts.confirm.working')
                : t(confirming.enabled ? 'experts.confirm.pause' : 'experts.confirm.resume')}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
