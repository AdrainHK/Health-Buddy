import type { RoutingReason } from '@health-buddy/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExpertCallView } from '../chat/conversation';
import { useDynamicT } from '../i18n/dynamic';

/** 每位专家的状态：进行中、已回复、未能按时回复、暂时无法回复（带原因类别）、已停止 */
export function useCallStatusLabel(): (call: ExpertCallView | undefined) => string {
  const { t } = useTranslation();
  return useCallback(
    (call: ExpertCallView | undefined) => {
      if (!call) return t('experts.call.pending');
      const status = t(`experts.call.status.${call.status}`);
      if (!call.failureCategory || call.status === 'done') return status;
      return t('experts.call.withFailure', {
        status,
        category: t(`experts.call.failure.${call.failureCategory}`),
      });
    },
    [t],
  );
}

/** 选中专家的原因类别（规格 2.6 展开后显示） */
export function useRoutingReasonLabel(): (reason: RoutingReason) => string {
  const { t } = useTranslation();
  const dt = useDynamicT();
  return useCallback(
    (reason: RoutingReason) => {
      switch (reason.kind) {
        case 'manager':
          return t('experts.reasons.manager');
        case 'bound':
          return t('experts.reasons.bound');
        case 'model':
          return t(`experts.reasons.model.${reason.category}`);
        case 'indicator':
          return t('experts.reasons.indicator', {
            indicator: reason.code
              ? dt(`indicators.${reason.code}`, t('experts.reasons.someIndicator'))
              : t('experts.reasons.someIndicator'),
            direction: t(`experts.reasons.direction.${reason.direction}`),
          });
      }
    },
    [t, dt],
  );
}
