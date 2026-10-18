import { Button } from '@health-buddy/ui';
import type { ClientSummary, TaskPlan, TaskStep } from '@health-buddy/shared';
import {
  AtSign,
  Check,
  CircleAlert,
  FileText,
  Loader,
  OctagonX,
  Slash,
  Sparkles,
  Stethoscope,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useExpertName } from '../experts/ExpertsContext';
import {
  ExpertStepDetail,
  type ExpertStepContext,
  isConsultStep,
  isExpertStep,
  useExpertStepLabel,
} from '../experts/ExpertSteps';
import { useSkillName, useStepLabel } from '../i18n/dynamic';
import type { Conversation, ViewMessage } from './conversation';
import styles from './MessageList.module.css';

export interface MessageListProps {
  conversation: Conversation;
  clients: ClientSummary[];
  /** 已核对报告的日期（显示 @ 的报告） */
  reportDates?: ReadonlyMap<string, string>;
  /** 只读任务或正在生成时，计划不能确认 */
  canConfirm: boolean;
  onConfirmPlan: (plan: TaskPlan) => void;
  onUseSkill: (skillId: string) => void;
  /** 执行步骤里点“查看专家意见”：打开结果区的专家标签 */
  onOpenExperts?: (consultationId: string | null) => void;
}

/** 对话消息流：健管师消息、AI 回答、执行步骤、计划、技能建议和草稿提示 */
export function MessageList({
  conversation,
  clients,
  reportDates,
  canConfirm,
  onConfirmPlan,
  onUseSkill,
  onOpenExperts,
}: MessageListProps) {
  const { t } = useTranslation();
  return (
    <ol className={styles.list} aria-label={t('chat.messages')}>
      {conversation.messages.map((message) =>
        message.role === 'manager' ? (
          <ManagerMessage
            key={message.id}
            message={message}
            clients={clients}
            {...(reportDates ? { reportDates } : {})}
          />
        ) : (
          <AssistantMessage
            key={message.id}
            message={message}
            steps={conversation.steps.filter((s) => s.messageId === message.id)}
            plans={conversation.plans.filter((p) => p.messageId === message.id)}
            expert={{
              calls: conversation.expertCalls[message.id],
              consultation: conversation.consultations[message.id],
              ...(onOpenExperts ? { onOpenExperts } : {}),
            }}
            canConfirm={canConfirm}
            onConfirmPlan={onConfirmPlan}
            onUseSkill={onUseSkill}
          />
        ),
      )}
    </ol>
  );
}

function ManagerMessage({
  message,
  clients,
  reportDates,
}: {
  message: ViewMessage;
  clients: ClientSummary[];
  reportDates?: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  const expertName = useExpertName();
  const client = clients.find((c) => c.id === message.clientRefs[0]);
  const reportId = message.reportRefs?.[0];
  const reportDate = reportId ? reportDates?.get(reportId) : undefined;
  const experts = message.expertRefs ?? [];
  const excluded = message.excludedExperts ?? [];
  return (
    <li className={styles.manager} aria-label={t('chat.you')}>
      <div className={styles.bubble}>
        {(message.skillId || client || reportId || experts.length > 0 || excluded.length > 0) && (
          <div className={styles.tags}>
            {message.skillId && (
              <span className={styles.tag}>
                <Slash size={12} aria-hidden />
                {skillName(message.skillId)}
              </span>
            )}
            {client && (
              <span className={styles.tag}>
                <AtSign size={12} aria-hidden />
                {client.displayName}
              </span>
            )}
            {reportId && (
              <span className={styles.tag}>
                <FileText size={12} aria-hidden />
                {reportDate ? t('chat.reportOption', { date: reportDate }) : t('chat.reportRef')}
              </span>
            )}
            {experts.map((id) => (
              <span key={id} className={styles.tag}>
                <Stethoscope size={12} aria-hidden />
                {expertName(id)}
              </span>
            ))}
            {excluded.map((id) => (
              <span key={`x-${id}`} className={styles.tag}>
                {t('chat.experts.excludedTag', { name: expertName(id) })}
              </span>
            ))}
          </div>
        )}
        {/* 不需要再写要求的技能可以空着发送（验收反馈 8），这时只显示技能和客户 */}
        {message.content && <p className={styles.text}>{message.content}</p>}
      </div>
    </li>
  );
}

function AssistantMessage({
  message,
  steps,
  plans,
  expert,
  canConfirm,
  onConfirmPlan,
  onUseSkill,
}: {
  message: ViewMessage;
  steps: TaskStep[];
  plans: TaskPlan[];
  expert: ExpertStepContext;
  canConfirm: boolean;
  onConfirmPlan: (plan: TaskPlan) => void;
  onUseSkill: (skillId: string) => void;
}) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  const streaming = message.status === 'streaming';
  return (
    <li className={styles.assistant} aria-label={t('chat.assistant')} aria-busy={streaming}>
      {steps.length > 0 && <StepList steps={steps} expert={expert} />}

      {message.content ? (
        <p className={styles.text} data-testid="assistant-text">
          {message.content}
        </p>
      ) : (
        streaming && (
          <p className={styles.pending} role="status">
            {t('chat.generating')}
          </p>
        )
      )}

      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          canConfirm={canConfirm}
          onConfirm={() => onConfirmPlan(plan)}
        />
      ))}

      {message.artifacts?.map((artifact) => (
        <p key={artifact.id} className={styles.artifact} role="status">
          <FileText size={14} aria-hidden />
          {t('chat.artifactDrafted')}
        </p>
      ))}

      {message.suggestion && (
        <Button
          className={styles.suggestion}
          icon={<Sparkles size={14} />}
          onClick={() => message.suggestion && onUseSkill(message.suggestion)}
        >
          {t('chat.suggestion', { name: skillName(message.suggestion) })}
        </Button>
      )}

      <MessageStatus message={message} />
    </li>
  );
}

function MessageStatus({ message }: { message: ViewMessage }) {
  const { t } = useTranslation();
  if (message.status === 'refused' || message.refused) {
    return (
      <p className={styles.warning} role="status">
        <CircleAlert size={14} aria-hidden />
        {t('chat.status.refused')}
      </p>
    );
  }
  if (message.status === 'error' || message.errorKind) {
    return (
      <p className={styles.error} role="alert">
        <OctagonX size={14} aria-hidden />
        {message.errorKind ? t(`chat.streamErrors.${message.errorKind}`) : t('chat.status.error')}
      </p>
    );
  }
  if (message.status === 'stopped') {
    return <p className={styles.muted}>{t('chat.status.stopped')}</p>;
  }
  return null;
}

function StepList({ steps, expert }: { steps: TaskStep[]; expert: ExpertStepContext }) {
  const { t } = useTranslation();
  const baseLabel = useStepLabel();
  const expertLabel = useExpertStepLabel();
  const stepLabel = (step: TaskStep) => expertLabel(step, expert.consultation) ?? baseLabel(step);
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const done = sorted.filter((s) => s.status === 'done').length;
  const running = sorted.some((s) => s.status === 'running');
  // 请了专家时，收起状态下也显示“已调用：内分泌与代谢专家、营养专家”（规格 2.6）
  const consult = sorted.find(isConsultStep);
  return (
    <details className={styles.steps} open={consult !== undefined}>
      <summary className={styles.stepsSummary}>
        {running ? (
          <Loader size={14} className={styles.spin} aria-hidden />
        ) : (
          <Check size={14} aria-hidden />
        )}
        {t('chat.steps.title')}
        <span className={styles.muted}>
          {t('chat.steps.progress', { done, total: sorted.length })}
        </span>
        {consult && <span className={styles.summaryExperts}>{stepLabel(consult)}</span>}
      </summary>
      <ul className={styles.stepList}>
        {sorted.map((step) => (
          <li key={step.id} className={styles.step} data-status={step.status}>
            {step.status === 'running' && <Loader size={14} className={styles.spin} aria-hidden />}
            {step.status === 'done' && <Check size={14} aria-hidden />}
            {step.status === 'failed' && <X size={14} aria-hidden />}
            <span className={styles.stepLabel}>{stepLabel(step)}</span>
            <span className={styles.visuallyHidden}>{t(`chat.steps.${step.status}`)}</span>
            {isExpertStep(step) && (
              <div className={styles.stepDetail}>
                <ExpertStepDetail step={step} context={expert} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PlanCard({
  plan,
  canConfirm,
  onConfirm,
}: {
  plan: TaskPlan;
  canConfirm: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  return (
    <section className={styles.plan} aria-label={t('chat.plan.title')}>
      <h3 className={styles.planTitle}>{t('chat.plan.title')}</h3>
      <ol className={styles.planSteps}>
        {plan.steps.map((step, index) => (
          <li key={index}>
            {step.kind === 'read_client'
              ? t('chat.plan.readClient')
              : t('chat.plan.runSkill', { name: skillName(step.skillId) })}
          </li>
        ))}
      </ol>
      {plan.status === 'proposed' ? (
        <Button variant="primary" onClick={onConfirm} disabled={!canConfirm}>
          {t('chat.plan.confirm')}
        </Button>
      ) : (
        <p className={styles.muted}>
          {plan.status === 'confirmed' ? t('chat.plan.confirmed') : t('chat.plan.revised')}
        </p>
      )}
    </section>
  );
}
