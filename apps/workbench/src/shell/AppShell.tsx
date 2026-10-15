import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './AppShell.module.css';
import { ChatPane } from './ChatPane';
import { ResultsPanel } from './ResultsPanel';
import { Sidebar } from './Sidebar';
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery';

/**
 * 工作台三栏布局：左侧栏、中间对话区、右侧结果区。
 * 宽屏时三栏并排；窄屏时侧栏和结果区都改为浮层，同一时间最多打开一个。
 */
export function AppShell() {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(!narrow);

  // 从宽屏切到窄屏时收起浮层，避免遮住对话区。
  useEffect(() => {
    if (narrow) {
      setDrawerOpen(false);
      setResultsOpen(false);
    }
  }, [narrow]);

  const overlayOpen = narrow && (drawerOpen || resultsOpen);

  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        setResultsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen]);

  const toggleResults = () => {
    if (narrow) setDrawerOpen(false);
    setResultsOpen((open) => !open);
  };

  return (
    <div
      className={styles.shell}
      data-layout={narrow ? 'narrow' : 'wide'}
      data-sidebar={!narrow && sidebarCollapsed ? 'collapsed' : 'expanded'}
      data-results={!narrow && resultsOpen ? 'open' : 'closed'}
    >
      <Sidebar
        mode={narrow ? 'drawer' : 'docked'}
        collapsed={!narrow && sidebarCollapsed}
        open={narrow ? drawerOpen : true}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        onClose={() => setDrawerOpen(false)}
      />
      <ChatPane
        narrow={narrow}
        onOpenMenu={() => {
          setResultsOpen(false);
          setDrawerOpen(true);
        }}
        resultsOpen={resultsOpen}
        onToggleResults={toggleResults}
      />
      <ResultsPanel
        mode={narrow ? 'sheet' : 'docked'}
        open={resultsOpen}
        onClose={() => setResultsOpen(false)}
      />
      {overlayOpen && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label={drawerOpen ? t('nav.closeMenu') : t('results.close')}
          onClick={() => {
            setDrawerOpen(false);
            setResultsOpen(false);
          }}
        />
      )}
    </div>
  );
}
