import { QUOTA_METRICS, type MyPlan } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchMyPlan } from '../api/plan';
import styles from './MyAccount.module.css';

/**
 * “我的账号”（M7 规格 2.5 第 5 条）：套餐名称、到期日（随协会合同）、本月各项额度的已用和总数。
 * 账单和续费在 M13。
 */
export function MyAccountDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [plan, setPlan] = useState<MyPlan | null | 'error'>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyPlan()
      .then((p) => !cancelled && setPlan(p))
      .catch(() => !cancelled && setPlan('error'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className={styles.backdrop}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {t('myAccount.title')}
          </h2>
          <Button variant="ghost" onClick={onClose}>
            {t('myAccount.close')}
          </Button>
        </header>
        {plan === null && (
          <p className={styles.hint} role="status">
            {t('myAccount.loading')}
          </p>
        )}
        {plan === 'error' && (
          <p className={styles.hint} role="alert">
            {t('myAccount.loadFailed')}
          </p>
        )}
        {plan && plan !== 'error' && (
          <>
            <dl className={styles.list}>
              <dt>{t('myAccount.name')}</dt>
              <dd>{name}</dd>
              <dt>{t('myAccount.plan')}</dt>
              <dd>{plan.name}</dd>
              <dt>{t('myAccount.expires')}</dt>
              <dd>{plan.contractEnd ?? t('myAccount.noExpiry')}</dd>
              {QUOTA_METRICS.map((k) => (
                <QuotaRow
                  key={k}
                  label={t(`myAccount.quotas.${k}`)}
                  used={plan.usage[k]}
                  limit={plan.monthlyQuotas[k]}
                />
              ))}
            </dl>
            <p className={styles.hint}>{t('myAccount.hint')}</p>
          </>
        )}
      </div>
    </div>
  );
}

function QuotaRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const { t } = useTranslation();
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {limit === null
          ? t('myAccount.usedUnlimited', { used })
          : t('myAccount.usedOf', { used, limit })}
      </dd>
    </>
  );
}
