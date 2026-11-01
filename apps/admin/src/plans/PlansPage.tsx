import {
  PILOT_PLAN_CODE,
  PLAN_FEATURES,
  PLAN_NAME_MAX,
  QUOTA_METRICS,
  createPlanRequestSchema,
  updatePlanRequestSchema,
  type Plan,
  type PlanFeatures,
  type PlanQuotas,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Plus } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPlan, listPlans, retirePlan, updatePlan } from '../api/accounts';
import { ApiError } from '../api/http';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; plans: Plan[] };
type ErrorKey = 'duplicate' | 'bad_request' | 'not_found' | 'network' | 'unknown';

function errorKey(err: unknown): ErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'conflict') return 'duplicate';
  if (err.code === 'bad_request' || err.code === 'not_found' || err.code === 'network') {
    return err.code;
  }
  return 'unknown';
}

/**
 * 平台“套餐”页（M7 规格 2.5）：定义套餐的功能开关和每月额度，停售。
 * 额度留空表示不另设上限（只受系统的技术性上限）。修改会影响所有用这个套餐的账号，保存前二次确认。
 * 套餐档位（Q6）没定之前只有内置的“试点版”。
 */
export function PlansPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPlans()
      .then((plans) => !cancelled && setState({ status: 'ready', plans }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);

  const retire = async (p: Plan) => {
    if (!window.confirm(t('plans.confirmRetire', { name: p.name, count: p.assignedCount ?? 0 }))) {
      return;
    }
    setActionError(null);
    try {
      await retirePlan(p.id);
      setNotice(t('plans.retired', { name: p.name }));
      reload();
    } catch (err) {
      setActionError(errorKey(err));
    }
  };

  return (
    <section className={styles.page} aria-labelledby="plans-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('plans.disclaimer')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="plans-title" className={styles.title}>
            {t('plans.title')}
          </h1>
          <p className={styles.subtitle}>{t('plans.subtitle')}</p>
        </div>
        <div className={styles.toolbar}>
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden />}
            onClick={() => {
              setNotice(null);
              setEditing('new');
            }}
          >
            {t('plans.create')}
          </Button>
        </div>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className={styles.error} role="alert">
          {t(`plans.errors.${actionError}`)}
        </p>
      )}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('plans.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('plans.loadFailed')}</span>
          <Button onClick={reload}>{t('plans.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('plans.columns.name')}</th>
              <th scope="col">{t('plans.columns.features')}</th>
              <th scope="col">{t('plans.columns.quotas')}</th>
              <th scope="col">{t('plans.columns.assigned')}</th>
              <th scope="col">{t('plans.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {state.plans.map((p) => (
              <tr key={p.id} className={p.status === 'retired' ? styles.disabledRow : undefined}>
                <th scope="row" data-label={t('plans.columns.name')}>
                  {p.name}
                  <small className={styles.hint}>
                    {' '}
                    {p.code}
                    {p.status === 'retired' ? ` · ${t('plans.status.retired')}` : ''}
                  </small>
                </th>
                <td data-label={t('plans.columns.features')}>
                  {PLAN_FEATURES.filter((k) => p.features[k])
                    .map((k) => t(`plans.features.${k}`))
                    .join('、') || t('plans.noFeatures')}
                </td>
                <td data-label={t('plans.columns.quotas')}>
                  {QUOTA_METRICS.map(
                    (k) =>
                      `${t(`plans.quotas.${k}`)}：${
                        p.monthlyQuotas[k] === null ? t('plans.unlimited') : p.monthlyQuotas[k]
                      }`,
                  ).join('；')}
                </td>
                <td data-label={t('plans.columns.assigned')}>{p.assignedCount ?? 0}</td>
                <td data-label={t('plans.columns.actions')}>
                  <div className={styles.rowActions}>
                    <Button
                      variant="ghost"
                      aria-label={t('plans.editLabel', { name: p.name })}
                      onClick={() => {
                        setNotice(null);
                        setEditing(p);
                      }}
                    >
                      {t('plans.edit')}
                    </Button>
                    {p.status === 'active' && p.code !== PILOT_PLAN_CODE && (
                      <Button
                        variant="ghost"
                        aria-label={t('plans.retireLabel', { name: p.name })}
                        onClick={() => void retire(p)}
                      >
                        {t('plans.retire')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <PlanDialog
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            setNotice(t('plans.saved', { name: p.name }));
            reload();
          }}
        />
      )}
    </section>
  );
}

function PlanDialog({
  plan,
  onClose,
  onSaved,
}: {
  plan: Plan | null;
  onClose: () => void;
  onSaved: (p: Plan) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [features, setFeatures] = useState<PlanFeatures>(
    plan?.features ?? { experts: true, twin: true, care: true, companion: true, content: true },
  );
  const [quotas, setQuotas] = useState<Record<keyof PlanQuotas, string>>(() => {
    const q = plan?.monthlyQuotas;
    return {
      llm_calls: q?.llm_calls?.toString() ?? '',
      expert_calls: q?.expert_calls?.toString() ?? '',
      report_pages: q?.report_pages?.toString() ?? '',
      companion_devices: q?.companion_devices?.toString() ?? '',
    };
  });
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const monthlyQuotas = Object.fromEntries(
      QUOTA_METRICS.map((k) => [k, quotas[k].trim() === '' ? null : Number(quotas[k])]),
    );
    const body = { name, features, monthlyQuotas };
    const parsed = plan
      ? updatePlanRequestSchema.safeParse(body)
      : createPlanRequestSchema.safeParse({ ...body, code });
    if (!parsed.success) return setError('bad_request');
    // 修改影响所有用这个套餐的账号（规格 2.5 第 2 条）
    if (plan && !window.confirm(t('plans.confirmUpdate', { count: plan.assignedCount ?? 0 }))) {
      return;
    }
    setSaving(true);
    try {
      onSaved(
        plan
          ? await updatePlan(plan.id, updatePlanRequestSchema.parse(body))
          : await createPlan(createPlanRequestSchema.parse({ ...body, code })),
      );
    } catch (err) {
      setError(errorKey(err));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={plan ? t('plans.editTitle', { name: plan.name }) : t('plans.create')}
      onClose={onClose}
      wide
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor={`${id}-code`}>{t('plans.form.code')}</label>
            <input
              id={`${id}-code`}
              value={code}
              disabled={Boolean(plan)}
              onChange={(e) => setCode(e.target.value.trim())}
            />
            <small className={styles.hint}>{t('plans.form.codeHint')}</small>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-name`}>{t('plans.form.name')}</label>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={PLAN_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <fieldset className={styles.field}>
          <legend>{t('plans.form.features')}</legend>
          {PLAN_FEATURES.map((k) => (
            <label key={k} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={features[k]}
                onChange={(e) => setFeatures((f) => ({ ...f, [k]: e.target.checked }))}
              />
              {t(`plans.features.${k}`)}
            </label>
          ))}
          <small className={styles.hint}>{t('plans.form.featuresHint')}</small>
        </fieldset>
        <div className={styles.fieldRow}>
          {QUOTA_METRICS.map((k) => (
            <div key={k} className={styles.field}>
              <label htmlFor={`${id}-${k}`}>{t(`plans.quotas.${k}`)}</label>
              <input
                id={`${id}-${k}`}
                inputMode="numeric"
                value={quotas[k]}
                placeholder={t('plans.unlimited')}
                onChange={(e) => setQuotas((q) => ({ ...q, [k]: e.target.value.trim() }))}
              />
            </div>
          ))}
        </div>
        <small className={styles.hint}>{t('plans.form.quotasHint')}</small>
        {error && (
          <p className={styles.error} role="alert">
            {t(`plans.errors.${error}`)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={onClose}>{t('plans.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? t('plans.saving') : t('plans.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
