import {
  THRESHOLD_BOUNDS,
  TWIN_DOMAINS,
  TWIN_RULE_METHODS,
  TWIN_RULE_SOURCES,
  domainMetrics,
  type IndicatorCode,
  type TwinDomain,
  type TwinRuleLevel,
  type TwinRuleMethod,
  type TwinRuleSource,
  type TwinStatusRuleRecord,
} from '@health-buddy/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';
import { useThresholdLabels } from '../thresholds/labels';

/** 方面下某个来源可选的指标（M4 规格 4.1）。规则只能从这里选 */
export function metricsFor(domain: TwinDomain, source: TwinRuleSource): IndicatorCode[] {
  return [...(domainMetrics[domain][source] as readonly IndicatorCode[])];
}

/** 判断方式和来源的搭配：超出参考范围只用于报告，固定阈值只用于监测（第五节之二） */
export function methodsFor(source: TwinRuleSource): TwinRuleMethod[] {
  return TWIN_RULE_METHODS.filter((m) =>
    m === 'out_of_reference'
      ? source === 'report'
      : m === 'threshold'
        ? source === 'monitoring'
        : true,
  );
}

/** 列表按方面、来源、指标（各自的目录顺序）、判断方式排列，方便对照默认规则 */
export function sortTwinRules(items: readonly TwinStatusRuleRecord[]): TwinStatusRuleRecord[] {
  const key = (r: TwinStatusRuleRecord) => [
    TWIN_DOMAINS.indexOf(r.domain),
    TWIN_RULE_SOURCES.indexOf(r.source),
    metricsFor(r.domain, r.source).indexOf(r.metric),
    TWIN_RULE_METHODS.indexOf(r.method),
    r.comparator ?? '',
  ];
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! < kb[i]!) return -1;
      if (ka[i]! > kb[i]!) return 1;
    }
    return 0;
  });
}

export type TwinRuleErrorKey =
  | 'invalid_value'
  | 'invalid_window'
  | 'out_of_range'
  | 'bad_request'
  | 'duplicate'
  | 'not_found'
  | 'forbidden'
  | 'network'
  | 'unknown';

/** 接口错误换成界面提示：400 形状或范围不对，409 重复，403 不是平台管理员 */
export function toTwinRuleError(err: unknown, threshold: boolean): TwinRuleErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  switch (err.code) {
    case 'bad_request':
      return threshold ? 'out_of_range' : 'bad_request';
    case 'conflict':
      return 'duplicate';
    case 'not_found':
      return 'not_found';
    case 'forbidden':
      return 'forbidden';
    case 'network':
      return 'network';
    default:
      return 'unknown';
  }
}

export function useTwinRuleLabels() {
  const { t } = useTranslation();
  const base = useThresholdLabels();

  const errorText = useCallback(
    (key: TwinRuleErrorKey, metric?: IndicatorCode) => {
      if (key === 'out_of_range' && metric) {
        const b = THRESHOLD_BOUNDS[metric];
        return t('twinRules.errors.out_of_range', {
          min: b.min,
          max: b.max,
          unit: base.unitLabel(metric),
        });
      }
      return t(`twinRules.errors.${key === 'out_of_range' ? 'bad_request' : key}`);
    },
    [t, base],
  );

  return {
    metricName: base.metricName,
    unitLabel: base.unitLabel,
    symbol: base.symbol,
    direction: base.direction,
    formatTime: base.formatTime,
    domainName: (d: TwinDomain) => t(`twinRules.domains.${d}`),
    sourceName: (s: TwinRuleSource) => t(`twinRules.sources.${s}`),
    methodName: (m: TwinRuleMethod) => t(`twinRules.methods.${m}`),
    levelName: (l: TwinRuleLevel) => t(`twinRules.levels.${l}`),
    errorText,
  };
}
