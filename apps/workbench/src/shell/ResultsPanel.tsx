import { EmptyState, IconButton } from '@health-buddy/ui';
import { FileText, History, UserRound, X } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ResultsPanel.module.css';

const TABS = ['artifacts', 'client', 'history'] as const;
type Tab = (typeof TABS)[number];

export interface ResultsPanelProps {
  /** docked：宽屏固定在右侧；sheet：窄屏从右侧滑出。 */
  mode: 'docked' | 'sheet';
  open: boolean;
  onClose: () => void;
  /** 当前任务和产物有变化时改变，结果区据此重新加载（产物预览在下一步实现） */
  refreshKey?: string;
}

/** 右侧结果区：产物、客户档案和修改记录。M0 只有空状态。 */
export function ResultsPanel({ mode, open, onClose, refreshKey }: ResultsPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('artifacts');
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  // 方向键切换标签，符合 WAI-ARIA tabs 规范。
  const onTabKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? 'artifacts';
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const classes = [styles.panel, mode === 'sheet' && styles.sheet].filter(Boolean).join(' ');

  return (
    <aside
      id="hb-results"
      className={classes}
      data-open={open}
      aria-labelledby="hb-results-title"
      aria-hidden={!open ? true : undefined}
      inert={!open ? true : undefined}
    >
      <div className={styles.header}>
        <h2 id="hb-results-title" className={styles.title}>
          {t('results.title')}
        </h2>
        <IconButton label={t('results.close')} icon={<X size={18} />} onClick={onClose} />
      </div>

      <div className={styles.tabs} role="tablist" aria-label={t('results.title')}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`hb-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`hb-tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={styles.tab}
            onClick={() => setTab(id)}
            onKeyDown={onTabKeyDown}
          >
            {t(`results.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div
        key={refreshKey}
        className={styles.content}
        role="tabpanel"
        id={`hb-tabpanel-${tab}`}
        aria-labelledby={`hb-tab-${tab}`}
      >
        {tab === 'artifacts' && (
          <EmptyState
            icon={<FileText size={20} />}
            title={t('results.empty.artifacts')}
            description={t('results.empty.artifactsHint')}
          />
        )}
        {tab === 'client' && (
          <EmptyState
            icon={<UserRound size={20} />}
            title={t('results.empty.client')}
            description={t('results.empty.clientHint')}
          />
        )}
        {tab === 'history' && (
          <EmptyState icon={<History size={20} />} title={t('results.empty.history')} />
        )}
      </div>
    </aside>
  );
}
