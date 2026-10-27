import {
  allergenConflicts,
  compareFollowUps,
  type AllergenConflict,
  type FollowUpItem,
} from '@health-buddy/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getClientRecord } from '../api/clients';
import { isAbortError } from '../api/http';
import { listFollowUps } from '../api/twin';
import styles from '../artifacts/ArtifactView.module.css';
import { useFollowUpBasis } from '../twin/FollowUpCard';
import type { LibraryData } from './StructuredEditors';
import type { M5Structured } from './m5Artifact';

/**
 * 用到的食谱和客户过敏史的冲突（M5 Q16）。过敏史只在浏览器里比对，不发往别处；
 * 后端确认时按同样的关键词表再查一遍。读不到档案时返回 null（不拦截，后端兜底）。
 */
export function useAllergenConflicts(
  clientId: string | null,
  structured: M5Structured | null,
  library: LibraryData,
): AllergenConflict[] | null {
  const [allergyTexts, setAllergyTexts] = useState<string[] | null>(null);
  const needed = structured?.kind === 'care_plan' && clientId !== null;
  useEffect(() => {
    if (!needed || clientId === null) return;
    const controller = new AbortController();
    getClientRecord(clientId, controller.signal)
      .then((record) =>
        setAllergyTexts(
          record.healthHistory.filter((h) => h.category === 'allergy').map((h) => h.content),
        ),
      )
      .catch((err: unknown) => {
        if (!isAbortError(err)) setAllergyTexts(null);
      });
    return () => controller.abort();
  }, [needed, clientId]);
  if (structured?.kind !== 'care_plan' || allergyTexts === null || library.status !== 'ready')
    return null;
  const used = new Set(structured.value.recipes.map((r) => r.recipeId));
  return allergenConflicts(
    allergyTexts,
    library.recipes.filter((r) => used.has(r.id)),
  );
}

/** 审核栏：方案用到的食谱和过敏史有匹配时醒目提示，必须勾选“已核对过敏原”才能确认 */
export function AllergenPanel({
  conflicts,
  library,
  showAcknowledge,
  acknowledged,
  disabled,
  onAcknowledge,
}: {
  conflicts: AllergenConflict[];
  library: LibraryData;
  showAcknowledge: boolean;
  acknowledged: boolean;
  disabled: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const names = new Map(library.recipes.map((r) => [r.id, r.name]));
  return (
    <div className={styles.critical} role="alert" data-testid="allergen-panel">
      <p className={styles.criticalTitle}>{t('care.review.allergenTitle')}</p>
      <ul className={styles.criticalList}>
        {conflicts.map((c) => (
          <li key={`${c.itemId}-${c.allergen}`}>
            {t('care.review.allergenLine', {
              recipe: names.get(c.itemId) ?? '',
              allergen: t(`library.allergenNames.${c.allergen}`),
            })}
          </li>
        ))}
      </ul>
      {showAcknowledge && (
        <label className={styles.checkLine}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={(e) => onAcknowledge(e.target.checked)}
          />
          <span>{t('care.review.allergenAck')}</span>
        </label>
      )}
    </div>
  );
}

/** 随访计划：确认后写入几次随访；以前排出、还没到期的随访会被新计划替代 */
export function ScheduleNote({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <p className={styles.statusNote} role="note">
      {t('care.review.scheduleWrites', { count })}
    </p>
  );
}

/**
 * 随访记录：确认时可以把这位客户未处理的跟进项一并标为“已处理（已电话联系）”（Q26）。
 * 后端校验每一项都属于这位客户，有一项不是就整个确认回滚。
 */
export function FollowUpResolvePanel({
  clientId,
  selected,
  disabled,
  onChange,
}: {
  clientId: string;
  selected: readonly string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const basis = useFollowUpBasis();
  const [items, setItems] = useState<FollowUpItem[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    listFollowUps({ clientId }, controller.signal)
      .then((res) => setItems([...res.items].sort(compareFollowUps)))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setItems([]);
      });
    return () => controller.abort();
  }, [clientId]);
  if (!items || items.length === 0) return null;
  return (
    <fieldset className={styles.tierSuggestion} data-testid="follow-up-resolve">
      <legend className={styles.tierTitle}>{t('care.review.resolveTitle')}</legend>
      {items.map((item) => (
        <label key={item.id} className={styles.checkLine}>
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id),
              )
            }
          />
          <span>
            {t('care.review.resolveLine', {
              kind: t(`followUps.kinds.${item.kind}`),
              basis: basis(item),
            })}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
