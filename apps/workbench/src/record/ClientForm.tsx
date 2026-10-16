import {
  BIRTH_YEAR_MIN,
  CLIENT_GENDERS,
  CLIENT_NAME_MAX,
  type ClientGender,
  type ClientSummary,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createClient, updateClient } from '../api/clients';
import styles from './ClientRecord.module.css';
import { recordErrorKey, type RecordErrorKey } from './errors';

export interface ClientFormProps {
  /** 有值时是编辑这位客户，否则是新建 */
  client?: ClientSummary;
  onSaved: (client: ClientSummary) => void;
  onCancel: () => void;
}

type FieldError = 'nameRequired' | 'nameTooLong' | 'birthYearInvalid';

/** 新建或编辑客户：只有称呼、性别、出生年份（Q13），不收集联系方式 */
export function ClientForm({ client, onSaved, onCancel }: ClientFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(client?.displayName ?? '');
  const [gender, setGender] = useState<ClientGender | ''>(client?.gender ?? '');
  const [birthYear, setBirthYear] = useState(client?.birthYear?.toString() ?? '');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'name' | 'birthYear', FieldError>>>(
    {},
  );
  const [error, setError] = useState<RecordErrorKey | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const errors: typeof fieldErrors = {};
    if (!trimmed) errors.name = 'nameRequired';
    else if (trimmed.length > CLIENT_NAME_MAX) errors.name = 'nameTooLong';
    let year: number | null = null;
    if (birthYear.trim()) {
      year = Number(birthYear.trim());
      if (!Number.isInteger(year) || year < BIRTH_YEAR_MIN || year > new Date().getFullYear()) {
        errors.birthYear = 'birthYearInvalid';
      }
    }
    setFieldErrors(errors);
    if (errors.name || errors.birthYear) return;

    const body = { displayName: trimmed, gender: gender || null, birthYear: year };
    setSaving(true);
    setError(null);
    (client ? updateClient(client.id, body) : createClient(body))
      .then(onSaved)
      .catch((err: unknown) => setError(recordErrorKey(err)))
      .finally(() => setSaving(false));
  };

  const fieldError = (key: FieldError) =>
    key === 'nameTooLong'
      ? t('record.form.nameTooLong', { max: CLIENT_NAME_MAX })
      : key === 'birthYearInvalid'
        ? t('record.form.birthYearInvalid', { min: BIRTH_YEAR_MIN })
        : t('record.form.nameRequired');

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className={styles.formTitle}>
        {client ? t('record.form.editTitle') : t('record.form.createTitle')}
      </h3>
      <label className={styles.label}>
        {t('record.form.name')}
        <input
          className={styles.input}
          value={name}
          maxLength={CLIENT_NAME_MAX + 10}
          placeholder={t('record.form.namePlaceholder')}
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? `${id}-name-error` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {fieldErrors.name && (
        <p id={`${id}-name-error`} className={styles.error}>
          {fieldError(fieldErrors.name)}
        </p>
      )}
      <label className={styles.label}>
        {t('record.form.gender')}
        <select
          className={styles.select}
          value={gender}
          onChange={(e) => setGender(e.target.value as ClientGender | '')}
        >
          <option value="">{t('record.form.genderUnset')}</option>
          {CLIENT_GENDERS.map((g) => (
            <option key={g} value={g}>
              {t(`record.basic.genders.${g}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.label}>
        {t('record.form.birthYear')}
        <input
          className={styles.input}
          inputMode="numeric"
          value={birthYear}
          placeholder={t('record.form.birthYearPlaceholder')}
          aria-invalid={fieldErrors.birthYear ? true : undefined}
          aria-describedby={fieldErrors.birthYear ? `${id}-year-error` : undefined}
          onChange={(e) => setBirthYear(e.target.value)}
        />
      </label>
      {fieldErrors.birthYear && (
        <p id={`${id}-year-error`} className={styles.error}>
          {fieldError(fieldErrors.birthYear)}
        </p>
      )}
      <p className={styles.note}>{t('record.form.note')}</p>
      {error && (
        <p className={styles.error} role="alert">
          {t(`record.errors.${error}`)}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t('record.saving') : client ? t('record.save') : t('record.form.create')}
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          {t('record.cancel')}
        </Button>
      </div>
    </form>
  );
}
