import { PRODUCT_NAME, type CurrentUser } from '@health-buddy/shared';
import { IconButton } from '@health-buddy/ui';
import { Heart, LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './AdminShell.module.css';

/** 导航里的一个版块：id 同时是地址栏的 #锚点 */
export interface AdminSection {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface AdminShellProps {
  user: CurrentUser;
  onLogout: () => void;
  sections: readonly AdminSection[];
  current: string;
  children: ReactNode;
}

/**
 * 后台外框：顶栏（产品名、账号、退出）、版块导航和内容区。
 * 能看到哪些版块由 App 按角色决定；真正的权限在后端。
 */
export function AdminShell({ user, onLogout, sections, current, children }: AdminShellProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Heart size={16} strokeWidth={2.5} />
          </span>
          <span>{PRODUCT_NAME}</span>
          <span className={styles.console}>{t('shell.console')}</span>
        </div>
        <div className={styles.account}>
          <span className={styles.accountName} title={user.displayName}>
            {user.displayName}
          </span>
          <span className={styles.role}>{t(`shell.roles.${user.role}`)}</span>
          <IconButton label={t('auth.logout')} icon={<LogOut size={16} />} onClick={onLogout} />
        </div>
      </header>
      <div className={styles.body}>
        <nav className={styles.nav} aria-label={t('shell.nav')}>
          {sections.map((section) => (
            <a
              key={section.id}
              className={styles.navItem}
              href={`#${section.id}`}
              aria-current={section.id === current ? 'page' : undefined}
            >
              {section.icon}
              <span>{section.label}</span>
            </a>
          ))}
        </nav>
        <main className={styles.main} id="admin-main">
          {children}
        </main>
      </div>
    </div>
  );
}
