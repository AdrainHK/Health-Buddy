import {
  MONITORING_METRICS,
  THRESHOLD_BOUNDS,
  type MonitoringMetricCode,
  type MonitoringReading,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAbortError } from '../api/http';
import { createMonitoringReading, deleteMonitoringReading, listManualReadings } from '../api/twin';
import { displayDateTime, twinErrorKey, type TwinErrorKey } from './errors';
import { formatNumber, useMetricName } from './format';
import styles from './Twin.module.css';

/** datetime-local 输入框用的本地时间（精确到分钟） */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 健管师手动录入监测数据（规格 Q29）：单条录入，指标只能从目录里选，数值在合理范围内，
 * 时间不晚于现在（前端先拦，后端同样校验）；只能删除自己录入的。每分钟最多 60 条（429）。
 */
export function ManualReadings({
  clientId,
  onChanged,
}: {
  clientId: string;
  /** 录入或删除后：孪生在后台重新计算 */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<MonitoringMetricCode>('sbp');
  const [value, setValue] = useState('');
  const [measuredAt, setMeasuredAt] = useState(() => localInputValue(new Date()));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TwinErrorKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readings, setReadings] = useState<MonitoringReading[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setReadings(null);
  }, [clientId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listManualReadings(clientId, controller.signal)
      .then(setReadings)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setReadings([]);
      });
    return () => controller.abort();
  }, [clientId, open, version]);

  const def = MONITORING_METRICS.find((m) => m.code === metric)!;
  const bounds = THRESHOLD_BOUNDS[metric];
  const num = value.trim() === '' ? null : Number(value);
  const time = measuredAt ? new Date(measuredAt) : null;
  const valueError =
    num === null
      ? t('twin.readings.valueRequired')
      : !Number.isFinite(num) || num < bounds.min || num > bounds.max
        ? t('twin.readings.valueRange', { min: bounds.min, max: bounds.max })
        : null;
  const timeError =
    !time || Number.isNaN(time.getTime())
      ? t('twin.readings.timeRequired')
      : time.getTime() > Date.now()
        ? t('twin.readings.futureTime')
        : null;

  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    onChanged();
  }, [onChanged]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setNotice(null);
    if (valueError || timeError || num === null || !time) return;
    setBusy(true);
    setError(null);
    createMonitoringReading(clientId, { metric, value: num, measuredAt: time.toISOString() })
      .then(() => {
        setValue('');
        setTouched(false);
        setNotice(t('twin.readings.added'));
        changed();
      })
      .catch((err: unknown) => setError(twinErrorKey(err)))
      .finally(() => setBusy(false));
  };

  const remove = (reading: MonitoringReading) => {
    setError(null);
    setNotice(null);
    deleteMonitoringReading(reading.id)
      .then(() => {
        setNotice(t('twin.readings.deleted'));
        changed();
      })
      .catch((err: unknown) => {
        setError(twinErrorKey(err));
        setVersion((v) => v + 1);
      });
  };

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.sectionHeader}>
        <h5 id={`${id}-title`} className={styles.sectionTitle}>
          {t('twin.readings.title')}
        </h5>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('twin.readings.hide') : t('twin.readings.show')}
        </Button>
      </div>
      {open && (
        <>
          <p className={styles.muted}>{t('twin.readings.note')}</p>
          <form className={styles.form} onSubmit={submit} noValidate>
            <label className={styles.label}>
              {t('twin.readings.metric')}
              <select
                className={styles.select}
                value={metric}
                onChange={(e) => setMetric(e.target.value as MonitoringMetricCode)}
              >
                {MONITORING_METRICS.map((m) => (
                  <option key={m.code} value={m.code}>
                    {metricName(m.code)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              {t('twin.readings.value', { unit: def.unit })}
              <input
                className={styles.input}
                type="number"
                inputMode="decimal"
                step="any"
                min={bounds.min}
                max={bounds.max}
                value={value}
                aria-invalid={touched && valueError !== null ? true : undefined}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            {touched && valueError && (
              <p className={styles.error} role="alert">
                {valueError}
              </p>
            )}
            <label className={styles.label}>
              {t('twin.readings.measuredAt')}
              <input
                className={styles.input}
                type="datetime-local"
                max={localInputValue(new Date())}
                value={measuredAt}
                aria-invalid={touched && timeError !== null ? true : undefined}
                onChange={(e) => setMeasuredAt(e.target.value)}
              />
            </label>
            {touched && timeError && (
              <p className={styles.error} role="alert">
                {timeError}
              </p>
            )}
            <div className={styles.cardActions}>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t('twin.readings.adding') : t('twin.readings.add')}
              </Button>
            </div>
          </form>
          {notice && (
            <p className={styles.muted} role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {t(`twin.readings.errors.${error}`)}
            </p>
          )}
          <h6 className={styles.basisTitle}>{t('twin.readings.mine')}</h6>
          {readings && readings.length === 0 && (
            <p className={styles.muted}>{t('twin.readings.empty')}</p>
          )}
          {readings && readings.length > 0 && (
            <ul className={styles.readingList}>
              {readings.map((r) => {
                const time = displayDateTime(r.measuredAt);
                return (
                  <li key={r.id} className={styles.reading}>
                    <span>
                      {t('twin.readings.item', {
                        metric: metricName(r.metric),
                        value: formatNumber(r.value),
                        unit: r.unit,
                      })}
                    </span>
                    <span className={styles.muted}>{t('twin.readings.meta', { time })}</span>
                    {r.deletable && (
                      <Button
                        variant="ghost"
                        onClick={() => remove(r)}
                        aria-label={t('twin.readings.deleteLabel', {
                          time,
                          metric: metricName(r.metric),
                        })}
                      >
                        {t('twin.readings.delete')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
