import type { CriticalComparator, TwinBasisItem, TwinRuleHit } from '@health-buddy/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDynamicT } from '../i18n/dynamic';

/** 数值最多保留两位小数（后端已按目录单位换算好） */
export function formatNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 指标显示名：indicators.<code>，缺失时显示编码 */
export function useMetricName(): (code: string) => string {
  const dt = useDynamicT();
  return useCallback((code: string) => dt(`indicators.${code}`, code), [dt]);
}

/** 参考范围，如“3.9–6.1”“≤ 5.2”；两头都没有时返回 null */
export function useRangeText(): (low: number | null, high: number | null) => string | null {
  const { t } = useTranslation();
  return useCallback(
    (low: number | null, high: number | null) => {
      if (low !== null && high !== null)
        return t('twin.range.both', { low: formatNumber(low), high: formatNumber(high) });
      if (low !== null) return t('twin.range.low', { low: formatNumber(low) });
      if (high !== null) return t('twin.range.high', { high: formatNumber(high) });
      return null;
    },
    [t],
  );
}

export function useComparator(): (c: CriticalComparator) => string {
  const { t } = useTranslation();
  return useCallback((c: CriticalComparator) => t(`twin.comparators.${c}`), [t]);
}

/**
 * 状态依据的一句话（规格 2.3），如
 * “空腹血糖 6.5 mmol/L（2026-09-12 报告）；高于报告上的参考范围 3.9–6.1”。
 * 全部由后端算好的结构化数据按模板拼出，不经大模型。
 */
export function useBasisText(): (item: TwinBasisItem) => string {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const range = useRangeText();
  const comparator = useComparator();
  return useCallback(
    (item: TwinBasisItem) => {
      // 伴侣收集信息（M6 Q20）：只有条数，不写客户原话
      if (item.source === 'companion') {
        const category = t(`twin.basis.categories.${item.metric}`);
        const head = t('twin.basis.companion', {
          days: item.windowDays,
          category,
          value: item.value,
          count: item.count,
          from: item.from,
          date: item.observedOn,
        });
        const parts = item.hits.map((hit) =>
          hit.method === 'observation_count'
            ? t('twin.basis.observationCount', { count: hit.snapshot.minCount })
            : '',
        );
        return [head, ...(parts.length ? parts : [t('twin.basis.noHit')])].join(
          t('twin.basis.separator'),
        );
      }
      const metric = metricName(item.metric);
      const head =
        item.source === 'report'
          ? t('twin.basis.report', {
              metric,
              value: formatNumber(item.value),
              unit: item.unit,
              date: item.observedOn,
            })
          : t('twin.basis.monitoring', {
              metric,
              value: formatNumber(item.value),
              unit: item.unit,
              days: item.windowDays,
              count: item.count,
              from: item.from,
              date: item.observedOn,
            });
      const hitText = (hit: TwinRuleHit): string => {
        switch (hit.method) {
          case 'critical':
            return t('twin.basis.critical', {
              comparator: comparator(hit.snapshot.comparator),
              value: formatNumber(hit.snapshot.value),
              unit: hit.snapshot.unit,
            });
          case 'out_of_reference':
            return t(`twin.basis.outOfReference.${hit.snapshot.abnormal}`, {
              range: range(hit.snapshot.refLow, hit.snapshot.refHigh) ?? '',
            });
          case 'threshold':
            return t('twin.basis.threshold', {
              days: hit.snapshot.windowDays,
              comparator: comparator(hit.snapshot.comparator),
              value: formatNumber(hit.snapshot.value),
              unit: hit.snapshot.unit,
            });
          case 'observation_count':
            return t('twin.basis.observationCount', { count: hit.snapshot.minCount });
        }
      };
      const parts = item.hits.map(hitText);
      if (item.source === 'report' && item.noReference) parts.push(t('twin.basis.noReference'));
      if (parts.length === 0) parts.push(t('twin.basis.noHit'));
      return [head, ...parts].join(t('twin.basis.separator'));
    },
    [t, metricName, range, comparator],
  );
}
