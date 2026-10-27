import {
  FIRST_VISIT_WITHIN_MAX,
  FIRST_VISIT_WITHIN_MIN,
  VISIT_INTERVAL_MAX,
  VISIT_INTERVAL_MIN,
  VISIT_METHODS,
  VISIT_RISK_TIERS,
  type CurrentUser,
  type VisitFrequencyRuleEvent,
  type VisitFrequencyRules,
  type VisitFrequencyRulesResponse,
  type VisitMethod,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Pencil } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';
import {
  getVisitFrequencyRules,
  listVisitFrequencyEvents,
  updateVisitFrequencyRules,
} from '../api/visitFrequency';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import own from './VisitFrequency.module.css';

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: VisitFrequencyRulesResponse };

type Tier = (typeof VISIT_RISK_TIERS)[number];

function errorKey(err: unknown): 'bad_request' | 'forbidden' | 'network' | 'unknown' {
  if (err instanceof ApiError && ['bad_request', 'forbidden', 'network'].includes(err.code)) {
    return err.code as 'bad_request' | 'forbidden' | 'network';
  }
  return 'unknown';
}

/**
 * 随访频次规则（M5 规格第五节之二、2.12、Q18）：每个风险分层一条间隔和默认方式，另有“有 1、2 级
 * 未处理跟进项时首次随访不晚于几天”。全平台一套，平台管理员可以修改和看修改记录；协会和机构管理员只读。
 * 改规则不改已经写入的随访日期。界面只决定显示哪些按钮，真正的权限在后端。
 */
export function VisitFrequencyPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const canEdit = user.role === 'platform_admin';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getVisitFrequencyRules()
      .then((data) => !cancelled && setState({ status: 'ready', data }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const save = async (rules: VisitFrequencyRules) => {
    const data = await updateVisitFrequencyRules(rules);
    setState({ status: 'ready', data });
    setEditing(false);
    setNotice(t('visitFrequency.saved'));
    setHistoryKey((k) => k + 1);
  };

  return (
    <section className={styles.page} aria-labelledby="visit-frequency-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('visitFrequency.disclaimer')}</span>
      </p>

      <div className={styles.titleRow}>
        <div>
          <h1 id="visit-frequency-title" className={styles.title}>
            {t('visitFrequency.title')}
          </h1>
          <p className={styles.subtitle}>
            {canEdit ? t('visitFrequency.editHint') : t('visitFrequency.readOnlyHint')}
          </p>
          {state.status === 'ready' && (
            <p className={own.version}>
              {t('visitFrequency.version', { version: state.data.version })}
            </p>
          )}
        </div>
        {canEdit && state.status === 'ready' && (
          <div className={styles.toolbar}>
            <Button
              variant="primary"
              icon={<Pencil size={16} aria-hidden />}
              onClick={() => {
                setNotice(null);
                setEditing(true);
              }}
            >
              {t('visitFrequency.edit')}
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('visitFrequency.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('visitFrequency.loadFailed')}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setState({ status: 'loading' });
              setReloadKey((k) => k + 1);
            }}
          >
            {t('visitFrequency.retry')}
          </Button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('visitFrequency.columns.tier')}</th>
                <th scope="col">{t('visitFrequency.columns.interval')}</th>
                <th scope="col">{t('visitFrequency.columns.method')}</th>
              </tr>
            </thead>
            <tbody>
              {VISIT_RISK_TIERS.map((tier) => {
                const rule = state.data.rules.tiers[tier];
                return (
                  <tr key={tier}>
                    <th scope="row" data-label={t('visitFrequency.columns.tier')}>
                      {t(`visitFrequency.tiers.${tier}`)}
                    </th>
                    <td data-label={t('visitFrequency.columns.interval')} className={styles.value}>
                      {t('visitFrequency.intervalValue', { days: rule.intervalDays })}
                    </td>
                    <td data-label={t('visitFrequency.columns.method')}>
                      {t(`visitFrequency.methods.${rule.defaultMethod}`)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className={own.rule}>
            {t('visitFrequency.firstVisit', { days: state.data.rules.firstVisitWithinDays })}
          </p>
          <p className={styles.subtitle}>{t('visitFrequency.planReviewNote')}</p>
        </>
      )}

      {canEdit && <VisitFrequencyHistory key={historyKey} />}

      {canEdit && editing && state.status === 'ready' && (
        <VisitFrequencyForm
          initial={state.data.rules}
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      )}
    </section>
  );
}

function VisitFrequencyForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: VisitFrequencyRules;
  onSubmit: (rules: VisitFrequencyRules) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [intervals, setIntervals] = useState<Record<Tier, string>>(
    () =>
      Object.fromEntries(
        VISIT_RISK_TIERS.map((tier) => [tier, String(initial.tiers[tier].intervalDays)]),
      ) as Record<Tier, string>,
  );
  const [methods, setMethods] = useState<Record<Tier, VisitMethod>>(
    () =>
      Object.fromEntries(
        VISIT_RISK_TIERS.map((tier) => [tier, initial.tiers[tier].defaultMethod]),
      ) as Record<Tier, VisitMethod>,
  );
  const [firstVisit, setFirstVisit] = useState(String(initial.firstVisitWithinDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inRange = (v: string, min: number, max: number) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const valid =
      VISIT_RISK_TIERS.every((tier) =>
        inRange(intervals[tier], VISIT_INTERVAL_MIN, VISIT_INTERVAL_MAX),
      ) && inRange(firstVisit, FIRST_VISIT_WITHIN_MIN, FIRST_VISIT_WITHIN_MAX);
    if (!valid) {
      setError(t('visitFrequency.form.invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        tiers: Object.fromEntries(
          VISIT_RISK_TIERS.map((tier) => [
            tier,
            { intervalDays: Number(intervals[tier]), defaultMethod: methods[tier] },
          ]),
        ) as VisitFrequencyRules['tiers'],
        firstVisitWithinDays: Number(firstVisit),
      });
    } catch (err) {
      setError(t(`visitFrequency.errors.${errorKey(err)}`));
      setSaving(false);
    }
  };

  return (
    <Dialog title={t('visitFrequency.form.title')} onClose={onCancel}>
      <form className={styles.form} onSubmit={submit} noValidate>
        {VISIT_RISK_TIERS.map((tier, i) => {
          const tierName = t(`visitFrequency.tiers.${tier}`);
          return (
            <div key={tier} className={own.tierRow}>
              <div className={styles.field}>
                <label htmlFor={`${id}-${tier}-days`}>
                  {t('visitFrequency.form.intervalDays', { tier: tierName })}
                </label>
                <input
                  id={`${id}-${tier}-days`}
                  type="number"
                  inputMode="numeric"
                  min={VISIT_INTERVAL_MIN}
                  max={VISIT_INTERVAL_MAX}
                  step={1}
                  value={intervals[tier]}
                  autoFocus={i === 0}
                  aria-describedby={`${id}-range`}
                  onChange={(e) => setIntervals((v) => ({ ...v, [tier]: e.target.value }))}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-${tier}-method`}>
                  {t('visitFrequency.form.method', { tier: tierName })}
                </label>
                <select
                  id={`${id}-${tier}-method`}
                  value={methods[tier]}
                  onChange={(e) =>
                    setMethods((v) => ({ ...v, [tier]: e.target.value as VisitMethod }))
                  }
                >
                  {VISIT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`visitFrequency.methods.${m}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
        <small id={`${id}-range`} className={styles.hint}>
          {t('visitFrequency.form.range', { min: VISIT_INTERVAL_MIN, max: VISIT_INTERVAL_MAX })}
        </small>
        <div className={styles.field}>
          <label htmlFor={`${id}-first`}>{t('visitFrequency.firstVisitLabel')}</label>
          <input
            id={`${id}-first`}
            type="number"
            inputMode="numeric"
            min={FIRST_VISIT_WITHIN_MIN}
            max={FIRST_VISIT_WITHIN_MAX}
            step={1}
            value={firstVisit}
            aria-describedby={`${id}-first-range`}
            onChange={(e) => setFirstVisit(e.target.value)}
          />
          <small id={`${id}-first-range`} className={styles.hint}>
            {t('visitFrequency.form.range', {
              min: FIRST_VISIT_WITHIN_MIN,
              max: FIRST_VISIT_WITHIN_MAX,
            })}
          </small>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={onCancel} disabled={saving}>
            {t('visitFrequency.form.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? t('visitFrequency.form.saving') : t('visitFrequency.form.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** 修改记录（只有平台管理员）：每一行改了什么，新的在前 */
function VisitFrequencyHistory() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; events: VisitFrequencyRuleEvent[] }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listVisitFrequencyEvents()
      .then((events) => !cancelled && setState({ status: 'ready', events }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const describe = (v: VisitFrequencyRuleEvent['before']) =>
    [
      v.intervalDays !== undefined
        ? t('visitFrequency.intervalValue', { days: v.intervalDays })
        : null,
      v.defaultMethod ? t(`visitFrequency.methods.${v.defaultMethod}`) : null,
      v.firstVisitWithinDays !== undefined
        ? t('visitFrequency.history.days', { days: v.firstVisitWithinDays })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <section className={own.history} aria-labelledby="visit-frequency-history">
      <h2 id="visit-frequency-history" className={own.historyTitle}>
        {t('visitFrequency.history.title')}
      </h2>
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('visitFrequency.history.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <p className={styles.error} role="alert">
          {t('visitFrequency.history.loadFailed')}
        </p>
      )}
      {state.status === 'ready' && state.events.length === 0 && (
        <p className={styles.muted}>{t('visitFrequency.history.empty')}</p>
      )}
      {state.status === 'ready' && state.events.length > 0 && (
        <ol className={own.events}>
          {state.events.map((e) => (
            <li key={e.id}>
              <span>
                {t('visitFrequency.history.entry', {
                  target:
                    e.target === 'first_visit'
                      ? t('visitFrequency.history.firstVisit')
                      : t(`visitFrequency.tiers.${e.target}`),
                  before: describe(e.before),
                  after: describe(e.after),
                })}
              </span>
              <span className={own.eventMeta}>
                {e.actorName ?? t('visitFrequency.history.system')} ·{' '}
                <time dateTime={e.createdAt}>{time.format(new Date(e.createdAt))}</time> ·{' '}
                {t('visitFrequency.history.version', { version: e.rulesVersion })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
