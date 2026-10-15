import {
  INDICATOR_CODES,
  THRESHOLD_BOUNDS,
  indicatorUnit,
  type CriticalComparator,
  type CriticalLevel,
  type CriticalThreshold,
  type IndicatorCode,
} from '@health-buddy/shared';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';

/** 指标目录里的全部指标，按目录顺序。阈值只能从这里选（M1 规格第五节之二）。 */
export const METRICS = INDICATOR_CODES as readonly IndicatorCode[];

/** 列表按指标目录顺序、再按方向排列，方便对照默认值表 */
export function sortThresholds(items: readonly CriticalThreshold[]): CriticalThreshold[] {
  const order = (c: IndicatorCode) => METRICS.indexOf(c);
  const dir: Record<CriticalComparator, number> = { gte: 0, gt: 1, lte: 2, lt: 3 };
  return [...items].sort(
    (a, b) => order(a.metric) - order(b.metric) || dir[a.comparator] - dir[b.comparator],
  );
}

export type ThresholdErrorKey =
  | 'invalid_value'
  | 'out_of_range'
  | 'bad_request'
  | 'duplicate'
  | 'not_found'
  | 'network'
  | 'unknown';

/** 把接口错误换成界面提示：400 超出合理范围，409 同一指标同一方向重复。 */
export function toThresholdError(err: unknown, hasMetric: boolean): ThresholdErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  switch (err.code) {
    case 'bad_request':
      return hasMetric ? 'out_of_range' : 'bad_request';
    case 'conflict':
      return 'duplicate';
    case 'not_found':
      return 'not_found';
    case 'network':
      return 'network';
    default:
      return 'unknown';
  }
}

export function useThresholdLabels() {
  const { t, i18n } = useTranslation();

  const unitLabel = useCallback(
    (metric: IndicatorCode) => {
      const unit = indicatorUnit(metric);
      const key = `units.${unit}`;
      return i18n.exists(key) ? (t as unknown as (k: string) => string)(key) : unit;
    },
    [t, i18n],
  );

  const errorText = useCallback(
    (key: ThresholdErrorKey, metric?: IndicatorCode) => {
      if (key === 'out_of_range' && metric) {
        const b = THRESHOLD_BOUNDS[metric];
        return t('thresholds.errors.out_of_range', {
          min: b.min,
          max: b.max,
          unit: unitLabel(metric),
        });
      }
      return t(`thresholds.errors.${key === 'out_of_range' ? 'bad_request' : key}`);
    },
    [t, unitLabel],
  );

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );

  return {
    metricName: (m: IndicatorCode) => t(`indicators.${m}`),
    unitLabel,
    direction: (c: CriticalComparator) => t(`thresholds.comparators.${c}`),
    symbol: (c: CriticalComparator) => t(`thresholds.symbols.${c}`),
    levelName: (l: CriticalLevel) => t(`thresholds.levels.${l}`),
    formatTime: (iso: string) => dateFormat.format(new Date(iso)),
    errorText,
  };
}
