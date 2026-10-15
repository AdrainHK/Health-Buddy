import { Button, IconButton } from '@health-buddy/ui';
import { PRODUCT_NAME } from '@health-buddy/shared';
import {
  Heart,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sparkles,
  Stethoscope,
  Timer,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Sidebar.module.css';

export interface SidebarAccount {
  name: string;
  onLogout: () => void;
}

export interface SidebarProps {
  /** docked：宽屏固定在左侧；drawer：窄屏从左侧滑出。 */
  mode: 'docked' | 'drawer';
  collapsed: boolean;
  open: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
  account?: SidebarAccount;
}

export function Sidebar({
  mode,
  collapsed,
  open,
  onToggleCollapsed,
  onClose,
  account,
}: SidebarProps) {
  const { t } = useTranslation();
  const classes = [
    styles.sidebar,
    mode === 'drawer' && styles.drawer,
    collapsed && styles.collapsed,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <aside
      id="hb-sidebar"
      className={classes}
      data-open={open}
      aria-label={PRODUCT_NAME}
      aria-hidden={mode === 'drawer' && !open ? true : undefined}
      inert={mode === 'drawer' && !open ? true : undefined}
    >
      <div className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Heart size={16} strokeWidth={2.5} />
          </span>
          {!collapsed && <span>{PRODUCT_NAME}</span>}
        </div>
        {mode === 'drawer' ? (
          <IconButton label={t('nav.closeMenu')} icon={<X size={18} />} onClick={onClose} />
        ) : (
          <IconButton
            label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            aria-expanded={!collapsed}
            aria-controls="hb-sidebar"
            onClick={onToggleCollapsed}
          />
        )}
      </div>

      {collapsed ? (
        <IconButton variant="primary" label={t('nav.newTask')} icon={<Plus size={18} />} />
      ) : (
        <Button variant="primary" block icon={<Plus size={18} />}>
          {t('nav.newTask')}
        </Button>
      )}

      <nav className={styles.nav}>
        <NavItem icon={<Sparkles size={18} />} label={t('nav.skills')} />
        <NavItem icon={<Stethoscope size={18} />} label={t('nav.experts')} />
        <NavItem icon={<Timer size={18} />} label={t('nav.automations')} />
      </nav>

      {collapsed ? (
        <div className={styles.spacer} />
      ) : (
        <section className={styles.section} aria-labelledby="hb-tasks-title">
          <h2 id="hb-tasks-title" className={styles.sectionTitle}>
            {t('nav.tasks')}
          </h2>
          <p className={styles.empty}>{t('nav.noTasks')}</p>
        </section>
      )}

      <div className={styles.footer}>
        <NavItem icon={<Settings size={18} />} label={t('nav.settings')} />
        {account && (
          <div className={styles.account}>
            {!collapsed && (
              <span className={styles.accountName} title={account.name}>
                {account.name}
              </span>
            )}
            <IconButton
              label={t('auth.logout')}
              icon={<LogOut size={18} />}
              onClick={account.onLogout}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

function NavItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button type="button" className={styles.navItem} title={label}>
      {icon}
      <span className={styles.label}>{label}</span>
    </button>
  );
}
