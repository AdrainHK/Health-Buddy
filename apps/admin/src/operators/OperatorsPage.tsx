import {
  INVITE_TTL_HOURS,
  SUSPEND_REASON_MIN,
  createOperatorRequestSchema,
  inviteAccountRequestSchema,
  updateOperatorRequestSchema,
  type AccountSummary,
  type InviteResponse,
  type OperatorSummary,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Copy, Info, Plus } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createOperator,
  inviteLink,
  inviteOperatorAdmin,
  listOperatorAccounts,
  listOperators,
  reinviteAccount,
  setAccountSuspended,
  setOperatorSuspended,
  updateOperator,
} from '../api/accounts';
import { ApiError } from '../api/http';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';

type State =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; operators: OperatorSummary[] };

type ErrorKey = 'duplicate' | 'bad_request' | 'not_found' | 'network' | 'unknown';

function errorKey(err: unknown): ErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'conflict') return 'duplicate';
  if (err.code === 'bad_request') return 'bad_request';
  if (err.code === 'not_found') return 'not_found';
  if (err.code === 'network') return 'network';
  return 'unknown';
}

/** 区域输入：逗号或空格分隔的省市代码 */
function parseRegion(text: string): string[] {
  return text
    .split(/[\s,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 运营商（协会）开通和管理（M7 规格 2.1、2.4）。只有平台管理员：开通协会、改席位和合同、
 * 停用和恢复、开通协会的运营商管理员。邀请链接只显示一次，由平台复制后线下发给本人（Q3）。
 */
export function OperatorsPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listOperators()
      .then((operators) => !cancelled && setState({ status: 'ready', operators }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const open = state.status === 'ready' ? state.operators.find((o) => o.id === openId) : undefined;

  return (
    <section className={styles.page} aria-labelledby="operators-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('operators.disclaimer')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="operators-title" className={styles.title}>
            {t('operators.title')}
          </h1>
          <p className={styles.subtitle}>{t('operators.subtitle')}</p>
        </div>
        <div className={styles.toolbar}>
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden />}
            onClick={() => {
              setNotice(null);
              setCreating(true);
            }}
          >
            {t('operators.create')}
          </Button>
        </div>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('operators.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('operators.loadFailed')}</span>
          <Button onClick={reload}>{t('operators.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.operators.length === 0 ? (
          <p className={styles.muted}>{t('operators.empty')}</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('operators.columns.name')}</th>
                <th scope="col">{t('operators.columns.status')}</th>
                <th scope="col">{t('operators.columns.seats')}</th>
                <th scope="col">{t('operators.columns.contractEnd')}</th>
                <th scope="col">{t('operators.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {state.operators.map((o) => (
                <tr
                  key={o.id}
                  className={o.status === 'suspended' ? styles.disabledRow : undefined}
                >
                  <th scope="row" data-label={t('operators.columns.name')}>
                    {o.name}
                  </th>
                  <td data-label={t('operators.columns.status')}>
                    {t(`operators.status.${o.status}`)}
                  </td>
                  <td data-label={t('operators.columns.seats')}>
                    {t('operators.seats', { used: o.seatsUsed, limit: o.seatLimit })}
                  </td>
                  <td data-label={t('operators.columns.contractEnd')}>
                    {o.contractEnd ?? t('operators.noContract')}
                    {o.expired ? (
                      <span className={styles.hint}> {t('operators.expired')}</span>
                    ) : o.expiringSoon ? (
                      <span className={styles.hint}> {t('operators.expiringSoon')}</span>
                    ) : null}
                  </td>
                  <td data-label={t('operators.columns.actions')}>
                    <Button
                      variant="ghost"
                      aria-label={t('operators.manageLabel', { name: o.name })}
                      onClick={() => setOpenId(o.id)}
                    >
                      {t('operators.manage')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(o) => {
            setCreating(false);
            setNotice(t('operators.created', { name: o.name }));
            reload();
            setOpenId(o.id);
          }}
        />
      )}
      {open && <DetailDialog operator={open} onClose={() => setOpenId(null)} onChanged={reload} />}
    </section>
  );
}

interface OperatorFormValues {
  name: string;
  slug: string;
  region: string;
  seatLimit: string;
  contractStart: string;
  contractEnd: string;
}

function OperatorFields({
  values,
  onChange,
  slugLocked,
}: {
  values: OperatorFormValues;
  onChange: (v: OperatorFormValues) => void;
  slugLocked: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const field = (key: keyof OperatorFormValues, type = 'text', hint?: string) => (
    <div className={styles.field}>
      <label htmlFor={`${id}-${key}`}>{t(`operators.form.${key}`)}</label>
      <input
        id={`${id}-${key}`}
        type={type}
        value={values[key]}
        disabled={key === 'slug' && slugLocked}
        aria-describedby={hint ? `${id}-${key}-hint` : undefined}
        onChange={(e) => onChange({ ...values, [key]: e.target.value })}
      />
      {hint && (
        <small id={`${id}-${key}-hint`} className={styles.hint}>
          {hint}
        </small>
      )}
    </div>
  );
  return (
    <>
      {field('name')}
      {field('slug', 'text', t('operators.form.slugHint'))}
      {field('region', 'text', t('operators.form.regionHint'))}
      {field('seatLimit', 'number')}
      <div className={styles.fieldRow}>
        {field('contractStart', 'date')}
        {field('contractEnd', 'date')}
      </div>
    </>
  );
}

function toRequest(v: OperatorFormValues) {
  return {
    name: v.name,
    region: parseRegion(v.region),
    seatLimit: v.seatLimit.trim() === '' ? Number.NaN : Number(v.seatLimit),
    contractStart: v.contractStart || null,
    contractEnd: v.contractEnd || null,
  };
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (o: OperatorSummary) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<OperatorFormValues>({
    name: '',
    slug: '',
    region: '',
    seatLimit: '10',
    contractStart: '',
    contractEnd: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = createOperatorRequestSchema.safeParse({
      ...toRequest(values),
      slug: values.slug,
    });
    if (!parsed.success) {
      setError(t('operators.errors.bad_request'));
      return;
    }
    setBusy(true);
    setError(null);
    createOperator(parsed.data)
      .then(onCreated)
      .catch((err: unknown) => {
        setError(t(`operators.errors.${errorKey(err)}`));
        setBusy(false);
      });
  };
  return (
    <Dialog title={t('operators.create')} onClose={onClose}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <OperatorFields values={values} onChange={setValues} slugLocked={false} />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={onClose} disabled={busy}>
            {t('operators.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t('operators.saving') : t('operators.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DetailDialog({
  operator,
  onClose,
  onChanged,
}: {
  operator: OperatorSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState<OperatorFormValues>({
    name: operator.name,
    slug: operator.slug,
    region: operator.region.join(', '),
    seatLimit: String(operator.seatLimit),
    contractStart: operator.contractStart ?? '',
    contractEnd: operator.contractEnd ?? '',
  });
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [reason, setReason] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [invite, setInvite] = useState<InviteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listOperatorAccounts(operator.id)
      .then((a) => !cancelled && setAccounts(a))
      .catch(() => !cancelled && setAccounts([]));
    return () => {
      cancelled = true;
    };
  }, [operator.id, invite]);

  const run = (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    fn()
      .then(() => {
        setMessage(done);
        onChanged();
      })
      .catch((err: unknown) => setError(t(`operators.errors.${errorKey(err)}`)))
      .finally(() => setBusy(false));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const parsed = updateOperatorRequestSchema.safeParse(toRequest(values));
    if (!parsed.success) {
      setError(t('operators.errors.bad_request'));
      return;
    }
    run(() => updateOperator(operator.id, parsed.data), t('operators.saved'));
  };

  const inviteAdmin = (e: FormEvent) => {
    e.preventDefault();
    const parsed = inviteAccountRequestSchema.safeParse({
      displayName: adminName,
      email: adminEmail.trim(),
      role: 'operator_admin',
    });
    if (!parsed.success) {
      setError(t('operators.errors.bad_request'));
      return;
    }
    run(async () => {
      setInvite(await inviteOperatorAdmin(operator.id, parsed.data));
      setAdminName('');
      setAdminEmail('');
    }, t('operators.invited'));
  };

  return (
    <Dialog title={t('operators.detailTitle', { name: operator.name })} onClose={onClose} wide>
      <form className={styles.form} onSubmit={save} noValidate>
        <OperatorFields values={values} onChange={setValues} slugLocked />
        <div className={styles.dialogActions}>
          <Button type="submit" disabled={busy}>
            {t('operators.save')}
          </Button>
        </div>
      </form>

      <h3 className={styles.dialogTitle}>{t('operators.statusTitle')}</h3>
      {operator.status === 'active' ? (
        <div className={styles.form}>
          <div className={styles.field}>
            <label htmlFor={`${id}-reason`}>{t('operators.suspendReason')}</label>
            <input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
            <small className={styles.hint}>
              {t('operators.suspendHint', { min: SUSPEND_REASON_MIN })}
            </small>
          </div>
          <div className={styles.dialogActions}>
            <Button
              disabled={busy || reason.trim().length < SUSPEND_REASON_MIN}
              onClick={() =>
                run(
                  () => setOperatorSuspended(operator.id, true, reason.trim()),
                  t('operators.suspended'),
                )
              }
            >
              {t('operators.suspend')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.dialogActions}>
          <span className={styles.muted}>
            {t('operators.suspendedBecause', { reason: operator.suspendedReason ?? '' })}
          </span>
          <Button
            disabled={busy}
            onClick={() =>
              run(() => setOperatorSuspended(operator.id, false), t('operators.resumed'))
            }
          >
            {t('operators.resume')}
          </Button>
        </div>
      )}

      <h3 className={styles.dialogTitle}>{t('operators.accountsTitle')}</h3>
      {accounts === null ? (
        <p className={styles.muted}>{t('operators.loading')}</p>
      ) : accounts.length === 0 ? (
        <p className={styles.muted}>{t('operators.noAccounts')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('operators.accountColumns.name')}</th>
              <th scope="col">{t('operators.accountColumns.role')}</th>
              <th scope="col">{t('operators.accountColumns.status')}</th>
              <th scope="col">{t('operators.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className={a.status === 'disabled' ? styles.disabledRow : undefined}>
                <th scope="row" data-label={t('operators.accountColumns.name')}>
                  {a.displayName}
                </th>
                <td data-label={t('operators.accountColumns.role')}>
                  {t(`shell.roles.${a.role}`)}
                </td>
                <td data-label={t('operators.accountColumns.status')}>
                  {t(`operators.accountStatus.${a.status}`)}
                </td>
                <td data-label={t('operators.columns.actions')}>
                  <div className={styles.rowActions}>
                    {a.status !== 'disabled' && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        aria-label={t('operators.reinviteLabel', { name: a.displayName })}
                        onClick={() => {
                          // 重发会让已激活的账号原密码失效、退出登录（合规审查 S1）
                          if (
                            a.status === 'active' &&
                            !window.confirm(t('operators.confirmReinvite', { name: a.displayName }))
                          )
                            return;
                          run(
                            async () => setInvite(await reinviteAccount(a.id)),
                            t('operators.invited'),
                          );
                        }}
                      >
                        {t('operators.reinvite')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={t(
                        a.status === 'disabled'
                          ? 'operators.enableLabel'
                          : 'operators.disableLabel',
                        { name: a.displayName },
                      )}
                      onClick={() => {
                        if (
                          a.status !== 'disabled' &&
                          !window.confirm(t('operators.confirmDisable', { name: a.displayName }))
                        )
                          return;
                        run(async () => {
                          await setAccountSuspended(a.id, a.status !== 'disabled');
                          setAccounts(await listOperatorAccounts(operator.id));
                        }, t('operators.saved'));
                      }}
                    >
                      {a.status === 'disabled' ? t('operators.enable') : t('operators.disable')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className={styles.form} onSubmit={inviteAdmin} noValidate>
        <h3 className={styles.dialogTitle}>{t('operators.inviteTitle')}</h3>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor={`${id}-admin-name`}>{t('operators.form.adminName')}</label>
            <input
              id={`${id}-admin-name`}
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-admin-email`}>{t('operators.form.adminEmail')}</label>
            <input
              id={`${id}-admin-email`}
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
            />
          </div>
        </div>
        <div className={styles.dialogActions}>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('operators.invite')}
          </Button>
        </div>
      </form>

      {invite && <InviteLink invite={invite} />}
      {message && (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.dialogActions}>
        <Button onClick={onClose}>{t('operators.close')}</Button>
      </div>
    </Dialog>
  );
}

/** 一次性邀请链接：只显示这一次，关闭后不能再查看（Q3） */
function InviteLink({ invite }: { invite: InviteResponse }) {
  const { t } = useTranslation();
  const id = useId();
  const link = inviteLink(invite.invitePath);
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.field} data-testid="invite-link">
      <label htmlFor={`${id}-link`}>
        {t('operators.inviteLinkFor', { name: invite.account.displayName })}
      </label>
      <input id={`${id}-link`} readOnly value={link} onFocus={(e) => e.target.select()} />
      <small className={styles.hint}>
        {t('operators.inviteLinkHint', { hours: INVITE_TTL_HOURS })}
      </small>
      <div className={styles.dialogActions}>
        <Button
          icon={<Copy size={16} aria-hidden />}
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? t('operators.copied') : t('operators.copy')}
        </Button>
      </div>
    </div>
  );
}
