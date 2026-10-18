import type { ExpertSummary } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Stethoscope } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Experts.module.css';

type Choice = 'auto' | 'include' | 'exclude';
const CHOICES: readonly Choice[] = ['auto', 'include', 'exclude'];

export interface ExpertSelectorProps {
  experts: readonly ExpertSummary[];
  /** “一定要请”（等同 @，和输入框里 @ 的专家是同一份） */
  included: readonly string[];
  /** “不要请” */
  excluded: readonly string[];
  onChange: (included: string[], excluded: string[]) => void;
  /** “一定要请”最多几位（Q5） */
  maxIncluded: number;
  disabled?: boolean;
}

/**
 * 发送前的专家选择条（M3 规格 2.5、Q22）：默认“自动选择”，可以点开给每位专家选“一定要请”或“不要请”。
 * 选择只对这一条消息生效，发送后清空。
 */
export function ExpertSelector({
  experts,
  included,
  excluded,
  onChange,
  maxIncluded,
  disabled = false,
}: ExpertSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const nameOf = (id: string) => experts.find((e) => e.id === id)?.name ?? id;
  const sep = t('experts.separator');

  const parts = [
    ...(included.length
      ? [t('chat.experts.selector.includeSummary', { names: included.map(nameOf).join(sep) })]
      : []),
    ...(excluded.length
      ? [t('chat.experts.selector.excludeSummary', { names: excluded.map(nameOf).join(sep) })]
      : []),
  ];
  const summary = parts.length
    ? parts.join(t('chat.experts.selector.summarySeparator'))
    : t('chat.experts.selector.auto');

  const choiceOf = (id: string): Choice =>
    included.includes(id) ? 'include' : excluded.includes(id) ? 'exclude' : 'auto';

  const choose = (id: string, choice: Choice) => {
    const inc = included.filter((x) => x !== id);
    const exc = excluded.filter((x) => x !== id);
    if (choice === 'include') inc.push(id);
    if (choice === 'exclude') exc.push(id);
    onChange(inc, exc);
  };

  return (
    <div className={styles.selector} role="group" aria-label={t('chat.experts.selector.label')}>
      <div className={styles.selectorHead}>
        <Stethoscope size={14} aria-hidden />
        <span>{t('chat.experts.selector.label')}</span>
        <span className={styles.selectorSummary} data-testid="expert-selector-summary">
          {summary}
        </span>
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('chat.experts.selector.close') : t('chat.experts.selector.open')}
        </Button>
      </div>
      {open && (
        <div id={panelId}>
          <ul className={styles.selectorList}>
            {experts.map((e) => {
              const current = choiceOf(e.id);
              return (
                <li key={e.id} className={styles.selectorRow}>
                  <span>{e.name}</span>
                  <fieldset
                    className={styles.choice}
                    aria-label={t('chat.experts.selector.rowLabel', { name: e.name })}
                  >
                    {CHOICES.map((choice) => (
                      <label key={choice} className={styles.choiceOption}>
                        <input
                          type="radio"
                          name={`${panelId}-${e.id}`}
                          checked={current === choice}
                          disabled={
                            disabled ||
                            (choice === 'include' &&
                              current !== 'include' &&
                              included.length >= maxIncluded)
                          }
                          onChange={() => choose(e.id, choice)}
                        />
                        {t(
                          choice === 'auto'
                            ? 'chat.experts.selector.autoOption'
                            : `chat.experts.selector.${choice}`,
                        )}
                      </label>
                    ))}
                  </fieldset>
                </li>
              );
            })}
          </ul>
          <p className={styles.note}>{t('chat.experts.selector.note')}</p>
        </div>
      )}
    </div>
  );
}
