import { auditLogQuerySchema, type AuditLogEntry, type CurrentUser } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Download, Info } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auditLogExportUrl, listAuditLog } from '../api/accounts';
import styles from '../thresholds/Thresholds.module.css';
import own from './AuditLog.module.css';

const DAY_MS = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: AuditLogEntry[]; truncated: boolean };

const FIELDS = [
  'name',
  'slug',
  'region',
  'seat_limit',
  'contract_start',
  'contract_end',
  'status',
  'suspended_reason',
  'role',
  'email',
  'display_name',
  'org_id',
  'brand_name',
  'brand_color',
  'login_greeting',
  'logo',
  'plans',
  'plan',
  'code',
] as const;

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 改前改后只有业务字段（邮箱是掩码），列出变了的字段 */
function changedFields(entry: AuditLogEntry): { field: (typeof FIELDS)[number]; value: string }[] {
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  return FIELDS.filter(
    (k) => k in after && JSON.stringify(after[k]) !== JSON.stringify(before[k]),
  ).map((field) => ({ field, value: show(after[field]) }));
}

/**
 * 后台审计日志（M7 规格 2.7）：平台看全部，协会管理员只看本协会（后端按行级安全限定）。
 * 只能查看和导出，不能修改。
 */
export function AuditLogPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const id = useId();
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * DAY_MS)));
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const query = auditLogQuerySchema.safeParse({ from, to });

  useEffect(() => {
    if (!query.success) return;
    let cancelled = false;
    setState({ status: 'loading' });
    listAuditLog(query.data)
      .then((r) => !cancelled && setState({ status: 'ready', ...r }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, reloadKey]);

  return (
    <section className={styles.page} aria-labelledby="audit-log-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>
          {user.role === 'platform_admin'
            ? t('auditLog.disclaimerPlatform')
            : t('auditLog.disclaimerOperator')}
        </span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="audit-log-title" className={styles.title}>
            {t('auditLog.title')}
          </h1>
        </div>
        <div className={own.toolbar}>
          <div className={styles.field}>
            <label htmlFor={`${id}-from`}>{t('auditLog.from')}</label>
            <input
              id={`${id}-from`}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-to`}>{t('auditLog.to')}</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {query.success && (
            <a className={own.exportLink} href={auditLogExportUrl(query.data)} download>
              <Download size={16} aria-hidden /> {t('auditLog.export')}
            </a>
          )}
        </div>
      </div>
      {!query.success && (
        <p className={styles.error} role="alert">
          {t('auditLog.badRange')}
        </p>
      )}
      {query.success && state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('auditLog.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('auditLog.loadFailed')}</span>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t('auditLog.retry')}</Button>
        </div>
      )}
      {query.success && state.status === 'ready' && (
        <>
          {state.truncated && <p className={styles.hint}>{t('auditLog.truncated')}</p>}
          {state.entries.length === 0 ? (
            <p className={styles.muted}>{t('auditLog.empty')}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('auditLog.columns.time')}</th>
                  <th scope="col">{t('auditLog.columns.actor')}</th>
                  <th scope="col">{t('auditLog.columns.object')}</th>
                  <th scope="col">{t('auditLog.columns.action')}</th>
                  <th scope="col">{t('auditLog.columns.change')}</th>
                </tr>
              </thead>
              <tbody>
                {state.entries.map((e) => (
                  <tr key={e.id}>
                    <td data-label={t('auditLog.columns.time')}>
                      <time dateTime={e.createdAt}>
                        {e.createdAt.slice(0, 16).replace('T', ' ')}
                      </time>
                    </td>
                    <td data-label={t('auditLog.columns.actor')}>
                      {e.actorRole ? t(`shell.roles.${e.actorRole}`) : t('auditLog.system')}
                    </td>
                    <td data-label={t('auditLog.columns.object')}>
                      {t(`auditLog.objects.${e.objectType}`)}
                    </td>
                    <th scope="row" data-label={t('auditLog.columns.action')}>
                      {t(`auditLog.actions.${e.action}`)}
                    </th>
                    <td data-label={t('auditLog.columns.change')}>
                      {changedFields(e)
                        .map((c) => `${t(`auditLog.fields.${c.field}`)}：${c.value}`)
                        .join('；') || t('auditLog.noChange')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
