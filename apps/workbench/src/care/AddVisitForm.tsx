import {
  VISIT_FOCUS_MAX,
  VISIT_MAX_AHEAD_MONTHS,
  VISIT_METHODS,
  type CreateVisitRequest,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createVisit } from '../api/care';
import { twinErrorKey } from '../twin/errors';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';
import { addMonths, localToday } from './dates';

/** 加一次随访（2.7）：日期、方式、目的、重点（可以空） */
export function AddVisitForm({
  clientId,
  followUpItemId,
  onCancel,
  onAdded,
}: {
  clientId: string;
  /** 从跟进项发起时随访关联这条跟进项，目的固定为“跟进项回访” */
  followUpItemId?: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const today = localToday();
  const maxDate = addMonths(today, VISIT_MAX_AHEAD_MONTHS);
  const [dueDate, setDueDate] = useState(today);
  const [method, setMethod] = useState<CreateVisitRequest['method']>('phone');
  const [purpose, setPurpose] = useState<'routine' | 'adhoc'>('adhoc');
  const [focus, setFocus] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateProblem = !dueDate
    ? t('care.visits.form.dateRequired')
    : dueDate < today || dueDate > maxDate
      ? t('care.visits.form.dateRange')
      : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (dateProblem) return;
    const trimmed = focus.trim();
    setBusy(true);
    setError(null);
    createVisit(clientId, {
      dueDate,
      method,
      ...(followUpItemId ? { purpose: 'follow_up', followUpItemId } : { purpose }),
      ...(trimmed ? { focus: trimmed } : {}),
    })
      .then(onAdded)
      .catch((err: unknown) => setError(t(`care.visits.errors.${twinErrorKey(err)}`)))
      .finally(() => setBusy(false));
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-label={t('care.visits.add')}>
      <div className={care.formRow}>
        <label className={styles.label}>
          {t('care.visits.form.date')}
          <input
            type="date"
            className={styles.input}
            value={dueDate}
            min={today}
            max={maxDate}
            aria-invalid={touched && dateProblem ? true : undefined}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </label>
        <label className={styles.label}>
          {t('care.visits.form.method')}
          <select
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value as CreateVisitRequest['method'])}
          >
            {VISIT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`care.visits.methods.${m}`)}
              </option>
            ))}
          </select>
        </label>
        {!followUpItemId && (
          <label className={styles.label}>
            {t('care.visits.form.purpose')}
            <select
              className={styles.select}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as 'routine' | 'adhoc')}
            >
              {(['adhoc', 'routine'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`care.visits.purposes.${p}`)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className={styles.label}>
        {t('care.visits.form.focus', { max: VISIT_FOCUS_MAX })}
        <textarea
          className={styles.textarea}
          value={focus}
          maxLength={VISIT_FOCUS_MAX}
          onChange={(e) => setFocus(e.target.value)}
        />
      </label>
      {touched && dateProblem && (
        <p className={styles.error} role="alert">
          {dateProblem}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('care.visits.form.adding') : t('care.visits.form.add')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('care.visits.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
