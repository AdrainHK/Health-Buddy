import {
  HEALTH_HISTORY_CATEGORIES,
  HEALTH_HISTORY_CONTENT_MAX,
  type HealthHistoryCategory,
  type HealthHistoryItem,
} from '@health-buddy/shared';
import { Button, IconButton } from '@health-buddy/ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createHistoryItem, deleteHistoryItem, updateHistoryItem } from '../api/clients';
import styles from './ClientRecord.module.css';
import { displayDate, recordErrorKey, type RecordErrorKey } from './errors';

export interface HealthHistorySectionProps {
  clientId: string;
  items: readonly HealthHistoryItem[];
  readOnly: boolean;
  onChanged: () => void;
}

/** 正在编辑的位置：某一类的新增，或某一条的修改 */
type Editing = { kind: 'add'; category: HealthHistoryCategory } | { kind: 'edit'; id: string };

/** 健康史（Q12）：五类自由文字条目，由健管师手动录入，AI 不自动写入 */
export function HealthHistorySection({
  clientId,
  items,
  readOnly,
  onChanged,
}: HealthHistorySectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<RecordErrorKey | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = (itemId: string) => {
    setBusy(true);
    setError(null);
    deleteHistoryItem(clientId, itemId)
      .then(() => {
        setConfirmDelete(null);
        onChanged();
      })
      .catch((err: unknown) => setError(recordErrorKey(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`} className={styles.sectionTitle}>
        {t('record.sections.history')}
      </h4>
      {HEALTH_HISTORY_CATEGORIES.map((category) => {
        const label = t(`record.history.categories.${category}`);
        const entries = items.filter((i) => i.category === category);
        const adding = editing?.kind === 'add' && editing.category === category;
        return (
          <div key={category} className={styles.form}>
            <div className={styles.sectionHeader}>
              <h5 className={styles.subTitle}>{label}</h5>
              {!readOnly && !adding && (
                <IconButton
                  size="small"
                  label={t('record.history.addTo', { category: label })}
                  icon={<Plus size={14} />}
                  onClick={() => setEditing({ kind: 'add', category })}
                />
              )}
            </div>
            {entries.length === 0 && !adding && (
              <p className={styles.empty}>{t('record.history.empty')}</p>
            )}
            {entries.length > 0 && (
              <ul className={styles.list}>
                {entries.map((item) =>
                  editing?.kind === 'edit' && editing.id === item.id ? (
                    <li key={item.id}>
                      <HistoryForm
                        clientId={clientId}
                        item={item}
                        category={category}
                        onCancel={() => setEditing(null)}
                        onSaved={() => {
                          setEditing(null);
                          onChanged();
                        }}
                      />
                    </li>
                  ) : (
                    <li key={item.id} className={styles.item}>
                      <div className={styles.itemMain}>
                        <div>{item.content}</div>
                        <div className={styles.meta}>
                          {item.recordedOn && (
                            <>{t('record.history.recorded', { date: item.recordedOn })} · </>
                          )}
                          {t('record.history.source', { date: displayDate(item.updatedAt) })}
                        </div>
                      </div>
                      {!readOnly && (
                        <div className={styles.itemActions}>
                          {confirmDelete === item.id ? (
                            <>
                              <span className={styles.meta}>
                                {t('record.history.deleteConfirm')}
                              </span>
                              <Button disabled={busy} onClick={() => remove(item.id)}>
                                {t('record.history.confirmDelete')}
                              </Button>
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setConfirmDelete(null)}
                              >
                                {t('record.cancel')}
                              </Button>
                            </>
                          ) : (
                            <>
                              <IconButton
                                size="small"
                                label={t('record.history.editItem', { category: label })}
                                icon={<Pencil size={14} />}
                                onClick={() => setEditing({ kind: 'edit', id: item.id })}
                              />
                              <IconButton
                                size="small"
                                label={t('record.history.deleteItem', { category: label })}
                                icon={<Trash2 size={14} />}
                                onClick={() => setConfirmDelete(item.id)}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
            {adding && (
              <HistoryForm
                clientId={clientId}
                category={category}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  onChanged();
                }}
              />
            )}
          </div>
        );
      })}
      {error && (
        <p className={styles.error} role="alert">
          {t(`record.errors.${error}`)}
        </p>
      )}
      <p className={styles.note}>{t('record.history.note')}</p>
    </section>
  );
}

function HistoryForm({
  clientId,
  category,
  item,
  onSaved,
  onCancel,
}: {
  clientId: string;
  category: HealthHistoryCategory;
  item?: HealthHistoryItem;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState(item?.content ?? '');
  const [recordedOn, setRecordedOn] = useState(item?.recordedOn ?? '');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<RecordErrorKey | null>(null);
  const [saving, setSaving] = useState(false);
  const label = t(`record.history.categories.${category}`);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = content.trim();
    if (!text) return setMissing(true);
    setMissing(false);
    setSaving(true);
    setError(null);
    const date = recordedOn || null;
    (item
      ? updateHistoryItem(clientId, item.id, { content: text, recordedOn: date })
      : createHistoryItem(clientId, { category, content: text, recordedOn: date })
    )
      .then(onSaved)
      .catch((err: unknown) => setError(recordErrorKey(err)))
      .finally(() => setSaving(false));
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      noValidate
      aria-label={
        item
          ? t('record.history.editItem', { category: label })
          : t('record.history.addTo', { category: label })
      }
    >
      <label className={styles.label}>
        {t('record.history.contentLabel')}
        <textarea
          className={styles.textarea}
          value={content}
          maxLength={HEALTH_HISTORY_CONTENT_MAX}
          aria-invalid={missing ? true : undefined}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <label className={styles.label}>
        {t('record.history.recordedOn')}
        <input
          className={styles.input}
          type="date"
          value={recordedOn}
          onChange={(e) => setRecordedOn(e.target.value)}
        />
      </label>
      {missing && (
        <p className={styles.error} role="alert">
          {t('record.history.contentRequired')}
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
