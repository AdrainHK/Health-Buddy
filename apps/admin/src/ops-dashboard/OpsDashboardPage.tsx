import {
  OPS_DASHBOARD_DAYS,
  type CurrentUser,
  type OpsDashboardResponse,
  type OpsGroup,
  type OpsMetric,
  type OpsMetrics,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getOpsDashboard } from '../api/ops-dashboard';
import base from '../thresholds/Thresholds.module.css';
import styles from './OpsDashboard.module.css';

type State =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: OpsDashboardResponse };

/** 卡片和表格里显示的指标（按规格 2.6 的四类排列） */
const CARD_METRICS: OpsMetric[] = [
  'managers_opened',
  'managers_active',
  'managers_engaged',
  'clients_total',
  'clients_new',
  'artifacts',
  'expert_calls',
  'care_plans',
  'visits_done',
  'companion_bound',
  'companion_active',
  'llm_calls',
];
const TABLE_METRICS: OpsMetric[] = [
  'managers_opened',
  'managers_engaged',
  'clients_total',
  'artifacts',
  'expert_calls',
  'llm_calls',
];

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

/**
 * 运营看板（M7 规格 2.6）。协会管理员看本协会、按机构分组；机构管理员看本机构；平台看全部协会
 * （到期提醒、估算成本，可按协会筛选）。只有汇总数字，少于 5 人的机构合并为“其他”（Q15）。
 */
export function OpsDashboardPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const id = useId();
  const platform = user.role === 'platform_admin';
  const [days, setDays] = useState<number>(30);
  const [operatorId, setOperatorId] = useState<string>('');
  const [operators, setOperators] = useState<{ id: string; name: string }[]>([]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getOpsDashboard(days, operatorId || undefined)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data });
        if (data.operators)
          setOperators(data.operators.map((o) => ({ id: o.operatorId, name: o.name })));
      })
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [days, operatorId, version]);

  const groupName = (g: OpsGroup) =>
    g.kind === 'other'
      ? t('ops.groupOther')
      : g.kind === 'none'
        ? t('ops.groupNone')
        : (g.name ?? '—');

  return (
    <section className={base.page} aria-labelledby="ops-title">
      <p className={base.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{platform ? t('ops.disclaimerPlatform') : t('ops.disclaimer')}</span>
      </p>
      <div className={base.titleRow}>
        <div>
          <h1 id="ops-title" className={base.title}>
            {t('ops.title')}
          </h1>
          {state.status === 'ready' && (
            <p className={base.subtitle}>
              {t('ops.range', { from: state.data.from, to: state.data.to })}
            </p>
          )}
        </div>
        <div className={base.toolbar}>
          <div className={styles.ranges} role="group" aria-label={t('ops.rangeLabel')}>
            {OPS_DASHBOARD_DAYS.map((d) => (
              <Button
                key={d}
                variant={d === days ? 'primary' : 'ghost'}
                aria-pressed={d === days}
                onClick={() => setDays(d)}
              >
                {t('ops.days', { days: d })}
              </Button>
            ))}
          </div>
          {platform && (
            <div className={base.field}>
              <label htmlFor={`${id}-op`}>{t('ops.operator')}</label>
              <select
                id={`${id}-op`}
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
              >
                <option value="">{t('ops.allOperators')}</option>
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {state.status === 'loading' && (
        <p className={base.muted} role="status">
          {t('ops.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={base.error} role="alert">
          <span>{t('ops.loadFailed')}</span>
          <Button onClick={() => setVersion((v) => v + 1)}>{t('ops.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && (
        <Dashboard data={state.data} groupName={groupName} platform={platform} />
      )}
    </section>
  );
}

function Dashboard({
  data,
  groupName,
  platform,
}: {
  data: OpsDashboardResponse;
  groupName: (g: OpsGroup) => string;
  platform: boolean;
}) {
  const { t } = useTranslation();
  const m = data.totals.metrics;
  const maxSkill = Math.max(1, ...data.skills.map((s) => s.n));
  return (
    <>
      <div className={styles.cards} data-testid="ops-cards">
        {CARD_METRICS.map((k) => (
          <Card key={k} label={t(`ops.metrics.${k}`)} value={String(m[k])} />
        ))}
        {data.twinOpens !== null && (
          <Card label={t('ops.twinOpens')} value={String(data.twinOpens)} />
        )}
        {data.seats && (
          <Card
            label={t('ops.seats')}
            value={t('ops.seatsValue', { used: data.seats.used, limit: data.seats.limit })}
          />
        )}
        {data.totals.costUsd !== null && (
          <Card label={t('ops.cost')} value={money(data.totals.costUsd)} />
        )}
      </div>

      {data.operators && (
        <>
          <h2 className={styles.sectionTitle}>{t('ops.operatorsTitle')}</h2>
          <table className={base.table}>
            <thead>
              <tr>
                <th scope="col">{t('ops.columns.operator')}</th>
                <th scope="col">{t('ops.columns.contractEnd')}</th>
                {TABLE_METRICS.map((k) => (
                  <th key={k} scope="col">
                    {t(`ops.metrics.${k}`)}
                  </th>
                ))}
                <th scope="col">{t('ops.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.operators.map((o) => (
                <tr key={o.operatorId}>
                  <th scope="row" data-label={t('ops.columns.operator')}>
                    {o.name}
                  </th>
                  <td data-label={t('ops.columns.contractEnd')}>
                    {o.contractEnd ?? t('ops.noContract')}
                    {o.expired ? (
                      <span className={base.hint}> {t('ops.expired')}</span>
                    ) : o.expiringSoon ? (
                      <span className={base.hint}> {t('ops.expiringSoon')}</span>
                    ) : null}
                  </td>
                  <MetricCells metrics={o.metrics} />
                  <td data-label={t('ops.cost')}>{o.costUsd === null ? '—' : money(o.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.groups.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>{t('ops.groupsTitle')}</h2>
          <table className={base.table}>
            <thead>
              <tr>
                <th scope="col">{t('ops.columns.group')}</th>
                {TABLE_METRICS.map((k) => (
                  <th key={k} scope="col">
                    {t(`ops.metrics.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g, i) => (
                <tr key={g.orgId ?? `${g.kind}-${i}`}>
                  <th scope="row" data-label={t('ops.columns.group')}>
                    {groupName(g)}
                  </th>
                  {g.hidden ? (
                    <td colSpan={TABLE_METRICS.length}>{t('ops.hiddenSmall')}</td>
                  ) : (
                    <MetricCells metrics={g.metrics} />
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className={base.hint}>{t('ops.smallGroupHint')}</p>
        </>
      )}

      {data.skills.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>{t('ops.skillsTitle')}</h2>
          <div role="list" aria-label={t('ops.skillsTitle')}>
            {data.skills.map((s) => (
              <div key={s.skillId} role="listitem" className={styles.barRow}>
                <span>{s.title}</span>
                <span className={styles.barTrack}>
                  <span
                    className={styles.bar}
                    style={{ display: 'block', width: `${(s.n / maxSkill) * 100}%` }}
                  />
                </span>
                <span>{s.n}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {!platform && <p className={base.hint}>{t('ops.costHidden')}</p>}
    </>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.card}>
      <span className={styles.cardLabel}>{label}</span>
      <span className={styles.cardValue}>{value}</span>
    </div>
  );
}

function MetricCells({ metrics }: { metrics: OpsMetrics }) {
  const { t } = useTranslation();
  return (
    <>
      {TABLE_METRICS.map((k) => (
        <td key={k} data-label={t(`ops.metrics.${k}`)}>
          {metrics[k]}
        </td>
      ))}
    </>
  );
}
