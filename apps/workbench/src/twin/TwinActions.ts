import {
  FORECAST_METRICS,
  type ClientSummary,
  type TwinDomain,
  type TwinRef,
} from '@health-buddy/shared';
import { createContext, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useExperts } from '../experts/ExpertsContext';
import { useMetricName } from './format';

/** “请专家看看”（M4 规格 2.6 之二）：针对哪位客户的哪个孪生项，从跟进项发起时带上跟进项 */
export interface TwinConsultRequest {
  client: Pick<ClientSummary, 'id' | 'displayName'>;
  ref: TwinRef;
  followUpItemId?: string;
}

/**
 * 孪生里通往对话区的操作（M4 第 4 步），由工作台外壳提供：打开或新建这位客户的任务，
 * 在输入框里预先填好。不提供时（如单独测试孪生视图）不显示这些按钮。
 */
export interface TwinActions {
  askExpert?: (request: TwinConsultRequest) => void;
  summarize?: (client: Pick<ClientSummary, 'id' | 'displayName'>) => void;
}

export const TwinActionsContext = createContext<TwinActions>({});

export function useTwinActions(): TwinActions {
  return useContext(TwinActionsContext);
}

/** “请专家看看”只在专家预览打开（有可用专家）时显示 */
export function useCanAskExpert(): boolean {
  const experts = useExperts();
  const { askExpert } = useTwinActions();
  return Boolean(askExpert) && experts.some((e) => e.available);
}

/** 孪生项的显示名，如“孪生 · 心血管”“孪生 · 收缩压趋势” */
export function useTwinRefLabel(): (ref: TwinRef) => string {
  const { t } = useTranslation();
  const metricName = useMetricName();
  return useCallback(
    (ref: TwinRef) =>
      ref.kind === 'domain'
        ? t('chat.twin.refDomain', {
            domain: t(`twin.domains.${ref.code as TwinDomain}`),
          })
        : t('chat.twin.refMetric', { metric: metricName(ref.code) }),
    [t, metricName],
  );
}

/** 跟进项对应的孪生项：有方面用方面，否则用做预测的指标 */
export function followUpTwinRef(item: {
  domain: string | null;
  metric: string | null;
}): TwinRef | null {
  if (item.domain) return { kind: 'domain', code: item.domain };
  if (item.metric && (FORECAST_METRICS as readonly string[]).includes(item.metric))
    return { kind: 'metric', code: item.metric };
  return null;
}
