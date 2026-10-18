import type { ExpertConsultation } from '@health-buddy/shared';
import { useTranslation } from 'react-i18next';
import styles from './Experts.module.css';

export interface Signals {
  crisis: boolean;
  emergency: boolean;
}

/**
 * 一次专家调用的危机、急症信号（规格 7.2 第 5 条）。以后端合并好的 crisisSignal / emergencySignal 为准：
 * 关键词识别、每位专家（包括意见没通过校验的）和汇总，任何一处标出即为 true；
 * 专家都没回复、调用被停止、没有汇总时也在。再和汇总、意见里的信号取并集，旧数据也不会漏。
 */
export function consultationSignals(c: ExpertConsultation): Signals {
  const opinions = c.calls.flatMap((call) => (call.opinion ? [call.opinion] : []));
  return {
    crisis:
      c.crisisSignal || Boolean(c.synthesis?.crisisSignal) || opinions.some((o) => o.crisisSignal),
    emergency:
      c.emergencySignal ||
      Boolean(c.synthesis?.emergencySignal) ||
      opinions.some((o) => o.emergencySignal),
  };
}

/** 多次调用的信号取并集 */
export function mergeSignals(list: readonly Signals[]): Signals {
  return {
    crisis: list.some((s) => s.crisis),
    emergency: list.some((s) => s.emergency),
  };
}

/**
 * 危机、急症提示框：只给健管师看，放在最前面，不能关闭。专家标签、对话区的回答和审核栏共用这一组文字。
 */
export function SignalAlerts({ crisis, emergency }: Signals) {
  const { t } = useTranslation();
  return (
    <>
      {crisis && (
        <p className={styles.alert} role="alert">
          <strong>{t('signals.crisis')}</strong>
          {t('signals.crisisText')}
        </p>
      )}
      {emergency && (
        <p className={styles.alert} role="alert">
          <strong>{t('signals.emergency')}</strong>
          {t('signals.emergencyText')}
        </p>
      )}
    </>
  );
}

/** 折叠的调用卡片标题里的醒目标记：收起时也能看到有信号 */
export function SignalBadges({ crisis, emergency }: Signals) {
  const { t } = useTranslation();
  return (
    <>
      {crisis && <span className={styles.signalBadge}>{t('signals.crisis')}</span>}
      {emergency && <span className={styles.signalBadge}>{t('signals.emergency')}</span>}
    </>
  );
}
