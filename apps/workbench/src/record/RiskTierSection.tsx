import {
  RISK_TIER_REASON_MAX,
  RISK_TIERS,
  type RiskTier,
  type RiskTierRecord,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listRiskTiers, setRiskTier } from '../api/clients';
import styles from './ClientRecord.module.css';
import { displayDate, recordErrorKey, type RecordErrorKey } from './errors';

export interface RiskTierSectionProps {
  clientId: string;
  current: RiskTierRecord | null;
  readOnly: boolean;
  onChanged: () => void;
}

/**
 * 风险分层（规格 2.7）：当前分层、设定人、日期和理由；健管师手动调整时理由必填。
 * 分层只给健管师看（Q20），不进任何面向客户的内容。
 */
export function RiskTierSection({ clientId, current, readOnly, onChanged }: RiskTierSectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<RiskTierRecord[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState<RecordErrorKey | null>(null);

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!next) return;
    setHistory(null);
    setHistoryError(null);
    listRiskTiers(clientId)
      .then(setHistory)
      .catch((err: unknown) => setHistoryError(recordErrorKey(err)));
  };

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.sectionHeader}>
        <h4 id={`${id}-title`} className={styles.sectionTitle}>
          {t('record.sections.riskTier')}
        </h4>
        {!readOnly && !editing && (
          <Button onClick={() => setEditing(true)}>
            {current ? t('record.tier.set') : t('record.tier.setFirst')}
          </Button>
        )}
      </div>
      {current ? <TierSummary record={current} /> : <TierBadge tier={null} />}
      {editing && (
        <TierForm
          clientId={clientId}
          initial={current?.tier ?? null}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setHistoryOpen(false);
            onChanged();
          }}
        />
      )}
      <p className={styles.note}>{t('record.tier.note')}</p>
      {current && (
        <div>
          <Button variant="ghost" aria-expanded={historyOpen} onClick={toggleHistory}>
            {historyOpen ? t('record.tier.hideHistory') : t('record.tier.showHistory')}
          </Button>
          {historyOpen && <TierHistory records={history} error={historyError} />}
        </div>
      )}
    </section>
  );
}

function TierBadge({ tier }: { tier: RiskTier | null }) {
  const { t } = useTranslation();
  return (
    <span className={styles.tier} data-tier={tier ?? 'none'}>
      {tier ? t(`record.tier.levels.${tier}`) : t('record.tier.none')}
    </span>
  );
}

function TierSummary({ record }: { record: RiskTierRecord }) {
  const { t } = useTranslation();
  const date = displayDate(record.setAt);
  return (
    <div className={styles.itemMain}>
      <TierBadge tier={record.tier} />{' '}
      <span className={styles.meta}>
        {record.setByName
          ? t('record.tier.setBy', { name: record.setByName, date })
          : t('record.tier.setByOther', { date })}
      </span>
      <p className={styles.status}>{t('record.tier.reason', { reason: record.reason })}</p>
    </div>
  );
}

function TierHistory({
  records,
  error,
}: {
  records: RiskTierRecord[] | null;
  error: RecordErrorKey | null;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <p className={styles.error} role="alert">
        {t(`record.errors.${error}`)}
      </p>
    );
  }
  if (!records) {
    return (
      <p className={styles.status} role="status">
        {t('record.tier.historyLoading')}
      </p>
    );
  }
  if (records.length === 0) return <p className={styles.empty}>{t('record.tier.historyEmpty')}</p>;
  return (
    <ol className={styles.list} aria-label={t('record.tier.showHistory')}>
      {records.map((r) => (
        <li key={r.id}>
          <TierSummary record={r} />
        </li>
      ))}
    </ol>
  );
}

function TierForm({
  clientId,
  initial,
  onSaved,
  onCancel,
}: {
  clientId: string;
  initial: RiskTier | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [tier, setTier] = useState<RiskTier | null>(initial);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<'tierRequired' | 'reasonRequired' | null>(null);
  const [error, setError] = useState<RecordErrorKey | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!tier) return setFieldError('tierRequired');
    if (!reason.trim()) return setFieldError('reasonRequired');
    setFieldError(null);
    setSaving(true);
    setError(null);
    setRiskTier(clientId, { tier, reason: reason.trim() })
      .then(onSaved)
      .catch((err: unknown) => setError(recordErrorKey(err)))
      .finally(() => setSaving(false));
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      noValidate
      aria-label={t('record.tier.formTitle')}
    >
      <fieldset className={styles.choices}>
        <legend>{t('record.tier.tierLabel')}</legend>
        {RISK_TIERS.map((value) => (
          <label key={value} className={styles.choice}>
            <input
              type="radio"
              name={`${id}-tier`}
              value={value}
              checked={tier === value}
              onChange={() => setTier(value)}
            />
            {t(`record.tier.levels.${value}`)}
          </label>
        ))}
      </fieldset>
      <label className={styles.label}>
        {t('record.tier.reasonLabel')}
        <textarea
          className={styles.textarea}
          value={reason}
          maxLength={RISK_TIER_REASON_MAX}
          placeholder={t('record.tier.reasonPlaceholder')}
          aria-invalid={fieldError === 'reasonRequired' ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {fieldError && (
        <p className={styles.error} role="alert">
          {t(`record.tier.${fieldError}`)}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {t(`record.errors.${error}`)}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t('record.saving') : t('record.save')}
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          {t('record.cancel')}
        </Button>
      </div>
    </form>
  );
}
