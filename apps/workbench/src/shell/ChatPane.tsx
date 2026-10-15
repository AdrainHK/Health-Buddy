import { IconButton } from '@health-buddy/ui';
import { ArrowUp, Menu, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ChatPane.module.css';

const MODES = ['ask', 'plan', 'craft'] as const;
type Mode = (typeof MODES)[number];

export interface ChatPaneProps {
  narrow: boolean;
  onOpenMenu: () => void;
  resultsOpen: boolean;
  onToggleResults: () => void;
}

/** 中间对话区。M0 只有欢迎页和输入框外观，对话功能在 M1 实现。 */
export function ChatPane({ narrow, onOpenMenu, resultsOpen, onToggleResults }: ChatPaneProps) {
  const { t } = useTranslation();
  // 默认“做一做”，与 WorkBuddy 的默认模式一致。
  const [mode] = useState<Mode>('craft');

  return (
    <main className={styles.pane}>
      <header className={styles.topbar}>
        {narrow && (
          <IconButton
            label={t('nav.openMenu')}
            icon={<Menu size={18} />}
            aria-controls="hb-sidebar"
            onClick={onOpenMenu}
          />
        )}
        <h1 className={styles.title}>{t('chat.untitled')}</h1>
        <IconButton
          label={resultsOpen ? t('results.close') : t('results.open')}
          icon={resultsOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          aria-expanded={resultsOpen}
          aria-controls="hb-results"
          onClick={onToggleResults}
        />
      </header>

      <div className={styles.body}>
        <div className={styles.welcome}>
          <p className={styles.greeting}>{t('chat.greeting')}</p>
          <p className={styles.subtitle}>{t('chat.subtitle')}</p>

          <form className={styles.composer} onSubmit={(e) => e.preventDefault()}>
            <textarea
              className={styles.input}
              placeholder={t('chat.placeholder')}
              aria-label={t('chat.placeholder')}
              disabled
            />
            <div className={styles.composerBar}>
              <div className={styles.modes} role="radiogroup" aria-label={t('chat.modes.label')}>
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    className={styles.mode}
                    disabled
                  >
                    {t(`chat.modes.${m}`)}
                  </button>
                ))}
              </div>
              <IconButton
                type="submit"
                variant="primary"
                label={t('chat.send')}
                icon={<ArrowUp size={18} />}
                disabled
              />
            </div>
          </form>
          <p className={styles.hint}>{t('chat.comingSoon')}</p>
        </div>
      </div>
    </main>
  );
}
