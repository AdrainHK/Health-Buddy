import type { ExpertConsultation, TaskStep } from '@health-buddy/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExpertCallView } from '../chat/conversation';
import { useExpertName, useExpertNames } from './ExpertsContext';
import styles from './Experts.module.css';
import { useCallStatusLabel, useRoutingReasonLabel } from './labels';

/** 一条回答里和专家有关的信息：每位专家的实时状态、调用结束后的详情 */
export interface ExpertStepContext {
  calls: Record<string, ExpertCallView> | undefined;
  consultation: ExpertConsultation | undefined;
  /** 打开结果区的专家标签看原始意见 */
  onOpenExperts?: (consultationId: string | null) => void;
}

const EXPERT_KINDS: readonly TaskStep['kind'][] = [
  'route_experts',
  'consult_expert',
  'consult_experts',
  'synthesize_experts',
];

export const isExpertStep = (step: TaskStep): boolean => EXPERT_KINDS.includes(step.kind);

/** 10 分钟内同样的请求沿用上次的专家意见（规格 3.7）：“沿用 10:32 的专家意见” */
export const isRecentReuseStep = (step: TaskStep): boolean =>
  step.labelKey === 'steps.reuseRecentExperts';

/** “退回重写沿用上一版的专家意见”、10 分钟内沿用上次的意见也是专家步骤，但用自己的文案 */
const isReuse = (step: TaskStep) =>
  step.labelKey === 'steps.reuseExperts' || isRecentReuseStep(step);

export const isConsultStep = (step: TaskStep): boolean =>
  (step.kind === 'consult_expert' || step.kind === 'consult_experts') && !isReuse(step);

/**
 * 专家步骤的文案（规格 2.6）：正在选择专家 → 已选择 3 位专家；正在请……分析 → 已调用：……；
 * 正在汇总专家意见 → 已汇总，有 1 处分歧。不是专家步骤、或沿用意见时返回 null，用步骤自己的 labelKey。
 */
export function useExpertStepLabel(): (
  step: TaskStep,
  consultation: ExpertConsultation | undefined,
) => string | null {
  const { t, i18n } = useTranslation();
  const names = useExpertNames();
  return useCallback(
    (step: TaskStep, consultation: ExpertConsultation | undefined) => {
      if (isRecentReuseStep(step)) {
        if (!step.labelTime) return null;
        const time = new Date(step.labelTime).toLocaleTimeString(i18n.language, {
          hour: '2-digit',
          minute: '2-digit',
        });
        return t('experts.steps.reusedAt', { time });
      }
      switch (step.kind) {
        case 'route_experts':
          if (step.status === 'running') return t('experts.steps.routing');
          return consultation
            ? t('experts.steps.routed', { count: consultation.routing.selected.length })
            : null;
        case 'consult_expert':
        case 'consult_experts': {
          if (isReuse(step)) return null;
          const list = names(step.expertIds);
          if (step.status === 'running') return t('experts.steps.consulting', { names: list });
          if (step.status === 'failed') return t('experts.steps.consultFailed', { names: list });
          return t('experts.steps.consulted', { names: list });
        }
        case 'synthesize_experts': {
          if (step.status === 'running') return t('experts.steps.synthesizing');
          if (step.status === 'failed') return t('experts.steps.synthesisFailed');
          const count = consultation?.synthesis?.disagreements.length ?? 0;
          return count > 0
            ? t('experts.steps.synthesizedWith', { count })
            : t('experts.steps.synthesized');
        }
        default:
          return null;
      }
    },
    [t, i18n.language, names],
  );
}

/** 专家步骤展开后的内容：选中原因、每位专家的状态、分歧话题 */
export function ExpertStepDetail({
  step,
  context,
}: {
  step: TaskStep;
  context: ExpertStepContext;
}) {
  const { t } = useTranslation();
  const name = useExpertName();
  const statusLabel = useCallStatusLabel();
  const reasonLabel = useRoutingReasonLabel();
  const { consultation, calls, onOpenExperts } = context;

  if (step.kind === 'route_experts') {
    if (!consultation) return null;
    const { routing } = consultation;
    return (
      <ul className={styles.callList}>
        {routing.selected.map((s) => (
          <li key={s.expertId} className={styles.callItem}>
            {t('experts.routing.selected', {
              name: name(s.expertId),
              reasons: s.reasons.map(reasonLabel).join(t('experts.separator')),
            })}
          </li>
        ))}
        {routing.excluded.map((id) => (
          <li key={`x-${id}`} className={styles.callItem}>
            {t('experts.routing.excluded', { name: name(id) })}
          </li>
        ))}
        {routing.overCap.map((id) => (
          <li key={`c-${id}`} className={styles.callItem}>
            {t('experts.routing.overCap', { name: name(id) })}
          </li>
        ))}
        {routing.ruleOnly && <li className={styles.callItem}>{t('experts.routing.ruleOnly')}</li>}
      </ul>
    );
  }

  if (isConsultStep(step)) {
    const anyDone = step.expertIds.some((id) => calls?.[id]?.status === 'done');
    return (
      <ul className={styles.callList} aria-label={t('experts.title')}>
        {step.expertIds.map((id) => {
          const call = calls?.[id];
          return (
            <li
              key={id}
              className={styles.callItem}
              data-status={call?.status ?? 'running'}
              data-testid={`expert-call-${id}`}
            >
              {t('experts.call.item', { name: name(id), status: statusLabel(call) })}
            </li>
          );
        })}
        {anyDone && onOpenExperts && (
          <li className={styles.callItem}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => onOpenExperts(consultation?.id ?? null)}
            >
              {t('experts.steps.viewOpinions')}
            </button>
          </li>
        )}
      </ul>
    );
  }

  if (step.kind === 'synthesize_experts' && consultation?.synthesis?.disagreements.length) {
    return (
      <ul className={styles.callList}>
        {consultation.synthesis.disagreements.map((d, i) => (
          <li key={i} className={styles.callItem}>
            {d.topic}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}
