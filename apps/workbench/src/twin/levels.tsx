import type { TwinLevel } from '@health-buddy/shared';
import { useTranslation } from 'react-i18next';
import styles from './Twin.module.css';

/**
 * 每个状态除了颜色还有图形标记（规格 2.3：颜色不是唯一的表达，色弱用户也能区分）：
 * 红“!”、黄“△”、绿“✓”、灰“?”。
 */
export const LEVEL_MARKERS: Record<TwinLevel, string> = {
  red: '!',
  yellow: '△',
  green: '✓',
  unknown: '?',
};

/** 状态标签：图形标记 + 文字（如“! 需要尽快关注”），颜色只用 --hb-twin-* 令牌 */
export function LevelBadge({ level }: { level: TwinLevel }) {
  const { t } = useTranslation();
  return (
    <span className={styles.levelBadge} data-level={level}>
      <span className={styles.marker} aria-hidden>
        {LEVEL_MARKERS[level]}
      </span>
      {t(`twin.levels.${level}`)}
    </span>
  );
}

/** 小圆点（左侧栏客户列表）：带图形标记，读屏读出 label */
export function LevelDot({ level, label }: { level: TwinLevel; label: string }) {
  return (
    <span
      className={styles.levelDot}
      data-level={level}
      role="img"
      aria-label={label}
      title={label}
    >
      <span aria-hidden>{LEVEL_MARKERS[level]}</span>
    </span>
  );
}
