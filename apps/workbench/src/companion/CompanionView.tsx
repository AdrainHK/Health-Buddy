import {
  COMPANION_NAME_FOR_CLIENT_MAX,
  COMPANION_VOICE_SPEEDS,
  COMPANION_VOLUMES,
  type ClientSummary,
  type CompanionOverview,
  type CompanionScript,
  type CompanionSettings,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import type { TFunction } from 'i18next';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  bindCompanionDevice,
  getCompanion,
  getCompanionNotice,
  recordCompanionConsent,
  revokeCompanionConsent,
  setCompanionPaused,
  unbindCompanionDevice,
  updateCompanionSettings,
} from '../api/companion';
import { ApiError, isAbortError } from '../api/http';
import { localToday } from '../care/dates';
import { displayDateTime } from '../twin/errors';
import styles from '../twin/Twin.module.css';
import care from './Companion.module.css';

/**
 * 结果区“客户 · 伴侣”（M6 规格 2.1、2.8）：伴侣“福宝”的设备、线下告知和同意、伴侣设置。
 * 只给服务这位客户的健管师。打卡、预警、转交、收集信息在后续步骤加进这个视图。
 */
export function CompanionView({ client }: { client: ClientSummary }) {
  const { t } = useTranslation();
  const clientId = client.id;
  const [data, setData] = useState<{ clientId: string; overview: CompanionOverview } | null>(null);
  const [notice, setNotice] = useState<CompanionScript | null>(null);
  const [error, setError] = useState<'notFound' | 'failed' | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([
      getCompanion(clientId, controller.signal),
      getCompanionNotice(controller.signal).catch((err: unknown) => {
        if (isAbortError(err)) throw err;
        return null;
      }),
    ])
      .then(([overview, n]) => {
        setData({ clientId, overview });
        setNotice(n);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(err instanceof ApiError && err.status === 404 ? 'notFound' : 'failed');
      });
    return () => controller.abort();
  }, [clientId, version]);

  const shown = data?.clientId === clientId ? data.overview : null;
  const update = (o: CompanionOverview) => setData({ clientId, overview: o });

  if (!shown) {
    return (
      <div className={styles.twin}>
        {error ? (
          <div className={styles.section} role="alert">
            <p className={styles.error}>
              {error === 'notFound' ? t('companion.notFound') : t('companion.loadFailed')}
            </p>
            <div>
              <Button onClick={reload}>{t('companion.retry')}</Button>
            </div>
          </div>
        ) : (
          <p className={styles.muted} role="status">
            {t('companion.loading')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.twin}>
      <div className={styles.banner} role="note">
        <span>{t('companion.banner')}</span>
      </div>
      <Section title={t('companion.device.title')}>
        <DeviceSection clientId={clientId} overview={shown} onChanged={update} />
      </Section>
      <Section title={t('companion.consent.title')}>
        <ConsentSection clientId={clientId} overview={shown} notice={notice} onChanged={update} />
      </Section>
      <Section title={t('companion.settings.title')}>
        <SettingsForm
          key={`${clientId}:${JSON.stringify(shown.settings)}`}
          clientId={clientId}
          settings={shown.settings}
          onSaved={update}
        />
      </Section>
    </div>
  );
}

/** 409 的原因（如 device_unavailable）对应 companion.errors.* 文案；其他按状态码 */
const CONFLICT_REASONS = [
  'device_unavailable',
  'already_bound',
  'no_consent',
  'not_consented',
  'no_device',
  'invalid_state',
] as const;
type ConflictReason = (typeof CONFLICT_REASONS)[number];

function errorText(t: TFunction, err: unknown): string {
  if (err instanceof ApiError) {
    const reason = err.reasons.find((r): r is ConflictReason =>
      (CONFLICT_REASONS as readonly string[]).includes(r),
    );
    if (err.status === 409 && reason) return t(`companion.errors.${reason}`);
    if (err.code === 'network') return t('companion.errors.network');
    if (err.status === 400) return t('companion.errors.badRequest');
    if (err.status === 404) return t('companion.errors.notFound');
    if (err.status === 429) return t('companion.errors.tooMany');
  }
  return t('companion.errors.unknown');
}

function DeviceSection({
  clientId,
  overview,
  onChanged,
}: {
  clientId: string;
  overview: CompanionOverview;
  onChanged: (o: CompanionOverview) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const device = overview.device;

  const run = (action: () => Promise<CompanionOverview>) => {
    setBusy(true);
    setError(null);
    action()
      .then((o) => {
        setConfirmUnbind(false);
        onChanged(o);
      })
      .catch((err: unknown) => setError(errorText(t, err)))
      .finally(() => setBusy(false));
  };

  if (!device) {
    return (
      <BindForm
        clientId={clientId}
        canBind={Boolean(overview.consent && !overview.consent.revokedOn)}
        onBound={onChanged}
      />
    );
  }

  return (
    <>
      <dl className={care.facts}>
        <dt>{t('companion.device.status')}</dt>
        <dd>
          <strong>{t(`companion.status.${overview.status}`)}</strong>
        </dd>
        <dt>{t('companion.device.serial')}</dt>
        <dd>{t('companion.device.serialLast4', { last4: device.serialLast4 })}</dd>
        <dt>{t('companion.device.online')}</dt>
        <dd>
          {device.online
            ? t('companion.device.onlineNow')
            : device.lastSeenAt
              ? t('companion.device.lastSeen', { time: displayDateTime(device.lastSeenAt) })
              : t('companion.device.neverSeen')}
        </dd>
        <dt>{t('companion.device.boundAt')}</dt>
        <dd>{displayDateTime(device.boundAt)}</dd>
        {device.firmwareVersion && (
          <>
            <dt>{t('companion.device.firmware')}</dt>
            <dd>{device.firmwareVersion}</dd>
          </>
        )}
      </dl>
      {overview.status === 'pending_activation' && (
        <p className={styles.muted}>{t('companion.device.pendingHint')}</p>
      )}
      {overview.status === 'revoked' && (
        <p className={styles.muted}>{t('companion.device.revokedHint')}</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        {(overview.status === 'active' || overview.status === 'pending_activation') && (
          <Button disabled={busy} onClick={() => run(() => setCompanionPaused(clientId, true))}>
            {t('companion.device.pause')}
          </Button>
        )}
        {overview.status === 'paused' && (
          <Button disabled={busy} onClick={() => run(() => setCompanionPaused(clientId, false))}>
            {t('companion.device.resume')}
          </Button>
        )}
        {confirmUnbind ? (
          <>
            <span className={styles.muted}>{t('companion.device.unbindConfirm')}</span>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => run(() => unbindCompanionDevice(clientId))}
            >
              {t('companion.device.unbindYes')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmUnbind(false)}>
              {t('companion.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmUnbind(true)}>
            {t('companion.device.unbind')}
          </Button>
        )}
      </div>
    </>
  );
}

function BindForm({
  clientId,
  canBind,
  onBound,
}: {
  clientId: string;
  canBind: boolean;
  onBound: (o: CompanionOverview) => void;
}) {
  const { t } = useTranslation();
  const [serialNo, setSerialNo] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!serialNo.trim() || !activationCode.trim()) {
      setError(t('companion.bind.required'));
      return;
    }
    setBusy(true);
    setError(null);
    bindCompanionDevice(clientId, { serialNo: serialNo.trim(), activationCode })
      .then((o) => {
        setActivationCode('');
        onBound(o);
      })
      .catch((err: unknown) => setError(errorText(t, err)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <p className={styles.muted}>{t('companion.bind.none')}</p>
      {!canBind ? (
        <p className={styles.muted}>{t('companion.bind.needConsent')}</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={submit}
          noValidate
          aria-label={t('companion.bind.title')}
        >
          <div className={care.formRow}>
            <label className={styles.label}>
              {t('companion.bind.serial')}
              <input
                className={styles.input}
                value={serialNo}
                autoComplete="off"
                maxLength={64}
                onChange={(e) => setSerialNo(e.target.value)}
              />
            </label>
            <label className={styles.label}>
              {t('companion.bind.code')}
              <input
                className={styles.input}
                value={activationCode}
                autoComplete="off"
                maxLength={40}
                onChange={(e) => setActivationCode(e.target.value)}
              />
            </label>
          </div>
          <p className={styles.muted}>{t('companion.bind.hint')}</p>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.cardActions}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t('companion.bind.binding') : t('companion.bind.submit')}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

function ConsentSection({
  clientId,
  overview,
  notice,
  onChanged,
}: {
  clientId: string;
  overview: CompanionOverview;
  notice: CompanionScript | null;
  onChanged: (o: CompanionOverview) => void;
}) {
  const { t } = useTranslation();
  const today = localToday();
  const [date, setDate] = useState(today);
  const [confirmed, setConfirmed] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consent = overview.consent;
  const active = Boolean(consent && !consent.revokedOn);
  const outdated =
    active && notice !== null && consent !== null && consent.noticeVersion < notice.version;

  const run = (action: () => Promise<CompanionOverview>) => {
    setBusy(true);
    setError(null);
    action()
      .then((o) => {
        setConfirmed(false);
        setRevoking(false);
        setDate(today);
        onChanged(o);
      })
      .catch((err: unknown) => setError(errorText(t, err)))
      .finally(() => setBusy(false));
  };

  const record = (e: FormEvent) => {
    e.preventDefault();
    if (!notice || !confirmed || !date || date > today) {
      setError(t('companion.consent.incomplete'));
      return;
    }
    run(() =>
      recordCompanionConsent(clientId, {
        noticeVersion: notice.version,
        consentedOn: date,
        confirmed: true,
      }),
    );
  };

  return (
    <>
      {consent ? (
        <dl className={care.facts}>
          <dt>{t('companion.consent.state')}</dt>
          <dd>
            <strong>
              {consent.revokedOn
                ? t('companion.consent.revokedOn', { date: consent.revokedOn })
                : t('companion.consent.active')}
            </strong>
          </dd>
          <dt>{t('companion.consent.version')}</dt>
          <dd>{t('companion.consent.versionValue', { version: consent.noticeVersion })}</dd>
          <dt>{t('companion.consent.date')}</dt>
          <dd>{consent.consentedOn}</dd>
        </dl>
      ) : (
        <p className={styles.muted}>{t('companion.consent.none')}</p>
      )}
      {outdated && <p className={styles.muted}>{t('companion.consent.outdated')}</p>}

      {notice ? (
        <details>
          <summary>{t('companion.consent.noticeTitle', { version: notice.version })}</summary>
          <p className={care.noticeText}>{notice.text}</p>
        </details>
      ) : (
        <p className={styles.muted}>{t('companion.consent.noNotice')}</p>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {notice && (!active || outdated) && (
        <form className={styles.form} onSubmit={record} noValidate>
          <label className={care.checkRow}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t('companion.consent.confirm', { version: notice.version })}
          </label>
          <label className={styles.label}>
            {t('companion.consent.dateLabel')}
            <input
              type="date"
              className={styles.input}
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <div className={styles.cardActions}>
            <Button type="submit" variant="primary" disabled={busy || !confirmed}>
              {t('companion.consent.record')}
            </Button>
          </div>
        </form>
      )}

      {active &&
        (revoking ? (
          <div className={styles.form}>
            <p className={styles.muted}>{t('companion.consent.revokeHint')}</p>
            <label className={styles.label}>
              {t('companion.consent.revokeDate')}
              <input
                type="date"
                className={styles.input}
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <div className={styles.cardActions}>
              <Button
                variant="primary"
                disabled={busy || !date}
                onClick={() => run(() => revokeCompanionConsent(clientId, date))}
              >
                {t('companion.consent.revokeYes')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRevoking(false)}>
                {t('companion.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.cardActions}>
            <Button variant="ghost" onClick={() => setRevoking(true)}>
              {t('companion.consent.revoke')}
            </Button>
          </div>
        ))}
    </>
  );
}

function SettingsForm({
  clientId,
  settings,
  onSaved,
}: {
  clientId: string;
  settings: CompanionSettings;
  onSaved: (o: CompanionOverview) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(settings.nameForClient ?? '');
  const [voiceSpeed, setVoiceSpeed] = useState(settings.voiceSpeed);
  const [volume, setVolume] = useState(settings.volume);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const dirty =
    trimmed !== (settings.nameForClient ?? '') ||
    voiceSpeed !== settings.voiceSpeed ||
    volume !== settings.volume;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    updateCompanionSettings(clientId, {
      nameForClient: trimmed || null,
      voiceSpeed,
      volume,
    })
      .then(onSaved)
      .catch((err: unknown) => setError(errorText(t, err)))
      .finally(() => setBusy(false));
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <label className={styles.label}>
        {t('companion.settings.name', { max: COMPANION_NAME_FOR_CLIENT_MAX })}
        <input
          className={styles.input}
          value={name}
          maxLength={COMPANION_NAME_FOR_CLIENT_MAX}
          placeholder={t('companion.settings.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p className={styles.muted}>{t('companion.settings.nameHint')}</p>
      <div className={care.formRow}>
        <label className={styles.label}>
          {t('companion.settings.voiceSpeed')}
          <select
            className={styles.select}
            value={voiceSpeed}
            onChange={(e) => setVoiceSpeed(e.target.value as CompanionSettings['voiceSpeed'])}
          >
            {COMPANION_VOICE_SPEEDS.map((v) => (
              <option key={v} value={v}>
                {t(`companion.settings.speeds.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.label}>
          {t('companion.settings.volume')}
          <select
            className={styles.select}
            value={volume}
            onChange={(e) => setVolume(e.target.value as CompanionSettings['volume'])}
          >
            {COMPANION_VOLUMES.map((v) => (
              <option key={v} value={v}>
                {t(`companion.settings.volumes.${v}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy || !dirty}>
          {t('companion.settings.save')}
        </Button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <h5 id={id} className={styles.sectionTitle}>
          {title}
        </h5>
      </div>
      {children}
    </section>
  );
}
