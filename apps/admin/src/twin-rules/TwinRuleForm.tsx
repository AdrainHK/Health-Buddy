import {
  CRITICAL_COMPARATORS,
  THRESHOLD_BOUNDS,
  TWIN_DOMAINS,
  TWIN_MONITORING_WINDOW_DAYS,
  TWIN_RULE_LEVELS,
  TWIN_RULE_SOURCES,
  indicatorUnit,
  type CreateTwinStatusRuleRequest,
  type CriticalComparator,
  type IndicatorCode,
  type TwinDomain,
  type TwinRuleLevel,
  type TwinRuleMethod,
  type TwinRuleSource,
  type TwinStatusRuleRecord,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import {
  methodsFor,
  metricsFor,
  toTwinRuleError,
  useTwinRuleLabels,
  type TwinRuleErrorKey,
} from './labels';

export type TwinRuleFormValues = CreateTwinStatusRuleRequest;

export interface TwinRuleFormProps {
  /** 有值时是修改：方面、指标、来源、判断方式不能换；没有时是新增 */
  initial?: TwinStatusRuleRecord;
  onSubmit: (values: TwinRuleFormValues) => Promise<void>;
  onCancel: () => void;
}

/**
 * 新增或修改一条孪生状态规则（M4 规格 2.10）。指标只能从方面的目录里选，单位跟目录走；
 * 只有“固定阈值”类有方向、阈值和单位，只有监测规则有时间窗口。形状和范围以后端校验为准。
 */
export function TwinRuleForm({ initial, onSubmit, onCancel }: TwinRuleFormProps) {
  const { t } = useTranslation();
  const labels = useTwinRuleLabels();
  const id = useId();
  const locked = Boolean(initial);

  const [domain, setDomain] = useState<TwinDomain>(initial?.domain ?? 'cardiovascular');
  const [source, setSource] = useState<TwinRuleSource>(initial?.source ?? 'monitoring');
  const [metric, setMetric] = useState<IndicatorCode | null>(
    initial?.metric ?? metricsFor('cardiovascular', 'monitoring')[0] ?? null,
  );
  const [method, setMethod] = useState<TwinRuleMethod>(initial?.method ?? 'threshold');
  const [comparator, setComparator] = useState<CriticalComparator>(initial?.comparator ?? 'gt');
  const [value, setValue] = useState(initial?.value != null ? String(initial.value) : '');
  const [windowDays, setWindowDays] = useState(
    String(initial?.windowDays ?? TWIN_MONITORING_WINDOW_DAYS),
  );
  const [level, setLevel] = useState<TwinRuleLevel>(initial?.level ?? 'yellow');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<TwinRuleErrorKey | null>(null);

  const metrics = metricsFor(domain, source);
  const methods = methodsFor(source);
  const isThreshold = method === 'threshold';
  const isMonitoring = source === 'monitoring';

  /** 方面或来源变了：指标和判断方式换成新组合里的第一个可选项 */
  const changeScope = (d: TwinDomain, s: TwinRuleSource) => {
    setDomain(d);
    setSource(s);
    const ms = metricsFor(d, s);
    setMetric((m) => (m && ms.includes(m) ? m : (ms[0] ?? null)));
    const allowed = methodsFor(s);
    setMethod((m) => (allowed.includes(m) ? m : allowed[0]!));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!metric) return;
    let parsedValue: number | null = null;
    if (isThreshold) {
      parsedValue = Number(value);
      if (value.trim() === '' || !Number.isFinite(parsedValue)) {
        setError('invalid_value');
        return;
      }
    }
    let parsedWindow: number | null = null;
    if (isMonitoring) {
      parsedWindow = Number(windowDays);
      if (!Number.isInteger(parsedWindow) || parsedWindow < 1 || parsedWindow > 90) {
        setError('invalid_window');
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        domain,
        metric,
        source,
        method,
        comparator: isThreshold ? comparator : null,
        value: parsedValue,
        unit: isThreshold ? indicatorUnit(metric) : null,
        windowDays: parsedWindow,
        level,
        enabled,
      });
    } catch (err) {
      setError(toTwinRuleError(err, isThreshold));
      setSubmitting(false);
    }
  };

  const bounds = metric ? THRESHOLD_BOUNDS[metric] : null;
  const unit = metric ? labels.unitLabel(metric) : '';

  return (
    <Dialog
      title={t(initial ? 'twinRules.form.editTitle' : 'twinRules.form.createTitle')}
      onClose={onCancel}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {locked && <small className={styles.hint}>{t('twinRules.form.locked')}</small>}
        <div className={styles.field}>
          <label htmlFor={`${id}-domain`}>{t('twinRules.form.domain')}</label>
          <select
            id={`${id}-domain`}
            value={domain}
            disabled={locked}
            autoFocus={!locked}
            onChange={(e) => changeScope(e.target.value as TwinDomain, source)}
          >
            {TWIN_DOMAINS.map((d) => (
              <option key={d} value={d}>
                {labels.domainName(d)}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label htmlFor={`${id}-source`}>{t('twinRules.form.source')}</label>
          <select
            id={`${id}-source`}
            value={source}
            disabled={locked}
            onChange={(e) => changeScope(domain, e.target.value as TwinRuleSource)}
          >
            {TWIN_RULE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {labels.sourceName(s)}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label htmlFor={`${id}-metric`}>{t('twinRules.form.metric')}</label>
          <select
            id={`${id}-metric`}
            value={metric ?? ''}
            disabled={locked || metrics.length === 0}
            onChange={(e) => setMetric(e.target.value as IndicatorCode)}
          >
            {metrics.map((m) => (
              <option key={m} value={m}>
                {labels.metricName(m)}
              </option>
            ))}
          </select>
          {metrics.length === 0 && (
            <small className={styles.hint}>{t('twinRules.form.noMetric')}</small>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor={`${id}-method`}>{t('twinRules.form.method')}</label>
          <select
            id={`${id}-method`}
            value={method}
            disabled={locked}
            onChange={(e) => setMethod(e.target.value as TwinRuleMethod)}
          >
            {methods.map((m) => (
              <option key={m} value={m}>
                {labels.methodName(m)}
              </option>
            ))}
          </select>
        </div>

        {isThreshold && metric && bounds && (
          <>
            <div className={styles.field}>
              <label htmlFor={`${id}-direction`}>{t('twinRules.form.comparator')}</label>
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
                <label htmlFor={`${id}-value`}>{t('twinRules.form.value')}</label>
                <input
                  id={`${id}-value`}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={value}
                  autoFocus={locked}
                  aria-describedby={`${id}-range`}
                  onChange={(e) => setValue(e.target.value)}
                />
                <small id={`${id}-range`} className={styles.hint}>
                  {t('twinRules.form.range', { min: bounds.min, max: bounds.max, unit })}
                </small>
              </div>
              <div className={styles.field}>
                <span id={`${id}-unit`}>{t('twinRules.form.unit')}</span>
                <output
                  className={styles.unit}
                  aria-labelledby={`${id}-unit`}
                  title={t('twinRules.form.unitHint')}
                >
                  {unit}
                </output>
              </div>
            </div>
          </>
        )}

        {isMonitoring && (
          <div className={styles.field}>
            <label htmlFor={`${id}-window`}>{t('twinRules.form.windowDays')}</label>
            <input
              id={`${id}-window`}
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              step={1}
              value={windowDays}
              aria-describedby={`${id}-window-hint`}
              onChange={(e) => setWindowDays(e.target.value)}
            />
            <small id={`${id}-window-hint`} className={styles.hint}>
              {t('twinRules.form.windowHint')}
            </small>
          </div>
        )}

        <div className={styles.field}>
          <label htmlFor={`${id}-level`}>{t('twinRules.form.level')}</label>
          <select
            id={`${id}-level`}
            value={level}
            onChange={(e) => setLevel(e.target.value as TwinRuleLevel)}
          >
            {TWIN_RULE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {labels.levelName(l)}
              </option>
            ))}
          </select>
        </div>

        <label className={styles.checkbox}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('twinRules.form.enabled')}</span>
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {labels.errorText(error, metric ?? undefined)}
          </p>
        )}

        <div className={styles.dialogActions}>
          <Button onClick={onCancel} disabled={submitting}>
            {t('twinRules.form.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !metric}>
            {submitting ? t('twinRules.form.saving') : t('twinRules.form.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
