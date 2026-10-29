import {
  COMPANION_ALERT_NOTE_MAX,
  COMPANION_ALERT_RESOLUTIONS,
  COMPANION_REPLY_MAX,
  type AlertResolution,
  type CompanionAlert,
  type CompanionHandoff,
  type CompanionObservation,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import type { TFunction } from 'i18next';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  closeCompanionHandoff,
  getClientCompanionCases,
  handleCompanionAlert,
  listCompanionObservations,
  replyCompanionHandoff,
  resolveCompanionObservation,
} from '../api/companion';
import { ApiError, isAbortError } from '../api/http';
import { displayDateTime } from '../twin/errors';
import styles from '../twin/Twin.module.css';
import care from './Companion.module.css';

/**
 * 福宝的预警、转交、收集信息（M6 规格 2.4、2.5、2.7、2.8）：今日跟进“伴侣”分组和伴侣视图共用。
 * 预警不能忽略，处理方式必填；转交可以直接写回复（福宝下次唤醒时念原文）或选“已电话联系”；
 * 待确认的测量确认后才写进监测。
 */

export function caseErrorText(t: TFunction, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400 && err.code === 'invalid_content') {
      return t('companion.cases.errors.bannedTerm');
    }
    if (err.status === 400) return t('companion.cases.errors.badRequest');
    if (err.status === 404) return t('companion.cases.errors.notFound');
    if (err.status === 409) return t('companion.cases.errors.changed');
    if (err.code === 'network') return t('companion.errors.network');
  }
  return t('companion.errors.unknown');
}

function ClientLink({
  name,
  clientId,
  onOpenClient,
}: {
  name: string;
  clientId: string;
  onOpenClient?: ((clientId: string) => void) | undefined;
}) {
  if (!onOpenClient) return null;
  return (
    <button type="button" className={styles.linkButton} onClick={() => onOpenClient(clientId)}>
      {name}
    </button>
  );
}

export function AlertItem({
  alert,
  showClient = false,
  onOpenClient,
  onChanged,
}: {
  alert: CompanionAlert;
  showClient?: boolean;
  onOpenClient?: ((clientId: string) => void) | undefined;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<AlertResolution | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRequired = resolution === 'other';
  const canSubmit = resolution !== '' && (!noteRequired || note.trim() !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resolution === '') return;
    setBusy(true);
    setError(null);
    handleCompanionAlert(alert.id, { resolution, note: note.trim() || null })
      .then(() => {
        setOpen(false);
        onChanged();
      })
      .catch((err: unknown) => setError(caseErrorText(t, err)))
      .finally(() => setBusy(false));
  };
  return (
    <li className={care.caseItem} data-kind="alert" data-status={alert.status}>
      <div className={care.planHeader}>
        <strong>{t(`companion.cases.alertCategories.${alert.category}`)}</strong>
        {showClient && (
          <ClientLink
            name={alert.clientName}
            clientId={alert.clientId}
            onOpenClient={onOpenClient}
          />
        )}
        <span className={styles.muted}>{displayDateTime(alert.createdAt)}</span>
      </div>
      {alert.said && (
        <p className={styles.cardLine}>{t('companion.cases.said', { text: alert.said })}</p>
      )}
      {alert.companionSaid && (
        <p className={styles.muted}>
          {t('companion.cases.companionSaid', { text: alert.companionSaid })}
        </p>
      )}
      {alert.status === 'handled' ? (
        <p className={styles.cardLine}>
          {t('companion.cases.handled', {
            resolution: t(`companion.cases.resolutions.${alert.resolution ?? 'other'}`),
          })}
          {alert.note && ` · ${alert.note}`}
        </p>
      ) : open ? (
        <form
          className={styles.form}
          onSubmit={submit}
          noValidate
          aria-label={t('companion.cases.handleTitle')}
        >
          <label className={styles.label}>
            {t('companion.cases.resolution')}
            <select
              className={styles.select}
              value={resolution}
              onChange={(e) => setResolution(e.target.value as AlertResolution | '')}
            >
              <option value="">{t('companion.cases.chooseResolution')}</option>
              {COMPANION_ALERT_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {t(`companion.cases.resolutions.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.label}>
            {noteRequired ? t('companion.cases.noteRequired') : t('companion.cases.note')}
            <textarea
              className={styles.input}
              rows={2}
              maxLength={COMPANION_ALERT_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.cardActions}>
            <Button type="submit" variant="primary" disabled={busy || !canSubmit}>
              {t('companion.cases.markHandled')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {t('companion.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.cardActions}>
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t('companion.cases.handle')}
          </Button>
        </div>
      )}
    </li>
  );
}

export function HandoffItem({
  handoff,
  showClient = false,
  onOpenClient,
  onChanged,
}: {
  handoff: CompanionHandoff;
  showClient?: boolean;
  onOpenClient?: ((clientId: string) => void) | undefined;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .then(() => {
        setReplying(false);
        onChanged();
      })
      .catch((err: unknown) => setError(caseErrorText(t, err)))
      .finally(() => setBusy(false));
  };
  const canClose = handoff.status === 'open' || handoff.status === 'replied';
  return (
    <li className={care.caseItem} data-kind="handoff" data-status={handoff.status}>
      <div className={care.planHeader}>
        <strong>{t(`companion.cases.handoffCategories.${handoff.category}`)}</strong>
        {showClient && (
          <ClientLink
            name={handoff.clientName}
            clientId={handoff.clientId}
            onOpenClient={onOpenClient}
          />
        )}
        <span className={styles.muted}>{displayDateTime(handoff.createdAt)}</span>
        {handoff.overdue && <span className={styles.tag}>{t('companion.cases.overdue')}</span>}
        {handoff.status !== 'open' && (
          <span className={styles.tag}>
            {t(`companion.cases.handoffStatuses.${handoff.status}`)}
          </span>
        )}
      </div>
      <p className={styles.cardLine}>{t('companion.cases.said', { text: handoff.question })}</p>
      {handoff.replyText && (
        <p className={styles.muted}>
          {t('companion.cases.replyValue', { text: handoff.replyText })}
        </p>
      )}
      {replying ? (
        <form
          className={styles.form}
          noValidate
          aria-label={t('companion.cases.replyTitle')}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => replyCompanionHandoff(handoff.id, text.trim()));
          }}
        >
          <p className={styles.muted}>{t('companion.cases.replyHint')}</p>
          <label className={styles.label}>
            {t('companion.cases.reply', { max: COMPANION_REPLY_MAX })}
            <textarea
              className={styles.input}
              rows={3}
              maxLength={COMPANION_REPLY_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.cardActions}>
            <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
              {t('companion.cases.sendReply')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReplying(false)}>
              {t('companion.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        canClose && (
          <>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.cardActions}>
              {handoff.status === 'open' && (
                <Button variant="primary" disabled={busy} onClick={() => setReplying(true)}>
                  {t('companion.cases.writeReply')}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => closeCompanionHandoff(handoff.id, 'closed_by_call'))}
              >
                {t('companion.cases.closedByCall')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => closeCompanionHandoff(handoff.id, 'closed'))}
              >
                {t('companion.cases.close')}
              </Button>
            </div>
          </>
        )
      )}
    </li>
  );
}

/** 一条收集信息；待确认的测量可以确认（写进监测）或驳回 */
export function ObservationItem({
  observation,
  clientName,
  onOpenClient,
  onChanged,
}: {
  observation: CompanionObservation;
  clientName?: string;
  onOpenClient?: ((clientId: string) => void) | undefined;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = (confirm: boolean) => {
    setBusy(true);
    setError(null);
    resolveCompanionObservation(observation.id, confirm)
      .then(onChanged)
      .catch((err: unknown) => setError(caseErrorText(t, err)))
      .finally(() => setBusy(false));
  };
  const pending = observation.status === 'pending_confirm';
  return (
    <li className={care.caseItem} data-kind="observation" data-status={observation.status}>
      <div className={care.planHeader}>
        <strong>{t(`companion.cases.observationCategories.${observation.category}`)}</strong>
        {clientName && (
          <ClientLink
            name={clientName}
            clientId={observation.clientId}
            onOpenClient={onOpenClient}
          />
        )}
        <span className={styles.muted}>{observation.observedOn}</span>
        {observation.polarity && (
          <span className={styles.tag}>
            {t(`companion.cases.polarities.${observation.polarity}`)}
          </span>
        )}
        {observation.status !== 'info' && (
          <span className={styles.tag}>
            {t(`companion.cases.observationStatuses.${observation.status}`)}
          </span>
        )}
      </div>
      <p className={styles.cardLine}>{observation.text}</p>
      {pending && observation.metric && (
        <p className={styles.muted}>
          {t('companion.cases.pendingValue', {
            metric: t(`companion.checkin.metrics.${observation.metric}`),
            values: observation.values.join(' / '),
          })}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className={styles.cardActions}>
          <Button
            variant="primary"
            disabled={busy || !observation.metric}
            onClick={() => resolve(true)}
          >
            {t('companion.cases.confirmReading')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => resolve(false)}>
            {t('companion.cases.dismissReading')}
          </Button>
        </div>
      )}
    </li>
  );
}

/** 伴侣视图：这位客户的预警、转交（含已处理的）和收集信息 */
export function CasesSection({
  clientId,
  onChanged,
}: {
  clientId: string;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    clientId: string;
    alerts: CompanionAlert[];
    handoffs: CompanionHandoff[];
    observations: CompanionObservation[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => {
    setVersion((v) => v + 1);
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    Promise.all([
      getClientCompanionCases(clientId, controller.signal),
      listCompanionObservations(clientId, controller.signal),
    ])
      .then(([cases, observations]) => setData({ clientId, ...cases, observations }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(true);
      });
    return () => controller.abort();
  }, [clientId, version]);

  const shown = data?.clientId === clientId ? data : null;
  if (!shown) {
    return error ? (
      <div role="alert">
        <p className={styles.error}>{t('companion.cases.loadFailed')}</p>
        <Button onClick={() => setVersion((v) => v + 1)}>{t('companion.retry')}</Button>
      </div>
    ) : (
      <p className={styles.muted} role="status">
        {t('companion.cases.loading')}
      </p>
    );
  }
  return (
    <>
      <h6 className={styles.basisTitle}>{t('companion.cases.alertsTitle')}</h6>
      {shown.alerts.length === 0 ? (
        <p className={styles.muted}>{t('companion.cases.noAlerts')}</p>
      ) : (
        <ul className={care.planList}>
          {shown.alerts.map((a) => (
            <AlertItem key={a.id} alert={a} onChanged={reload} />
          ))}
        </ul>
      )}
      <h6 className={styles.basisTitle}>{t('companion.cases.handoffsTitle')}</h6>
      {shown.handoffs.length === 0 ? (
        <p className={styles.muted}>{t('companion.cases.noHandoffs')}</p>
      ) : (
        <ul className={care.planList}>
          {shown.handoffs.map((h) => (
            <HandoffItem key={h.id} handoff={h} onChanged={reload} />
          ))}
        </ul>
      )}
      <h6 className={styles.basisTitle}>{t('companion.cases.observationsTitle')}</h6>
      <p className={styles.muted}>{t('companion.cases.observationsHint')}</p>
      {shown.observations.length === 0 ? (
        <p className={styles.muted}>{t('companion.cases.noObservations')}</p>
      ) : (
        <ul className={care.planList}>
          {shown.observations.map((o) => (
            <ObservationItem key={o.id} observation={o} onChanged={reload} />
          ))}
        </ul>
      )}
    </>
  );
}
