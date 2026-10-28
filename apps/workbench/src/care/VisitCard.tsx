import {
  VISIT_CANCEL_REASONS,
  VISIT_MAX_AHEAD_MONTHS,
  VISIT_MISSED_POSTPONE_DAYS,
  VISIT_NOTE_MAX,
  type UpdateVisitRequest,
  type Visit,
  type VisitRecordSummary,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listVisitRecords, updateVisit } from '../api/care';
import { isAbortError } from '../api/http';
import { useTwinActions } from '../twin/TwinActions';
import { twinErrorKey } from '../twin/errors';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';
import { addDays, addMonths, localToday } from './dates';

export interface VisitCardProps {
  visit: Visit;
  /** 今日随访清单里显示客户称呼和“打开客户” */
  clientName?: string;
  /** 今日随访：逾期天数（0 = 今天到期） */
  overdueDays?: number;
  onOpenClient?: (clientId: string) => void;
  /** 处理成功（或发现这次随访已变化）后刷新 */
  onChanged: () => void;
  readOnly?: boolean;
}

/** 一次随访（规格 2.6、2.7）：日期、目的、方式、重点；按钮“处理” */
export function VisitCard({
  visit,
  clientName,
  overdueDays,
  onOpenClient,
  onChanged,
  readOnly = false,
}: VisitCardProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [handling, setHandling] = useState(false);
  const open = visit.status === 'planned' || visit.status === 'missed';
  const canHandle = !readOnly && (open || visit.status === 'pending_plan');
  const { visitSkill } = useTwinActions();
  const canPrepare = !readOnly && open && Boolean(visitSkill);
  const runSkill = (skillId: 'visit-script' | 'visit-record') =>
    visitSkill?.({ id: visit.clientId, displayName: clientName ?? '' }, visit.id, skillId);
  const purpose = t(`care.visits.purposes.${visit.purpose}`);
  const line = t('care.visits.line', {
    date: visit.dueDate,
    purpose,
    method: t(`care.visits.methods.${visit.method}`),
  });
  return (
    <li
      className={care.visit}
      data-purpose={visit.purpose}
      data-overdue={overdueDays ? true : undefined}
      aria-labelledby={titleId}
    >
      <div className={styles.followUpHead}>
        <span id={titleId} className={styles.followUpTitle}>
          {clientName && <strong>{clientName} · </strong>}
          {line}
        </span>
        {overdueDays !== undefined && (
          <span className={care.due} data-overdue={overdueDays > 0 ? true : undefined}>
            {overdueDays > 0
              ? t('care.visits.overdue', { count: overdueDays })
              : t('care.visits.dueToday')}
          </span>
        )}
        {visit.status !== 'planned' && (
          <span className={care.status}>{t(`care.visits.statuses.${visit.status}`)}</span>
        )}
      </div>
      <p className={styles.followUpBasis}>{visit.focus || t('care.visits.noFocus')}</p>
      {handling ? (
        <VisitHandleForm
          visit={visit}
          onCancel={() => setHandling(false)}
          onDone={() => {
            setHandling(false);
            onChanged();
          }}
        />
      ) : (
        (canHandle || canPrepare || (clientName && onOpenClient)) && (
          <div className={styles.cardActions}>
            {clientName && onOpenClient && (
              <Button
                onClick={() => onOpenClient(visit.clientId)}
                aria-label={t('care.visits.openClientLabel', { name: clientName })}
              >
                {t('care.visits.openClient')}
              </Button>
            )}
            {canPrepare && (
              <>
                <Button onClick={() => runSkill('visit-script')}>{t('care.visits.prepare')}</Button>
                <Button onClick={() => runSkill('visit-record')}>{t('care.visits.record')}</Button>
              </>
            )}
            {canHandle && (
              <Button
                variant="primary"
                onClick={() => setHandling(true)}
                aria-label={t('care.visits.handleLabel', {
                  name: clientName ?? purpose,
                  date: visit.dueDate,
                })}
              >
                {t('care.visits.handle')}
              </Button>
            )}
          </div>
        )
      )}
    </li>
  );
}

type Mode = UpdateVisitRequest['action'];

/**
 * 处理（2.7）：完成（关联一份随访记录，或选“不记录”写一句备注，Q26）、未联系上（默认顺延 2 天，可改）、
 * 改期、取消（必须选原因）。等方案生效的复评只能取消。
 */
function VisitHandleForm({
  visit,
  onCancel,
  onDone,
}: {
  visit: Visit;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const today = localToday();
  const maxDate = addMonths(today, VISIT_MAX_AHEAD_MONTHS);
  const modes: Mode[] =
    visit.status === 'pending_plan' ? ['cancel'] : ['done', 'missed', 'reschedule', 'cancel'];
  const [mode, setMode] = useState<Mode>(modes[0]!);
  const [records, setRecords] = useState<VisitRecordSummary[] | null>(null);
  const [recordId, setRecordId] = useState('');
  const [note, setNote] = useState('');
  const [missedDate, setMissedDate] = useState(addDays(today, VISIT_MISSED_POSTPONE_DAYS));
  const [newDate, setNewDate] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 完成时可以关联这位客户已确认、还没关联别的随访的记录（后端只校验属于同一位客户）
  useEffect(() => {
    if (mode !== 'done' || records !== null) return;
    const controller = new AbortController();
    listVisitRecords(visit.clientId, controller.signal)
      .then(setRecords)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setRecords([]);
      });
    return () => controller.abort();
  }, [mode, records, visit.clientId]);

  const trimmedNote = note.trim();
  const inRange = (d: string) => d >= today && d <= maxDate;
  const problem = (() => {
    if (trimmedNote.length > VISIT_NOTE_MAX) return null;
    if (mode === 'done' && !recordId && !trimmedNote) return t('care.visits.form.noteRequired');
    if (mode === 'missed' && !inRange(missedDate)) return t('care.visits.form.dateRange');
    if (mode === 'reschedule') {
      if (!newDate) return t('care.visits.form.dateRequired');
      if (!inRange(newDate)) return t('care.visits.form.dateRange');
    }
    if (mode === 'cancel' && !cancelReason) return t('care.visits.form.cancelReasonRequired');
    return null;
  })();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || trimmedNote.length > VISIT_NOTE_MAX) return;
    const noteField = trimmedNote ? { note: trimmedNote } : {};
    let body: UpdateVisitRequest;
    if (mode === 'done') body = { action: 'done', ...(recordId ? { recordId } : noteField) };
    else if (mode === 'missed') body = { action: 'missed', newDate: missedDate };
    else if (mode === 'reschedule') body = { action: 'reschedule', newDate };
    else
      body = {
        action: 'cancel',
        cancelReason: cancelReason as (typeof VISIT_CANCEL_REASONS)[number],
        ...noteField,
      };
    setBusy(true);
    setError(null);
    updateVisit(visit.id, body)
      .then(onDone)
      .catch((err: unknown) => {
        const key = twinErrorKey(err);
        setError(t(`care.visits.errors.${key}`));
        if (key === 'notFound' || key === 'conflict') onDone();
      })
      .finally(() => setBusy(false));
  };

  const showNote = mode === 'cancel' || (mode === 'done' && !recordId);
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{t('care.visits.form.mode')}</legend>
        <div className={styles.choices}>
          {modes.map((m) => (
            <label key={m} className={styles.choice}>
              <input
                type="radio"
                name={`${id}-mode`}
                value={m}
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  setTouched(false);
                }}
              />
              {t(`care.visits.form.modes.${m}`)}
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'done' && (
        <label className={styles.label}>
          {t('care.visits.form.record')}
          <select
            className={styles.select}
            value={recordId}
            disabled={records === null}
            onChange={(e) => setRecordId(e.target.value)}
          >
            <option value="">
              {records === null
                ? t('care.visits.form.recordLoading')
                : t('care.visits.form.recordNone')}
            </option>
            {(records ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {t('care.records.line', {
                  date: r.visitDate,
                  method: t(`care.visits.methods.${r.method}`),
                })}
              </option>
            ))}
          </select>
        </label>
      )}

      {mode === 'missed' && (
        <label className={styles.label}>
          {t('care.visits.form.missedDate')}
          <input
            type="date"
            className={styles.input}
            value={missedDate}
            min={today}
            max={maxDate}
            onChange={(e) => setMissedDate(e.target.value)}
          />
        </label>
      )}

      {mode === 'reschedule' && (
        <label className={styles.label}>
          {t('care.visits.form.newDate')}
          <input
            type="date"
            className={styles.input}
            value={newDate}
            min={today}
            max={maxDate}
            aria-invalid={touched && problem !== null ? true : undefined}
            onChange={(e) => setNewDate(e.target.value)}
          />
        </label>
      )}

      {mode === 'cancel' && (
        <label className={styles.label}>
          {t('care.visits.form.cancelReason')}
          <select
            className={styles.select}
            value={cancelReason}
            aria-invalid={touched && !cancelReason ? true : undefined}
            onChange={(e) => setCancelReason(e.target.value)}
          >
            <option value="">{t('care.visits.form.cancelReasonNone')}</option>
            {VISIT_CANCEL_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`care.visits.form.cancelReasons.${r}`)}
              </option>
            ))}
          </select>
        </label>
      )}

      {showNote && (
        <label className={styles.label}>
          {t('care.visits.form.note', { max: VISIT_NOTE_MAX })}
          <textarea
            className={styles.textarea}
            value={note}
            maxLength={VISIT_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}

      {touched && problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('care.visits.form.submitting') : t('care.visits.form.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('care.visits.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
