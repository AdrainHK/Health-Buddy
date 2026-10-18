import type { CurrentUser, TwinStatsQuery, TwinStatsResponse } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';
import { getTwinStats } from '../api/twinRules';
import styles from '../experts/Experts.module.css';
import base from '../thresholds/Thresholds.module.css';

type State =
  | { status: 'loading' }
  | { status: 'error'; invalidRange: boolean }
  | { status: 'ready'; data: TwinStatsResponse };

type Counts = TwinStatsResponse['totals'];

const COUNT_KEYS = [
  'opens',
  'followUpsCreated',
  'done',
  'snoozed',
  'dismissed',
  'reopened',
  'summaries',
] as const satisfies readonly (keyof Counts)[];

/**
 * 孪生使用统计（M4 规格 7.2 统计视图）。协会管理员看本协会，平台管理员看全平台、可按协会筛选。
 * 只有按协会、日期汇总的数字，不含健管师和客户。日期按 UTC 自然日。
 */
export function TwinStatsPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const platform = user.role === 'platform_admin';
  const [query, setQuery] = useState<TwinStatsQuery>({});
  const [draft, setDraft] = useState<TwinStatsQuery>({});
  const [state, setState] = useState<State>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [operators, setOperators] = useState<TwinStatsResponse['operators']>([]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getTwinStats(query)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data });
        setOperators(data.operators);
        setDraft((d) => ({ ...d, from: d.from ?? data.from, to: d.to ?? data.to }));
      })
      .catch(
        (err: unknown) =>
          !cancelled &&
          setState({
            status: 'error',
            invalidRange: err instanceof ApiError && err.code === 'bad_request',
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [query, version]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setQuery({
      ...(draft.from ? { from: draft.from } : {}),
      ...(draft.to ? { to: draft.to } : {}),
      ...(platform && draft.operatorId ? { operatorId: draft.operatorId } : {}),
    });
    setVersion((v) => v + 1);
  };

  const countHeaders = COUNT_KEYS.map((k) => (
    <th scope="col" key={k}>
      {t(`twinStats.columns.${k}`)}
    </th>
  ));
  const countCells = (c: Counts) =>
    COUNT_KEYS.map((k) => (
      <td key={k} data-label={t(`twinStats.columns.${k}`)} className={styles.number}>
        {c[k]}
      </td>
    ));

  return (
    <section className={base.page} aria-labelledby="twin-stats-title">
      <div className={base.titleRow}>
        <div>
          <h1 id="twin-stats-title" className={base.title}>
            {t('twinStats.title')}
          </h1>
          <p className={base.subtitle}>
            {platform ? t('twinStats.subtitlePlatform') : t('twinStats.subtitleOperator')}
          </p>
        </div>
      </div>

      <p className={base.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('twinStats.dateNote')}</span>
      </p>

      <form className={styles.filters} onSubmit={apply}>
        <label>
          {t('twinStats.from')}
          <input
            type="date"
            value={draft.from ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))}
          />
        </label>
        <label>
          {t('twinStats.to')}
          <input
            type="date"
            value={draft.to ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))}
          />
        </label>
        {platform && (
          <label>
            {t('twinStats.operator')}
            <select
              value={draft.operatorId ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, operatorId: e.target.value || undefined }))}
            >
              <option value="">{t('twinStats.allOperators')}</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="primary">
          {t('twinStats.apply')}
        </Button>
      </form>

      {state.status === 'loading' && (
        <p className={base.muted} role="status">
          {t('twinStats.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={base.error} role="alert">
          <span>
            {state.invalidRange ? t('twinStats.invalidRange') : t('twinStats.loadFailed')}
          </span>
          {!state.invalidRange && (
            <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
              {t('twinStats.retry')}
            </Button>
          )}
        </div>
      )}
      {state.status === 'ready' && state.data.rows.length === 0 && (
        <p className={base.muted}>{t('twinStats.empty')}</p>
      )}
      {state.status === 'ready' && state.data.rows.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>{t('twinStats.totalsTitle')}</h2>
          <table className={base.table} aria-label={t('twinStats.totalsTitle')}>
            <thead>
              <tr>{countHeaders}</tr>
            </thead>
            <tbody>
              <tr>{countCells(state.data.totals)}</tr>
            </tbody>
          </table>

          <h2 className={styles.sectionTitle}>{t('twinStats.dailyTitle')}</h2>
          <table className={base.table} aria-label={t('twinStats.dailyTitle')}>
            <thead>
              <tr>
                <th scope="col">{t('twinStats.columns.date')}</th>
                {platform && <th scope="col">{t('twinStats.columns.operator')}</th>}
                {countHeaders}
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row) => (
                <tr key={`${row.date}-${row.operatorId ?? ''}`}>
                  <th scope="row" data-label={t('twinStats.columns.date')}>
                    {row.date}
                  </th>
                  {platform && (
                    <td data-label={t('twinStats.columns.operator')}>
                      {row.operatorName ?? t('twinStats.none')}
                    </td>
                  )}
                  {countCells(row)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
