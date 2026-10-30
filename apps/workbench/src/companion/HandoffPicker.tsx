import type { CompanionHandoff } from '@health-buddy/shared';
import { MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getClientCompanionCases } from '../api/companion';
import { isAbortError } from '../api/http';
import care from '../care/Care.module.css';
import { displayDateTime } from '../twin/errors';
import styles from '../twin/Twin.module.css';

/** 卡片上显示的客户原话长度，完整原话在伴侣视图里看 */
const PREVIEW_CHARS = 20;

/**
 * /转交回复 的“@伴侣转交”（M6 规格 2.8）：对话区输入框上方列出这位客户未处理的转交，选一个
 * （最多 1 个）。只有选了 /转交回复 时显示；转交原话只给服务这位客户的健管师看。
 */
export function HandoffPicker({
  clientId,
  readOnly,
  selected,
  onSelect,
}: {
  clientId: string;
  readOnly: boolean;
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ clientId: string; handoffs: CompanionHandoff[] } | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    getClientCompanionCases(clientId, controller.signal)
      .then((cases) =>
        setState({ clientId, handoffs: cases.handoffs.filter((h) => h.status === 'open') }),
      )
      .catch((err: unknown) => {
        if (!isAbortError(err)) setState({ clientId, handoffs: [] });
      });
    return () => controller.abort();
  }, [clientId]);

  const handoffs = state?.clientId === clientId ? state.handoffs : null;
  if (!handoffs) return null;
  if (handoffs.length === 0) {
    return (
      <div className={care.materials}>
        <p className={styles.muted}>{t('companion.picker.none')}</p>
      </div>
    );
  }
  return (
    <div className={care.materials}>
      <ul className={care.materialList} aria-label={t('companion.picker.list')}>
        {handoffs.map((h) => {
          const preview = [...h.question].slice(0, PREVIEW_CHARS).join('');
          const more = [...h.question].length > PREVIEW_CHARS ? '…' : '';
          return (
            <li key={h.id} className={care.materialCard}>
              {!readOnly && (
                <input
                  type="radio"
                  name="handoff-ref"
                  aria-label={t('companion.picker.select', { text: preview })}
                  checked={selected.includes(h.id)}
                  onChange={() => onSelect([h.id])}
                />
              )}
              <MessageSquareText size={16} aria-hidden />
              <span className={care.materialText}>
                {t(`companion.cases.handoffCategories.${h.category}`)} · {preview}
                {more}
                <span className={styles.muted}> {displayDateTime(h.createdAt)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {!readOnly && <p className={styles.muted}>{t('companion.picker.hint')}</p>}
    </div>
  );
}
