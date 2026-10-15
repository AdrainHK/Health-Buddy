import { PRODUCT_NAME } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import loginStyles from '../auth/LoginPage.module.css';
import styles from './ManagerNotice.module.css';

/** 健管师登录后台时显示：后台只给管理员用，引导去工作台（站点根路径）。 */
export function ManagerNotice({ onLogout }: { onLogout: () => void }) {
  const { t } = useTranslation();
  return (
    <main className={loginStyles.page}>
      <section className={loginStyles.card} aria-labelledby="manager-notice-title">
        <div className={loginStyles.brand}>
          <span className={loginStyles.logo} aria-hidden>
            <Heart size={20} strokeWidth={2.5} />
          </span>
          <span>{PRODUCT_NAME}</span>
        </div>
        <h1 id="manager-notice-title" className={loginStyles.title}>
          {t('managerNotice.title')}
        </h1>
        <p className={loginStyles.subtitle}>{t('managerNotice.body')}</p>
        <a className={styles.primaryLink} href="/">
          {t('managerNotice.goToWorkbench')}
        </a>
        <Button variant="ghost" block onClick={onLogout}>
          {t('auth.logout')}
        </Button>
      </section>
    </main>
  );
}
