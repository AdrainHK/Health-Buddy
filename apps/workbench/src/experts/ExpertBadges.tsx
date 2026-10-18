import { Stethoscope } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './Experts.module.css';

/** “AI”标记：专家卡片、@ 列表和意见旁边都带，避免误以为是真人医生的意见（Q24） */
export function AiBadge() {
  const { t } = useTranslation();
  return (
    <span className={styles.aiBadge} title={t('experts.aiNote')}>
      {t('experts.ai')}
    </span>
  );
}

/** 专家头像：任务列表里专家中心发起的任务名前也用它（Q25） */
export function ExpertAvatar({
  name,
  size = 'medium',
}: {
  name: string;
  size?: 'small' | 'medium';
}) {
  const { t } = useTranslation();
  return (
    <span
      className={styles.avatar}
      data-size={size}
      role="img"
      aria-label={t('experts.avatar', { name })}
      title={name}
    >
      <Stethoscope size={size === 'small' ? 12 : 18} aria-hidden />
    </span>
  );
}
