import type {
  CurrentUser,
  ExpertStatsQuery,
  ExpertStatsResponse,
  ExpertUsageTotal,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';
import { getExpertStats } from '../api/experts';
import base from '../thresholds/Thresholds.module.css';
import styles from './Experts.module.css';

type State =
  | { status: 'loading' }
  | { status: 'error'; invalidRange: boolean }
  | { status: 'ready'; data: ExpertStatsResponse };

type Counts = Omit<ExpertUsageTotal, 'expertId' | 'expertName'>;

/**
 * 专家调用统计（M3 规格 1.3、6.4，验收第 25 条）。协会管理员看本协会，平台管理员看全平台、可按协会筛选。
 * 只有汇总数字：不含健管师、客户、任务，也不含专家意见内容。日期按 UTC 自然日。
 */
export function ExpertStatsPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const platform = user.role === 'platform_admin';
  const [query, setQuery] = useState<ExpertStatsQuery>({});
  const [draft, setDraft] = useState<ExpertStatsQuery>({});
  const [state, setState] = useState<State>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  // 协会下拉在重新加载时保留上一次的选项
  const [operators, setOperators] = useState<ExpertStatsResponse['operators']>([]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getExpertStats(query)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data });
        setOperators(data.operators);
        // 第一次加载时把后端给的默认范围填进输入框
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

  const percent = (v: number | null) =>
    v === null
      ? t('expertStats.none')
      : t('expertStats.percent', { value: Math.round(v * 1000) / 10 });
  const cost = (v: number) => v.toFixed(4);

  const countCells = (c: Counts) => (
    <>
      <td data-label={t('expertStats.columns.calls')} className={styles.number}>
        {c.calls}
      </td>
      <td data-label={t('expertStats.columns.successRate')} className={styles.number}>
        {percent(c.successRate)}
      </td>
      <td data-label={t('expertStats.columns.timeoutRate')} className={styles.number}>
        {percent(c.timeoutRate)}
      </td>
      <td data-label={t('expertStats.columns.inputTokens')} className={styles.number}>
        {c.inputTokens}
      </td>
      <td data-label={t('expertStats.columns.outputTokens')} className={styles.number}>
        {c.outputTokens}
      </td>
      <td data-label={t('expertStats.columns.cost')} className={styles.number}>
        {cost(c.costUsd)}
      </td>
      <td data-label={t('expertStats.columns.useful')} className={styles.number}>
        {c.useful}
      </td>
      <td data-label={t('expertStats.columns.notUseful')} className={styles.number}>
        {c.notUseful}
      </td>
    </>
  );

  const countHeaders = (
    <>
      <th scope="col">{t('expertStats.columns.calls')}</th>
      <th scope="col">{t('expertStats.columns.successRate')}</th>
      <th scope="col">{t('expertStats.columns.timeoutRate')}</th>
      <th scope="col">{t('expertStats.columns.inputTokens')}</th>
      <th scope="col">{t('expertStats.columns.outputTokens')}</th>
      <th scope="col">{t('expertStats.columns.cost')}</th>
      <th scope="col">{t('expertStats.columns.useful')}</th>
      <th scope="col">{t('expertStats.columns.notUseful')}</th>
    </>
  );

  return (
    <section className={base.page} aria-labelledby="expert-stats-title">
      <div className={base.titleRow}>
        <div>
          <h1 id="expert-stats-title" className={base.title}>
            {t('expertStats.title')}
          </h1>
          <p className={base.subtitle}>
            {platform ? t('expertStats.subtitlePlatform') : t('expertStats.subtitleOperator')}
          </p>
        </div>
      </div>

      <p className={base.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('expertStats.costNote')}</span>
      </p>

      <form className={styles.filters} onSubmit={apply}>
        <label>
          {t('expertStats.from')}
          <input
            type="date"
            value={draft.from ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))}
          />
        </label>
        <label>
          {t('expertStats.to')}
          <input
            type="date"
            value={draft.to ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))}
          />
        </label>
        {platform && (
          <label>
            {t('expertStats.operator')}
            <select
              value={draft.operatorId ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, operatorId: e.target.value || undefined }))}
            >
              <option value="">{t('expertStats.allOperators')}</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="primary">
          {t('expertStats.apply')}
        </Button>
      </form>

      {state.status === 'loading' && (
        <p className={base.muted} role="status">
          {t('expertStats.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={base.error} role="alert">
          <span>
            {state.invalidRange ? t('expertStats.invalidRange') : t('expertStats.loadFailed')}
          </span>
          {!state.invalidRange && (
            <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>
              {t('expertStats.retry')}
            </Button>
          )}
        </div>
      )}
      {state.status === 'ready' && state.data.rows.length === 0 && (
        <p className={base.muted}>{t('expertStats.empty')}</p>
      )}
      {state.status === 'ready' && state.data.rows.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>{t('expertStats.totalsTitle')}</h2>
          <table className={base.table} aria-label={t('expertStats.totalsTitle')}>
            <thead>
              <tr>
                <th scope="col">{t('expertStats.columns.expert')}</th>
                {countHeaders}
              </tr>
            </thead>
            <tbody>
              {state.data.totals.map((row) => (
                <tr key={row.expertId}>
                  <th scope="row" data-label={t('expertStats.columns.expert')}>
                    {row.expertName}
                  </th>
                  {countCells(row)}
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className={styles.sectionTitle}>{t('expertStats.dailyTitle')}</h2>
          <table className={base.table} aria-label={t('expertStats.dailyTitle')}>
            <thead>
              <tr>
                <th scope="col">{t('expertStats.columns.date')}</th>
                {platform && <th scope="col">{t('expertStats.columns.operator')}</th>}
                <th scope="col">{t('expertStats.columns.expert')}</th>
                {countHeaders}
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row) => (
                <tr key={`${row.date}-${row.operatorId ?? ''}-${row.expertId}`}>
                  <th scope="row" data-label={t('expertStats.columns.date')}>
                    {row.date}
                  </th>
                  {platform && (
                    <td data-label={t('expertStats.columns.operator')}>
                      {row.operatorName ?? t('expertStats.none')}
                    </td>
                  )}
                  <td data-label={t('expertStats.columns.expert')}>{row.expertName}</td>
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
