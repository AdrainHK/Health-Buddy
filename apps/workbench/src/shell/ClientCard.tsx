import type { ClientSummary } from '@health-buddy/shared';
import { useTranslation } from 'react-i18next';
import styles from './ClientCard.module.css';

/** 结果区“客户”标签：当前任务关联（或输入框里 @ 的）客户的基本信息（M1 规格 3.1） */
export function ClientCard({ client }: { client: ClientSummary }) {
  const { t } = useTranslation();
  const age = client.birthYear === null ? null : new Date().getFullYear() - client.birthYear;
  const rows: [string, string][] = [
    [t('results.client.gender'), t(`results.client.genders.${client.gender ?? 'unknown'}`)],
    [
      t('results.client.age'),
      age === null ? t('results.client.unknown') : t('results.client.ageValue', { age }),
    ],
  ];
  return (
    <section className={styles.card} aria-labelledby="hb-client-name">
      <h3 id="hb-client-name" className={styles.name}>
        {client.displayName}
        {client.isSynthetic && <span className={styles.tag}>{t('results.client.synthetic')}</span>}
      </h3>
      <dl className={styles.fields}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.field}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.hint}>{t('results.client.hint')}</p>
    </section>
  );
}
