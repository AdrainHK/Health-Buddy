import type {
  Citation,
  ExpertCall,
  ExpertCard,
  ExpertConsultation,
  ExpertDetail,
  ExpertFeedbackRequest,
  ExpertOpinion,
  Synthesis,
} from '@health-buddy/shared';
import { Button, EmptyState } from '@health-buddy/ui';
import { Stethoscope, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getExpert, setExpertFeedback } from '../api/experts';
import { ConsultationFollowUp } from './ConsultationFollowUp';
import { AiBadge } from './ExpertBadges';
import { useExpertName, useExpertNames } from './ExpertsContext';
import styles from './Experts.module.css';
import { useCallStatusLabel } from './labels';
import { consultationSignals, SignalAlerts, SignalBadges } from './SignalAlerts';

export interface ConsultationListState {
  status: 'loading' | 'ready' | 'error';
  consultations: ExpertConsultation[];
}

export interface ExpertsTabProps {
  state: ConsultationListState;
  onRetry: () => void;
  /** 要展开的那次调用（对话区里点了“查看专家意见”）；为空时展开最新的一次 */
  focusId?: string | null;
  /** 任务只读（客户转出）：意见仍可查看，不能重新请专家或补请 */
  readOnly?: boolean;
  /**
   * 重新请专家、补请专家跑完一轮（规格 6.4）：刷新专家标签和对话。
   * 不传时不显示这两个操作
   */
  onFollowUpDone?: () => void;
}

/** 卡片要点按（专家，卡片编号）查：编号只在一位专家内唯一（规格 5.2 第 1 条） */
type CardIndex = Record<string, ReadonlyMap<string, ExpertCard> | null>;

/**
 * 结果区的专家标签（M3 规格 2.7）：按时间倒序列出本任务的每次专家调用。
 * 专家意见只给健管师看：没有复制、导出或任何发给客户的入口（Q9、规格 7.2 第 1 条）。
 */
export function ExpertsTab({
  state,
  onRetry,
  focusId = null,
  readOnly = false,
  onFollowUpDone,
}: ExpertsTabProps) {
  const { t } = useTranslation();
  const cards = useCardIndex(state.consultations);

  if (state.status === 'loading' && state.consultations.length === 0) {
    return (
      <p className={styles.status} role="status">
        {t('experts.tab.loading')}
      </p>
    );
  }
  if (state.status === 'error' && state.consultations.length === 0) {
    return (
      <div className={styles.tab} role="alert">
        <p className={styles.text}>{t('experts.tab.loadFailed')}</p>
        <div>
          <Button onClick={onRetry}>{t('experts.tab.retry')}</Button>
        </div>
      </div>
    );
  }
  if (state.consultations.length === 0) {
    return <EmptyState icon={<Stethoscope size={20} />} title={t('experts.tab.empty')} />;
  }
  const sorted = [...state.consultations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const openId = focusId ?? sorted[0]?.id;
  return (
    <div className={styles.tab}>
      <ol className={styles.selectorList} aria-label={t('experts.tab.list')}>
        {sorted.map((c) => (
          <li key={c.id}>
            <ConsultationCard
              key={`${c.id}:${c.id === openId ? 'open' : 'closed'}`}
              consultation={c}
              cards={cards}
              defaultOpen={c.id === openId}
              readOnly={readOnly}
              {...(onFollowUpDone ? { onFollowUpDone } : {})}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 取参与过的专家的条目卡片，用来显示引用的要点；取不到（已暂停）时引用只显示编号 */
function useCardIndex(consultations: readonly ExpertConsultation[]): CardIndex {
  const [index, setIndex] = useState<CardIndex>({});
  const requested = useRef(new Set<string>());
  const ids = [...new Set(consultations.flatMap((c) => c.calls.map((call) => call.expertId)))];
  const key = ids.sort().join(',');
  useEffect(() => {
    for (const id of key ? key.split(',') : []) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      getExpert(id)
        .then((detail: ExpertDetail) =>
          setIndex((i) => ({ ...i, [id]: new Map(detail.cards.map((c) => [c.cardId, c])) })),
        )
        .catch(() => setIndex((i) => ({ ...i, [id]: null })));
    }
  }, [key]);
  return index;
}

function ConsultationCard({
  consultation: c,
  cards,
  defaultOpen,
  readOnly,
  onFollowUpDone,
}: {
  consultation: ExpertConsultation;
  cards: CardIndex;
  defaultOpen: boolean;
  readOnly: boolean;
  onFollowUpDone?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const names = useExpertNames();
  const time = new Date(c.createdAt).toLocaleString(i18n.language, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const signals = consultationSignals(c);
  // 有危机或急症信号的调用一律默认展开，收起时标题里也有醒目标记（合规审查第 3 条）
  const open = defaultOpen || signals.crisis || signals.emergency;
  return (
    <details className={styles.consultation} open={open} data-testid="consultation">
      <summary>
        {(signals.crisis || signals.emergency) && (
          <span className={styles.signalBadges}>
            <SignalBadges {...signals} />
          </span>
        )}
        <span className={styles.consultationTitle}>
          {t('experts.tab.callTitle', { trigger: t(`experts.trigger.${c.trigger}`), time })}
        </span>
        <span className={styles.callStatus}>
          {t('experts.tab.experts', { names: names(c.calls.map((call) => call.expertId)) })} ·{' '}
          {t(`experts.tab.status.${c.status}`)}
          {c.origin && <> · {t(`experts.tab.origin.${c.origin.kind}`)}</>}
          {c.reportCorrectedSince && <> · {t('experts.tab.correctedBadge')}</>}
        </span>
      </summary>
      <div className={styles.consultationBody}>
        <SignalAlerts {...signals} />
        {c.reportCorrectedSince && (
          <p className={styles.warn} role="note" data-testid="report-corrected">
            {t('experts.tab.reportCorrected')}
          </p>
        )}
        <SynthesisView consultation={c} cards={cards} />
        <section className={styles.block} aria-label={t('experts.tab.opinions')}>
          <h4 className={styles.blockTitle}>{t('experts.tab.opinions')}</h4>
          {c.calls.map((call) => (
            <CallView key={call.id} call={call} cards={cards[call.expertId]} />
          ))}
        </section>
        <p className={styles.note}>{t('experts.tab.note')}</p>
        {onFollowUpDone && c.status !== 'running' && (
          <ConsultationFollowUp consultation={c} disabled={readOnly} onDone={onFollowUpDone} />
        )}
      </div>
    </details>
  );
}

function SynthesisView({
  consultation: c,
  cards,
}: {
  consultation: ExpertConsultation;
  cards: CardIndex;
}) {
  const { t } = useTranslation();
  const name = useExpertName();
  const names = useExpertNames();
  const synthesis: Synthesis | null = c.synthesis;
  if (!synthesis) return null;
  const failed = c.synthesisStatus === 'failed';
  const hasSummary =
    synthesis.consensus.length > 0 ||
    synthesis.referrals.length > 0 ||
    synthesis.followUpPoints.length > 0 ||
    synthesis.missingExperts.length > 0;
  return (
    <>
      {failed && (
        <p className={styles.warn} role="note">
          {t('experts.tab.synthesisFailed')}
        </p>
      )}
      {hasSummary && (
        <section className={styles.block} aria-label={t('experts.tab.summary')}>
          <h4 className={styles.blockTitle}>{t('experts.tab.summary')}</h4>
          {synthesis.consensus.length > 0 && (
            <>
              <p className={styles.text}>{t('experts.tab.consensus')}</p>
              <ul className={styles.items}>
                {synthesis.consensus.map((item, i) => (
                  <li key={i}>
                    {t('experts.tab.consensusItem', {
                      point: item.point,
                      names: names(item.experts),
                    })}
                    <Citations
                      citations={item.citations}
                      lookup={(cardId) => lookupAny(cards, item.experts, cardId)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          {synthesis.referrals.length > 0 && (
            <>
              <p className={styles.text}>{t('experts.tab.referral')}</p>
              <ul className={styles.items}>
                {synthesis.referrals.map((r, i) => (
                  <li key={i}>
                    {t('experts.tab.referralItem', {
                      name: name(r.expertId),
                      urgency: t(`experts.tab.urgency.${r.urgency ?? 'attention'}`),
                    })}
                    {r.to && (
                      <span className={styles.sub}>
                        {t('experts.tab.referralTo', { to: r.to })}
                      </span>
                    )}
                    {r.reason && (
                      <span className={styles.sub}>
                        {t('experts.tab.referralReason', { reason: r.reason })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {synthesis.followUpPoints.length > 0 && (
            <>
              <p className={styles.text}>{t('experts.tab.followUp')}</p>
              <ul className={styles.items}>
                {synthesis.followUpPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {synthesis.missingExperts.length > 0 && (
            <p className={styles.text}>
              {t('experts.tab.missing', { names: names(synthesis.missingExperts) })}
            </p>
          )}
        </section>
      )}
      {synthesis.disagreements.length > 0 && (
        <section
          className={`${styles.block} ${styles.warn}`}
          aria-label={t('experts.tab.disagreements', { count: synthesis.disagreements.length })}
        >
          <h4 className={styles.blockTitle}>
            {t('experts.tab.disagreements', { count: synthesis.disagreements.length })}
          </h4>
          <p className={styles.note}>{t('experts.tab.disagreementNote')}</p>
          {synthesis.disagreements.map((d, i) => (
            <div key={i} className={styles.block}>
              <p className={styles.text}>
                <strong>{d.topic}</strong>
              </p>
              {d.generatedByBackend && (
                <p className={styles.note}>{t('experts.tab.backendGenerated')}</p>
              )}
              <ul className={styles.items}>
                {d.positions.map((p, j) => (
                  <li key={j}>
                    {t('experts.tab.position', { name: name(p.expertId), view: p.view })}
                    <Citations
                      citations={p.citations}
                      lookup={(cardId) => cards[p.expertId]?.get(cardId)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** 汇总的共识：都确认了才不标“来源待确认”，所以要找到每位引用了这张卡片的专家的卡片 */
function lookupAny(
  cards: CardIndex,
  experts: readonly string[],
  cardId: string,
): ExpertCard | undefined {
  const found = experts.map((id) => cards[id]?.get(cardId));
  if (found.length === 0 || found.some((c) => c === undefined)) return undefined;
  return found.find((c) => c && !c.confirmed) ?? found[0];
}

function CallView({
  call,
  cards,
}: {
  call: ExpertCall;
  cards: ReadonlyMap<string, ExpertCard> | null | undefined;
}) {
  const { t } = useTranslation();
  const name = useExpertName();
  const statusLabel = useCallStatusLabel();
  return (
    <article className={styles.opinion} aria-label={name(call.expertId)}>
      <div className={styles.opinionHead}>
        {name(call.expertId)}
        <AiBadge />
        <span className={styles.callStatus} data-status={call.status}>
          {statusLabel(call)}
        </span>
      </div>
      {call.opinion && <OpinionView opinion={call.opinion} cards={cards} />}
      {call.removedFindings > 0 && <p className={styles.note}>{t('experts.tab.removed')}</p>}
      {call.status === 'done' && call.opinion && <Feedback call={call} />}
    </article>
  );
}

function OpinionView({
  opinion: o,
  cards,
}: {
  opinion: ExpertOpinion;
  cards: ReadonlyMap<string, ExpertCard> | null | undefined;
}) {
  const { t } = useTranslation();
  const lookup = (cardId: string) => cards?.get(cardId);
  if (!o.inScope) {
    return (
      <>
        <SignalAlerts crisis={o.crisisSignal} emergency={o.emergencySignal} />
        <p className={styles.text}>{o.outOfScopeNote ?? t('experts.tab.outOfScope')}</p>
      </>
    );
  }
  const r = o.referral;
  return (
    <>
      <SignalAlerts crisis={o.crisisSignal} emergency={o.emergencySignal} />
      <div className={styles.block}>
        <p className={styles.blockTitle}>{t('experts.tab.conclusion')}</p>
        <p className={styles.text}>{o.summary}</p>
      </div>
      {o.findings.length > 0 && (
        <div className={styles.block}>
          <p className={styles.blockTitle}>{t('experts.tab.findings')}</p>
          <ul className={styles.items}>
            {o.findings.map((f, i) => {
              const data = f.dataRefs
                .map((d) => [d.label, d.value, d.date].filter(Boolean).join(' '))
                .join(t('experts.separator'));
              return (
                <li key={i}>
                  {f.point}
                  {data && (
                    <span className={styles.sub}>{t('experts.tab.dataRefs', { data })}</span>
                  )}
                  {f.basis === 'data_only' && (
                    <span className={styles.sub}>{t('experts.tab.dataOnly')}</span>
                  )}
                  <Citations citations={f.citations} lookup={lookup} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {o.suggestions.length > 0 && (
        <div className={styles.block}>
          <p className={styles.blockTitle}>{t('experts.tab.suggestions')}</p>
          <ul className={styles.items}>
            {o.suggestions.map((s, i) => (
              <li key={i}>
                {s.text}
                <span className={styles.sub}>
                  {t(`experts.tab.suggestionCategory.${s.category}`)}
                </span>
                <Citations citations={s.citations} lookup={lookup} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.questionsToAsk.length > 0 && (
        <div className={styles.block}>
          <p className={styles.blockTitle}>{t('experts.tab.questions')}</p>
          <ul className={styles.items}>
            {o.questionsToAsk.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {o.dataGaps.length > 0 && (
        <div className={styles.block}>
          <p className={styles.blockTitle}>{t('experts.tab.gaps')}</p>
          <ul className={styles.items}>
            {o.dataGaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.block}>
        <p className={styles.blockTitle}>{t('experts.tab.referral')}</p>
        <p className={styles.text}>
          {r.needed
            ? t('experts.tab.referralNeeded', {
                urgency: t(`experts.tab.urgency.${r.urgency ?? 'attention'}`),
              })
            : t('experts.tab.referralNone')}
          {r.needed && r.to && (
            <span className={styles.sub}>{t('experts.tab.referralTo', { to: r.to })}</span>
          )}
          {r.needed && r.reason && (
            <span className={styles.sub}>
              {t('experts.tab.referralReason', { reason: r.reason })}
            </span>
          )}
        </p>
      </div>
    </>
  );
}

/**
 * 引用：卡片编号，点开显示来源、章节和要点（规格 2.3 第 5 条）。
 * 医学顾问还没确认的卡片标“来源待确认”（规格 5.2 第 1 条）；卡片取不到时也按待确认处理。
 */
function Citations({
  citations,
  lookup,
}: {
  citations: readonly Citation[];
  lookup: (cardId: string) => ExpertCard | undefined;
}) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const baseId = useId();
  if (citations.length === 0) return null;
  const open = openId ? citations.find((c) => c.cardId === openId) : undefined;
  const openCard = open ? lookup(open.cardId) : undefined;
  return (
    <>
      <span className={styles.citations}>
        {citations.map((c) => {
          const card = lookup(c.cardId);
          const pending = !card?.confirmed;
          const expanded = openId === c.cardId;
          return (
            <button
              key={c.cardId}
              type="button"
              className={styles.citation}
              aria-expanded={expanded}
              aria-controls={`${baseId}-card`}
              aria-label={t('experts.tab.citationLabel', { cardId: c.cardId })}
              onClick={() => setOpenId(expanded ? null : c.cardId)}
            >
              {c.cardId}
              {pending && (
                <span className={styles.unconfirmed}> {t('experts.tab.citationPending')}</span>
              )}
            </button>
          );
        })}
      </span>
      {open && (
        <span id={`${baseId}-card`} className={`${styles.sub} ${styles.citationCard}`}>
          {openCard ? (
            <>
              {t('experts.tab.cardSource', {
                sourceId: openCard.sourceId,
                section: openCard.section,
              })}
              <br />
              {openCard.point}
            </>
          ) : (
            t('experts.tab.cardUnknown', { sourceId: open.sourceId })
          )}
        </span>
      )}
    </>
  );
}

type FeedbackValue = NonNullable<ExpertCall['feedback']>;
type FeedbackReason = NonNullable<FeedbackValue['reason']>;
const REASONS: readonly FeedbackReason[] = [
  'inaccurate',
  'too_general',
  'out_of_scope',
  'bad_citation',
  'other',
];

/** 有用/没用（Q14）：选“没用”时选原因类别，不收集自由文字；可以改 */
function Feedback({ call }: { call: ExpertCall }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<FeedbackValue | null>(call.feedback);
  const [choosing, setChoosing] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | null>(call.feedback?.reason ?? null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const name = useId();

  const save = async (body: ExpertFeedbackRequest) => {
    setState('saving');
    try {
      await setExpertFeedback(call.id, body);
      setCurrent({ rating: body.rating, reason: body.reason ?? null });
      setChoosing(false);
      setState('saved');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className={styles.block}>
      <div className={styles.feedback} role="group" aria-label={t('experts.feedback.label')}>
        <span>{t('experts.feedback.label')}</span>
        <Button
          variant="ghost"
          icon={<ThumbsUp size={14} />}
          aria-pressed={current?.rating === 'useful'}
          disabled={state === 'saving'}
          onClick={() => void save({ rating: 'useful', reason: null })}
        >
          {t('experts.feedback.useful')}
        </Button>
        <Button
          variant="ghost"
          icon={<ThumbsDown size={14} />}
          aria-pressed={current?.rating === 'not_useful'}
          aria-expanded={choosing}
          disabled={state === 'saving'}
          onClick={() => setChoosing((c) => !c)}
        >
          {t('experts.feedback.notUseful')}
        </Button>
      </div>
      {choosing && (
        <fieldset className={styles.reasons}>
          <legend>{t('experts.feedback.reasonLegend')}</legend>
          {REASONS.map((r) => (
            <label key={r} className={styles.choiceOption}>
              <input
                type="radio"
                name={name}
                checked={reason === r}
                onChange={() => setReason(r)}
              />
              {t(`experts.feedback.reasons.${r}`)}
            </label>
          ))}
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={reason === null || state === 'saving'}
              onClick={() => reason && void save({ rating: 'not_useful', reason })}
            >
              {t('experts.feedback.submit')}
            </Button>
            <Button variant="ghost" onClick={() => setChoosing(false)}>
              {t('experts.feedback.cancel')}
            </Button>
          </div>
        </fieldset>
      )}
      {current && !choosing && (
        <p className={styles.note}>
          {current.rating === 'useful'
            ? t('experts.feedback.currentUseful')
            : t('experts.feedback.currentNotUseful', {
                reason: current.reason ? t(`experts.feedback.reasons.${current.reason}`) : '',
              })}
        </p>
      )}
      {state === 'saved' && (
        <p className={styles.note} role="status">
          {t('experts.feedback.saved')}
        </p>
      )}
      {state === 'failed' && (
        <p className={styles.alert} role="alert">
          {t('experts.feedback.failed')}
        </p>
      )}
      <p className={styles.note}>{t('experts.feedback.note')}</p>
    </div>
  );
}
