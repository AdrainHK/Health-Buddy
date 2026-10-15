import {
  CRITICAL_COMPARATORS,
  CRITICAL_LEVELS,
  THRESHOLD_BOUNDS,
  type CriticalComparator,
  type CriticalLevel,
  type CriticalThreshold,
  type IndicatorCode,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { METRICS, toThresholdError, useThresholdLabels, type ThresholdErrorKey } from './labels';
import styles from './Thresholds.module.css';

export interface ThresholdFormValues {
  metric: IndicatorCode;
  comparator: CriticalComparator;
  value: number;
  level: CriticalLevel;
  enabled: boolean;
}

export interface ThresholdFormProps {
  /** 有值时是修改，指标不能换；没有时是新增 */
  initial?: CriticalThreshold;
  onSubmit: (values: ThresholdFormValues) => Promise<void>;
  onCancel: () => void;
}

/** 新增或修改一条阈值规则。范围校验以后端为准，这里只提示合理范围。 */
export function ThresholdForm({ initial, onSubmit, onCancel }: ThresholdFormProps) {
  const { t } = useTranslation();
  const labels = useThresholdLabels();
  const id = useId();
  const [metric, setMetric] = useState<IndicatorCode>(initial?.metric ?? 'sbp');
  const [comparator, setComparator] = useState<CriticalComparator>(initial?.comparator ?? 'gte');
  const [value, setValue] = useState(initial ? String(initial.value) : '');
  const [level, setLevel] = useState<CriticalLevel>(initial?.level ?? 'urgent');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ThresholdErrorKey | null>(null);

  const bounds = THRESHOLD_BOUNDS[metric];
  const unit = labels.unitLabel(metric);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed)) {
      setError('invalid_value');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ metric, comparator, value: parsed, level, enabled });
    } catch (err) {
      setError(toThresholdError(err, true));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={t(initial ? 'thresholds.form.editTitle' : 'thresholds.form.createTitle')}
      onClose={onCancel}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor={`${id}-metric`}>{t('thresholds.form.metric')}</label>
          <select
            id={`${id}-metric`}
            value={metric}
            disabled={Boolean(initial)}
            onChange={(e) => setMetric(e.target.value as IndicatorCode)}
            autoFocus={!initial}
            {...(initial ? { 'aria-describedby': `${id}-metric-hint` } : {})}
          >
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {labels.metricName(m)}
              </option>
            ))}
          </select>
          {initial && (
            <small id={`${id}-metric-hint`} className={styles.hint}>
              {t('thresholds.form.metricLocked')}
            </small>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor={`${id}-direction`}>{t('thresholds.form.direction')}</label>
          <select
            id={`${id}-direction`}
            value={comparator}
            onChange={(e) => setComparator(e.target.value as CriticalComparator)}
          >
            {CRITICAL_COMPARATORS.map((c) => (
              <option key={c} value={c}>
                {`${labels.symbol(c)} ${labels.direction(c)}`}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor={`${id}-value`}>{t('thresholds.form.value')}</label>
            <input
              id={`${id}-value`}
              type="number"
              inputMode="decimal"
              step="any"
              value={value}
              autoFocus={Boolean(initial)}
              aria-describedby={`${id}-range`}
              onChange={(e) => setValue(e.target.value)}
            />
            <small id={`${id}-range`} className={styles.hint}>
              {t('thresholds.form.range', { min: bounds.min, max: bounds.max, unit })}
            </small>
          </div>
          <div className={styles.field}>
            <span id={`${id}-unit`}>{t('thresholds.form.unit')}</span>
            <output
              className={styles.unit}
              aria-labelledby={`${id}-unit`}
              title={t('thresholds.form.unitHint')}
            >
              {unit}
            </output>
          </div>
        </div>

        <div className={styles.field}>
          <label htmlFor={`${id}-level`}>{t('thresholds.form.level')}</label>
          <select
            id={`${id}-level`}
            value={level}
            onChange={(e) => setLevel(e.target.value as CriticalLevel)}
          >
            {CRITICAL_LEVELS.map((l) => (
              <option key={l} value={l}>
                {labels.levelName(l)}
              </option>
            ))}
          </select>
        </div>

        <label className={styles.checkbox}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('thresholds.form.enabled')}</span>
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {labels.errorText(error, metric)}
          </p>
        )}

        <div className={styles.dialogActions}>
          <Button onClick={onCancel} disabled={submitting}>
            {t('thresholds.form.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? t('thresholds.form.saving') : t('thresholds.form.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
