import { PRODUCT_NAME, type CurrentUser } from '@health-buddy/shared';
import { IconButton } from '@health-buddy/ui';
import { Heart, LogOut, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './AdminShell.module.css';

export interface AdminShellProps {
  user: CurrentUser;
  onLogout: () => void;
  children: ReactNode;
}

/** 后台外框：顶栏（产品名、账号、退出）、版块导航和内容区。M1 只有“危急指标设置”一个版块。 */
export function AdminShell({ user, onLogout, children }: AdminShellProps) {
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
          <a className={styles.navItem} href="#critical-thresholds" aria-current="page">
            <ShieldAlert size={16} aria-hidden />
            <span>{t('thresholds.nav')}</span>
          </a>
        </nav>
        <main className={styles.main} id="critical-thresholds">
          {children}
        </main>
      </div>
    </div>
  );
}
