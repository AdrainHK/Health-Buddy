import { PRODUCT_NAME } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './LoginPage.module.css';

/** 管理员账号登录工作台时显示：工作台只给健管师用，引导去后台（/admin/）。 */
export function AdminNotice({ onLogout }: { onLogout: () => void }) {
  const { t } = useTranslation();
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="admin-notice-title">
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Heart size={20} strokeWidth={2.5} />
          </span>
          <span>{PRODUCT_NAME}</span>
        </div>
        <h1 id="admin-notice-title" className={styles.title}>
          {t('auth.adminNotice.title')}
        </h1>
        <p className={styles.subtitle}>{t('auth.adminNotice.body')}</p>
        <a className={styles.primaryLink} href="/admin/">
          {t('auth.adminNotice.goToAdmin')}
        </a>
        <Button variant="ghost" block onClick={onLogout}>
          {t('auth.logout')}
        </Button>
      </section>
    </main>
  );
}
