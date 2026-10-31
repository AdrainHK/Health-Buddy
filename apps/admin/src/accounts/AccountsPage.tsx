import {
  ACCOUNT_IMPORT_HEADER,
  ACCOUNT_IMPORT_MAX_ROWS,
  INVITE_TTL_HOURS,
  accountImportErrorSchema,
  createOrganizationRequestSchema,
  operatorInviteRequestSchema,
  parseAccountCsv,
  type AccountImportError,
  type CurrentUser,
  type InviteResponse,
  type OperatorAccount,
  type OperatorInviteRole,
  type OperatorSummary,
  type OrganizationSummary,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Copy, Download, Info, Plus, Upload } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createOrganization,
  importAccounts,
  inviteAccount,
  inviteLink,
  listAccounts,
  listOrganizations,
  myOperator,
  reinviteAccount,
  setAccountSuspended,
} from '../api/accounts';
import { ApiError } from '../api/http';
import { InviteLink } from '../operators/OperatorsPage';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';

type Data = {
  operator: OperatorSummary | null;
  organizations: OrganizationSummary[];
  accounts: OperatorAccount[];
};
type State = { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Data);

type ErrorKey =
  | 'duplicate'
  | 'orgDuplicate'
  | 'orgBadName'
  | 'orgHasClients'
  | 'seat_limit_reached'
  | 'has_clients'
  | 'bad_request'
  | 'not_found'
  | 'network'
  | 'unknown';

function errorKey(err: unknown): ErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'conflict') return 'duplicate';
  if (
    err.code === 'seat_limit_reached' ||
    err.code === 'has_clients' ||
    err.code === 'bad_request' ||
    err.code === 'not_found' ||
    err.code === 'network'
  ) {
    return err.code;
  }
  return 'unknown';
}

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(
  `\uFEFF${ACCOUNT_IMPORT_HEADER.join(',')}\n`,
)}`;

/**
 * 协会“账号”页（M7 规格 2.4）。协会管理员：开机构，单个或批量开通健管师和机构管理员，
 * 停用、恢复、重发邀请；页头显示席位。机构管理员：只读本机构的账号（Q9）。
 * 能看到客户的账号（名下有客户的健管师、有客户机构的机构管理员）不能重发邀请，健管师有客户时不能停用（Q8）。
 * 界面只决定显示什么，权限和这些限制都在后端。
 */
export function AccountsPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const manage = user.role === 'operator_admin';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<'org' | 'invite' | 'import' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorKey | null>(null);
  const [invite, setInvite] = useState<InviteResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<Data> => {
      if (!manage) return { operator: null, organizations: [], accounts: await listAccounts() };
      const [operator, organizations, accounts] = await Promise.all([
        myOperator(),
        listOrganizations(),
        listAccounts(),
      ]);
      return { operator, organizations, accounts };
    };
    load()
      .then((d) => !cancelled && setState({ status: 'ready', ...d }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [manage, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const orgName = (id: string | null) =>
    (state.status === 'ready' && state.organizations.find((o) => o.id === id)?.name) || '—';

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      reload();
    } catch (err) {
      setActionError(errorKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.page} aria-labelledby="accounts-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{manage ? t('accounts.disclaimer') : t('accounts.disclaimerOrg')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="accounts-title" className={styles.title}>
            {t('accounts.title')}
          </h1>
          {state.status === 'ready' && state.operator && (
            <p className={styles.subtitle} data-testid="seats">
              {t('accounts.seats', {
                used: state.operator.seatsUsed,
                limit: state.operator.seatLimit,
              })}
            </p>
          )}
        </div>
        {manage && (
          <div className={styles.toolbar}>
            <Button icon={<Plus size={16} aria-hidden />} onClick={() => setDialog('org')}>
              {t('accounts.createOrg')}
            </Button>
            <Button icon={<Upload size={16} aria-hidden />} onClick={() => setDialog('import')}>
              {t('accounts.import')}
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={16} aria-hidden />}
              onClick={() => setDialog('invite')}
            >
              {t('accounts.invite')}
            </Button>
          </div>
        )}
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className={styles.error} role="alert">
          {t(`accounts.errors.${actionError}`)}
        </p>
      )}
      {invite && <InviteLink invite={invite} />}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('accounts.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('accounts.loadFailed')}</span>
          <Button onClick={reload}>{t('accounts.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && manage && (
        <>
          <h2 className={styles.dialogTitle}>{t('accounts.orgsTitle')}</h2>
          {state.organizations.length === 0 ? (
            <p className={styles.muted}>{t('accounts.noOrgs')}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('accounts.orgColumns.name')}</th>
                  <th scope="col">{t('accounts.orgColumns.managers')}</th>
                  <th scope="col">{t('accounts.orgColumns.clients')}</th>
                </tr>
              </thead>
              <tbody>
                {state.organizations.map((o) => (
                  <tr key={o.id}>
                    <th scope="row" data-label={t('accounts.orgColumns.name')}>
                      {o.name}
                    </th>
                    <td data-label={t('accounts.orgColumns.managers')}>{o.managerCount}</td>
                    <td data-label={t('accounts.orgColumns.clients')}>{o.clientCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {state.status === 'ready' && (
        <>
          <h2 className={styles.dialogTitle}>{t('accounts.accountsTitle')}</h2>
          {state.accounts.length === 0 ? (
            <p className={styles.muted}>{t('accounts.noAccounts')}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('accounts.columns.name')}</th>
                  <th scope="col">{t('accounts.columns.role')}</th>
                  {manage && <th scope="col">{t('accounts.columns.org')}</th>}
                  <th scope="col">{t('accounts.columns.status')}</th>
                  <th scope="col">{t('accounts.columns.lastLogin')}</th>
                  {manage && <th scope="col">{t('accounts.columns.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {state.accounts.map((a) => {
                  const editable = manage && (a.role === 'manager' || a.role === 'org_admin');
                  const seesClients = (a.clientCount ?? 0) > 0;
                  return (
                    <tr
                      key={a.id}
                      className={a.status === 'disabled' ? styles.disabledRow : undefined}
                    >
                      <th scope="row" data-label={t('accounts.columns.name')}>
                        {a.displayName}
                      </th>
                      <td data-label={t('accounts.columns.role')}>{t(`shell.roles.${a.role}`)}</td>
                      {manage && <td data-label={t('accounts.columns.org')}>{orgName(a.orgId)}</td>}
                      <td data-label={t('accounts.columns.status')}>
                        {t(`operators.accountStatus.${a.status}`)}
                      </td>
                      <td data-label={t('accounts.columns.lastLogin')}>
                        {a.lastLoginAt
                          ? a.lastLoginAt.slice(0, 16).replace('T', ' ')
                          : t('accounts.never')}
                      </td>
                      {manage && (
                        <td data-label={t('accounts.columns.actions')}>
                          {editable && (
                            <div className={styles.rowActions}>
                              {a.status !== 'disabled' && (
                                <Button
                                  variant="ghost"
                                  disabled={busy || seesClients}
                                  title={seesClients ? t('accounts.reinviteBlocked') : undefined}
                                  aria-label={t('operators.reinviteLabel', {
                                    name: a.displayName,
                                  })}
                                  onClick={() => {
                                    if (
                                      a.status === 'active' &&
                                      !window.confirm(
                                        t('operators.confirmReinvite', { name: a.displayName }),
                                      )
                                    )
                                      return;
                                    void run(async () => {
                                      setInvite(await reinviteAccount(a.id));
                                    }, t('operators.invited'));
                                  }}
                                >
                                  {t('operators.reinvite')}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                disabled={
                                  busy ||
                                  (a.status !== 'disabled' && a.role === 'manager' && seesClients)
                                }
                                title={
                                  a.status !== 'disabled' && a.role === 'manager' && seesClients
                                    ? t('accounts.disableBlocked', { count: a.clientCount ?? 0 })
                                    : undefined
                                }
                                aria-label={t(
                                  a.status === 'disabled'
                                    ? 'operators.enableLabel'
                                    : 'operators.disableLabel',
                                  { name: a.displayName },
                                )}
                                onClick={() => {
                                  if (
                                    a.status !== 'disabled' &&
                                    !window.confirm(
                                      t('operators.confirmDisable', { name: a.displayName }),
                                    )
                                  )
                                    return;
                                  void run(
                                    async () => {
                                      setInvite(null);
                                      await setAccountSuspended(a.id, a.status !== 'disabled');
                                    },
                                    t(
                                      a.status === 'disabled'
                                        ? 'operators.resumed'
                                        : 'accounts.disabled',
                                    ),
                                  );
                                }}
                              >
                                {a.status === 'disabled'
                                  ? t('operators.enable')
                                  : t('operators.disable')}
                              </Button>
                            </div>
                          )}
                          {editable && seesClients && (
                            <small className={styles.hint}>
                              {t(
                                a.role === 'manager'
                                  ? 'accounts.hasClientsHint'
                                  : 'accounts.hasClientsHintOrg',
                                { count: a.clientCount ?? 0 },
                              )}
                            </small>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      {dialog === 'org' && (
        <OrgDialog
          onClose={() => setDialog(null)}
          onCreated={(o) => {
            setDialog(null);
            setNotice(t('accounts.orgCreated', { name: o.name }));
            reload();
          }}
        />
      )}
      {dialog === 'invite' && state.status === 'ready' && (
        <InviteDialog
          organizations={state.organizations}
          onClose={() => setDialog(null)}
          onInvited={(r) => {
            setDialog(null);
            setInvite(r);
            setNotice(t('operators.invited'));
            reload();
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          onClose={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

function OrgDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (o: OrganizationSummary) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = createOrganizationRequestSchema.safeParse({ name });
    if (!parsed.success) return setError('orgBadName');
    setSaving(true);
    try {
      onCreated(await createOrganization(parsed.data.name));
    } catch (err) {
      const key = errorKey(err);
      setError(key === 'duplicate' ? 'orgDuplicate' : key === 'bad_request' ? 'orgBadName' : key);
      setSaving(false);
    }
  };
  return (
    <Dialog title={t('accounts.createOrg')} onClose={onClose}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor={`${id}-name`}>{t('accounts.form.orgName')}</label>
          <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          <small className={styles.hint}>{t('accounts.form.orgNameHint')}</small>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {t(`accounts.errors.${error}`)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={onClose}>{t('operators.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? t('operators.saving') : t('operators.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteDialog({
  organizations,
  onClose,
  onInvited,
}: {
  organizations: OrganizationSummary[];
  onClose: () => void;
  onInvited: (r: InviteResponse) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState({
    displayName: '',
    email: '',
    role: 'manager' as OperatorInviteRole,
    orgId: '',
  });
  const [error, setError] = useState<ErrorKey | 'org_required' | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof values) => (v: string) => setValues((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = operatorInviteRequestSchema.safeParse({
      ...values,
      email: values.email.trim(),
      orgId: values.orgId || null,
    });
    if (!parsed.success) {
      return setError(
        values.role === 'org_admin' && !values.orgId ? 'org_required' : 'bad_request',
      );
    }
    setSaving(true);
    try {
      onInvited(await inviteAccount(parsed.data));
    } catch (err) {
      const key = errorKey(err);
      setError(key === 'has_clients' ? 'orgHasClients' : key);
      setSaving(false);
    }
  };
  return (
    <Dialog title={t('accounts.invite')} onClose={onClose}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor={`${id}-name`}>{t('accounts.form.name')}</label>
          <input
            id={`${id}-name`}
            value={values.displayName}
            onChange={(e) => set('displayName')(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-email`}>{t('accounts.form.email')}</label>
          <input
            id={`${id}-email`}
            type="email"
            value={values.email}
            onChange={(e) => set('email')(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-role`}>{t('accounts.form.role')}</label>
          <select
            id={`${id}-role`}
            value={values.role}
            onChange={(e) => set('role')(e.target.value)}
          >
            <option value="manager">{t('shell.roles.manager')}</option>
            <option value="org_admin">{t('shell.roles.org_admin')}</option>
          </select>
          <small className={styles.hint}>{t('accounts.form.seatHint')}</small>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-org`}>{t('accounts.form.org')}</label>
          <select
            id={`${id}-org`}
            value={values.orgId}
            onChange={(e) => set('orgId')(e.target.value)}
          >
            <option value="">{t('accounts.form.noOrg')}</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {t(`accounts.errors.${error}`)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={onClose}>{t('operators.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? t('operators.saving') : t('operators.invite')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type ImportState =
  | { status: 'idle' }
  | { status: 'file_error'; error: 'empty' | 'bad_header' | 'too_many_rows' | 'read' }
  | { status: 'rejected'; detail: AccountImportError }
  | { status: 'failed'; error: ErrorKey }
  | { status: 'done'; invites: (InviteResponse & { row: number })[] };

/** 读文本文件（FileReader 兼容面更广） */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    let text: string;
    try {
      text = await readText(file);
    } catch {
      return setState({ status: 'file_error', error: 'read' });
    }
    const parsed = parseAccountCsv(text);
    if (!parsed.ok) return setState({ status: 'file_error', error: parsed.error });
    setSaving(true);
    try {
      const r = await importAccounts(parsed.rows);
      setState({ status: 'done', invites: r.invites });
    } catch (err) {
      const detail =
        err instanceof ApiError ? accountImportErrorSchema.safeParse(err.details) : null;
      setState(
        detail?.success
          ? { status: 'rejected', detail: detail.data }
          : { status: 'failed', error: errorKey(err) },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={t('accounts.import')} onClose={onClose} wide>
      {state.status === 'done' ? (
        <div className={styles.form}>
          <p className={styles.notice} role="status">
            {t('accounts.imported', { count: state.invites.length })}
          </p>
          <p className={styles.hint}>
            {t('operators.inviteLinkHint', { hours: INVITE_TTL_HOURS })}
          </p>
          <table className={styles.table} data-testid="import-links">
            <thead>
              <tr>
                <th scope="col">{t('accounts.importColumns.row')}</th>
                <th scope="col">{t('accounts.columns.name')}</th>
                <th scope="col">{t('accounts.importColumns.link')}</th>
              </tr>
            </thead>
            <tbody>
              {state.invites.map((i) => (
                <tr key={i.row}>
                  <td data-label={t('accounts.importColumns.row')}>{i.row}</td>
                  <th scope="row" data-label={t('accounts.columns.name')}>
                    {i.account.displayName}
                  </th>
                  <td data-label={t('accounts.importColumns.link')}>
                    <input
                      readOnly
                      aria-label={t('operators.inviteLinkFor', { name: i.account.displayName })}
                      value={inviteLink(i.invitePath)}
                      onFocus={(e) => e.target.select()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.dialogActions}>
            <Button
              icon={<Copy size={16} aria-hidden />}
              onClick={() => {
                const text = state.invites
                  .map((i) => `${i.account.displayName}\t${inviteLink(i.invitePath)}`)
                  .join('\n');
                void navigator.clipboard?.writeText(text).then(() => setCopied(true));
              }}
            >
              {copied ? t('operators.copied') : t('accounts.copyAll')}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t('operators.close')}
            </Button>
          </div>
        </div>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate>
          <p className={styles.hint}>
            {t('accounts.importHint', { max: ACCOUNT_IMPORT_MAX_ROWS })}
          </p>
          <a href={TEMPLATE_HREF} download="account-import-template.csv">
            <Download size={16} aria-hidden /> {t('accounts.template')}
          </a>
          <div className={styles.field}>
            <label htmlFor={`${id}-file`}>{t('accounts.file')}</label>
            <input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setState({ status: 'idle' });
              }}
            />
          </div>
          {state.status === 'file_error' && (
            <p className={styles.error} role="alert">
              {t(`accounts.fileErrors.${state.error}`, { max: ACCOUNT_IMPORT_MAX_ROWS })}
            </p>
          )}
          {state.status === 'failed' && (
            <p className={styles.error} role="alert">
              {t(`accounts.errors.${state.error}`)}
            </p>
          )}
          {state.status === 'rejected' && (
            <div className={styles.error} role="alert">
              <p>{t('accounts.importRejected')}</p>
              {state.detail.needed > state.detail.seatsLeft && (
                <p>
                  {t('accounts.importSeats', {
                    needed: state.detail.needed,
                    left: Math.max(0, state.detail.seatsLeft),
                  })}
                </p>
              )}
              {state.detail.rowErrors.length > 0 && (
                <ul>
                  {state.detail.rowErrors.map((e) => (
                    <li key={e.row}>
                      {t('accounts.rowError', {
                        row: e.row,
                        reason: t(`accounts.rowErrors.${e.code}`),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className={styles.dialogActions}>
            <Button onClick={onClose}>{t('operators.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!file || saving}>
              {saving ? t('accounts.importing') : t('accounts.importSubmit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
