import {
  TWIN_REASON_MAX,
  TWIN_REASON_MIN,
  type TwinDomainView,
  type TwinLevel,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, forwardRef, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearTwinStatus, setTwinStatus } from '../api/twin';
import { displayDate, twinErrorKey, type TwinErrorKey } from './errors';
import { useBasisText } from './format';
import { LEVEL_MARKERS, LevelBadge } from './levels';
import styles from './Twin.module.css';

const ADJUSTABLE: readonly Exclude<TwinLevel, 'unknown'>[] = ['red', 'yellow', 'green'];

export interface StatusCardProps {
  clientId: string;
  view: TwinDomainView;
  /** 手动调整、取消调整后这个方面的最新状态 */
  onChanged: (view: TwinDomainView) => void;
  /** 点依据：切到档案查看对应的报告或监测数据 */
  onOpenRecord: () => void;
}

/**
 * 一个方面的状态卡片（规格 2.3）：状态（文字 + 图形标记）、依据、来源标记、和上次相比、
 * 调整状态。系统计算和手动调整同时显示。
 * “请专家看看”在第 4 步（专家预览）里加。
 */
export const StatusCard = forwardRef<HTMLElement, StatusCardProps>(function StatusCard(
  { clientId, view, onChanged, onOpenRecord },
  ref,
) {
  const { t } = useTranslation();
  const basisText = useBasisText();
  const titleId = useId();
  const [adjusting, setAdjusting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TwinErrorKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const domainName = t(`twin.domains.${view.domain}`);
  const levelName = (l: TwinLevel) => t(`twin.levels.${l}`);
  const colorName = (l: TwinLevel) => t(`twin.colors.${l}`);
  const basis = view.computed?.basis ?? view.manual?.basis ?? [];

  const cancelAdjust = () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    clearTwinStatus(clientId, view.domain)
      .then((next) => {
        setNotice(t('twin.card.cancelled'));
        onChanged(next);
      })
      .catch((err: unknown) => setError(twinErrorKey(err)))
      .finally(() => setBusy(false));
  };

  return (
    <article
      ref={ref}
      id={`hb-twin-card-${view.domain}`}
      tabIndex={-1}
      className={styles.card}
      data-level={view.level}
      aria-labelledby={titleId}
    >
      <header className={styles.cardHeader}>
        <h5 id={titleId} className={styles.cardTitle}>
          {domainName}
        </h5>
        <LevelBadge level={view.level} />
      </header>

      {view.manual && view.computed && (
        <p className={styles.cardLine}>
          {t('twin.card.both', {
            computed: levelName(view.computed.level),
            manual: levelName(view.manual.level),
          })}
        </p>
      )}

      {view.previousLevel && view.changedAt && (
        <p className={styles.cardLine}>
          {t('twin.card.changed', {
            from: colorName(view.previousLevel),
            to: colorName(view.computed?.level ?? view.level),
            date: displayDate(view.changedAt),
          })}
        </p>
      )}

      <div className={styles.basis}>
        <h6 className={styles.basisTitle}>{t('twin.card.basis')}</h6>
        {basis.length === 0 ? (
          <p className={styles.muted}>{t('twin.card.noBasis')}</p>
        ) : (
          <ul className={styles.basisList}>
            {basis.map((b) => (
              <li key={`${b.source}:${b.metric}`} data-outcome={b.outcome}>
                <span className={styles.marker} aria-hidden>
                  {LEVEL_MARKERS[b.outcome]}
                </span>{' '}
                {basisText(b)}{' '}
                <button type="button" className={styles.linkButton} onClick={onOpenRecord}>
                  {t('twin.card.openRecord')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className={styles.source}>
        {view.computed
          ? t('twin.card.computed', {
              version: view.computed.rulesVersion,
              date: displayDate(view.computed.createdAt),
            })
          : t('twin.card.notComputed')}
      </p>
      {view.manual && (
        <p className={styles.source} data-origin="manual">
          {view.manual.setByName
            ? t('twin.card.manualBy', {
                name: view.manual.setByName,
                reason: view.manual.reason ?? '',
              })
            : t('twin.card.manualByOther', { reason: view.manual.reason ?? '' })}
        </p>
      )}
      {view.manualExpiredByNewData && <p className={styles.source}>{t('twin.card.expired')}</p>}

      {adjusting ? (
        <AdjustForm
          clientId={clientId}
          view={view}
          onCancel={() => setAdjusting(false)}
          onSaved={(next) => {
            setAdjusting(false);
            setNotice(t('twin.adjust.saved'));
            onChanged(next);
          }}
        />
      ) : (
        <div className={styles.cardActions}>
          <Button
            onClick={() => {
              setNotice(null);
              setAdjusting(true);
            }}
            aria-label={t('twin.card.adjustLabel', { domain: domainName })}
          >
            {t('twin.card.adjust')}
          </Button>
          {view.manual && (
            <Button
              variant="ghost"
              onClick={cancelAdjust}
              disabled={busy}
              aria-label={t('twin.card.cancelAdjustLabel', { domain: domainName })}
            >
              {t('twin.card.cancelAdjust')}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p className={styles.muted} role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {t(`twin.errors.${error}`)}
        </p>
      )}
    </article>
  );
});

/** 手动调整（Q4）：理由必填，不少于 5 个字（前端也拦，后端同样校验） */
function AdjustForm({
  clientId,
  view,
  onCancel,
  onSaved,
}: {
  clientId: string;
  view: TwinDomainView;
  onCancel: () => void;
  onSaved: (view: TwinDomainView) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const current = view.level === 'unknown' ? null : view.level;
  const [level, setLevel] = useState<Exclude<TwinLevel, 'unknown'> | null>(current);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TwinErrorKey | null>(null);

  const trimmed = reason.trim();
  const reasonError =
    trimmed.length < TWIN_REASON_MIN
      ? t('twin.adjust.reasonTooShort', { min: TWIN_REASON_MIN })
      : trimmed.length > TWIN_REASON_MAX
        ? t('twin.adjust.reasonTooLong', { max: TWIN_REASON_MAX })
        : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (reasonError || level === null) return;
    setBusy(true);
    setError(null);
    setTwinStatus(clientId, {
      domain: view.domain,
      level,
      reason: trimmed,
      expires: 'next_data',
    })
      .then(onSaved)
      .catch((err: unknown) => setError(twinErrorKey(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{t('twin.adjust.level')}</legend>
        <div className={styles.choices}>
          {ADJUSTABLE.map((l) => (
            <label key={l} className={styles.choice} data-level={l}>
              <input
                type="radio"
                name={`${id}-level`}
                value={l}
                checked={level === l}
                onChange={() => setLevel(l)}
              />
              <span className={styles.marker} aria-hidden>
                {LEVEL_MARKERS[l]}
              </span>
              {t(`twin.levels.${l}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={styles.label} htmlFor={`${id}-reason`}>
        {t('twin.adjust.reason', { min: TWIN_REASON_MIN })}
      </label>
      <textarea
        id={`${id}-reason`}
        className={styles.textarea}
        value={reason}
        maxLength={TWIN_REASON_MAX}
        placeholder={t('twin.adjust.reasonPlaceholder')}
        aria-invalid={touched && reasonError !== null ? true : undefined}
        aria-describedby={touched && reasonError ? `${id}-reason-error` : `${id}-note`}
        onChange={(e) => setReason(e.target.value)}
      />
      {touched && reasonError && (
        <p id={`${id}-reason-error`} className={styles.error} role="alert">
          {reasonError}
        </p>
      )}
      <p id={`${id}-note`} className={styles.muted}>
        {t('twin.adjust.note')}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {t(`twin.errors.${error}`)}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy || level === null}>
          {busy ? t('twin.adjust.saving') : t('twin.adjust.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('twin.adjust.cancel')}
        </Button>
      </div>
    </form>
  );
}
