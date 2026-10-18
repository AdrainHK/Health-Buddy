import { EXPERTS_PER_CALL_MAX, type ExpertConsultation } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { RefreshCw, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDynamicT } from '../i18n/dynamic';
import { addConsultationExpert, reconsultExperts } from '../api/experts';
import { ApiError, isAbortError } from '../api/http';
import type { StreamOptions } from '../api/stream';
import { useExpertName, useExperts } from './ExpertsContext';
import styles from './Experts.module.css';
import { ExpertSelector } from './ExpertSelector';

/** 直接请专家的调用（@专家、专家中心、补请）：重新请时同样直接请这几位，不经过自动选择 */
export function isDirectConsultation(c: ExpertConsultation): boolean {
  return (
    c.origin?.kind === 'add_expert' || c.trigger === 'mention' || c.trigger === 'expert_center'
  );
}

type State =
  { kind: 'idle' } | { kind: 'running' } | { kind: 'done' } | { kind: 'failed'; key: string };

/** 接口拒绝或流里的错误 → 提示文案的键（只有类别，不带任何资料） */
function failureKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'network') return 'network';
  if (err.status === 429) return 'tooMany';
  if (err.status === 404) return 'notFound';
  if (err.status === 400) return 'badRequest';
  if (err.status === 409) {
    if (err.reasons.includes('read_only')) return 'readOnly';
    if (err.reasons.includes('busy')) return 'busy';
    if (err.reasons.includes('source_report_unavailable')) return 'reportUnavailable';
    return 'conflict';
  }
  return 'unknown';
}

export interface ConsultationFollowUpProps {
  consultation: ExpertConsultation;
  /** 任务只读（客户转出）或正在生成时不能重新请 */
  disabled: boolean;
  /** 跑完一轮（新的调用记录和对话里的新回答都已保存）：刷新专家标签和对话 */
  onDone: () => void;
}

/**
 * 专家标签里一次调用的后续操作（M3 规格 2.5、2.6、6.4）：
 * - “重新请专家”：可以调整要请的专家（直接请的调用选专家；自动选择的调用选“一定要请”“不要请”），
 *   生成新的调用记录，计入今天的专家调用次数；回答写在对话区的一条新回答里；
 * - “也请这位”：补请因数量上限没请的专家，一位一次，同样计入今天的次数。
 * 草稿不会因此改变；要用新的意见重写草稿，请在草稿上“退回重写”并勾选“重新请专家”。
 */
export function ConsultationFollowUp({
  consultation: c,
  disabled,
  onDone,
}: ConsultationFollowUpProps) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const experts = useExperts();
  const name = useExpertName();
  const direct = isDirectConsultation(c);
  const available = experts.filter((e) => e.available);
  const availableIds = new Set(available.map((e) => e.id));
  const previousForced = c.routing.selected
    .filter((s) => direct || s.reasons.some((r) => r.kind === 'manager'))
    .map((s) => s.expertId)
    .filter((id) => availableIds.has(id));
  const [editing, setEditing] = useState(false);
  const [forced, setForced] = useState<string[]>(previousForced);
  const [excluded, setExcluded] = useState<string[]>(
    c.routing.excluded.filter((id) => availableIds.has(id)),
  );
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const overCap = c.routing.overCap.filter((id) => availableIds.has(id));
  const busy = state.kind === 'running';

  const run = async (
    open: (options: Omit<StreamOptions, 'body'>) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'running' });
    let streamError: string | null = null;
    let opened = false;
    try {
      await open({
        signal: controller.signal,
        onOpen: () => {
          opened = true;
        },
        onEvent: (event) => {
          if (event.type === 'error') streamError = event.kind;
        },
      });
      setEditing(false);
      setState(streamError ? { kind: 'failed', key: `stream.${streamError}` } : { kind: 'done' });
      onDone();
    } catch (err) {
      if (isAbortError(err)) return;
      setState({ kind: 'failed', key: failureKey(err) });
      // 流打开后断开：后端可能已经保存了这一轮的部分内容
      if (opened) onDone();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const submitReconsult = () =>
    void run((options) =>
      reconsultExperts(c.id, direct ? { forced } : { forced, excluded }, options),
    );

  const submitAdd = (expertId: string) =>
    void run((options) => addConsultationExpert(c.id, expertId, options));

  const toggle = (id: string) =>
    setForced((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <div className={styles.block} data-testid="consultation-follow-up">
      {overCap.length > 0 && (
        <div className={styles.feedback} role="group" aria-label={t('experts.followUp.overCap')}>
          <span>{t('experts.followUp.overCap')}</span>
          {overCap.map((id) => (
            <Button
              key={id}
              variant="ghost"
              icon={<UserPlus size={14} />}
              disabled={disabled || busy}
              onClick={() => submitAdd(id)}
            >
              {t('experts.followUp.add', { name: name(id) })}
            </Button>
          ))}
        </div>
      )}
      {!editing ? (
        <div className={styles.actions}>
          <Button
            variant="ghost"
            icon={<RefreshCw size={14} />}
            disabled={disabled || busy || available.length === 0}
            onClick={() => {
              setForced(previousForced);
              setExcluded(c.routing.excluded.filter((id) => availableIds.has(id)));
              setState({ kind: 'idle' });
              setEditing(true);
            }}
          >
            {t('experts.followUp.reconsult')}
          </Button>
        </div>
      ) : (
        <div
          className={styles.block}
          role="group"
          aria-label={t('experts.followUp.reconsultTitle')}
        >
          <p className={styles.blockTitle}>{t('experts.followUp.reconsultTitle')}</p>
          {direct ? (
            <fieldset className={styles.reasons}>
              <legend>{t('experts.followUp.chooseExperts', { max: EXPERTS_PER_CALL_MAX })}</legend>
              {available.map((e) => (
                <label key={e.id} className={styles.choiceOption}>
                  <input
                    type="checkbox"
                    checked={forced.includes(e.id)}
                    disabled={
                      busy || (!forced.includes(e.id) && forced.length >= EXPERTS_PER_CALL_MAX)
                    }
                    onChange={() => toggle(e.id)}
                  />
                  {e.name}
                </label>
              ))}
            </fieldset>
          ) : (
            <ExpertSelector
              experts={available}
              included={forced}
              excluded={excluded}
              maxIncluded={EXPERTS_PER_CALL_MAX}
              disabled={busy}
              onChange={(inc, exc) => {
                setForced(inc);
                setExcluded(exc);
              }}
            />
          )}
          <p className={styles.note}>{t('experts.followUp.usageNote')}</p>
          {!direct && <p className={styles.note}>{t('experts.followUp.draftNote')}</p>}
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={disabled || busy || (direct && forced.length === 0)}
              onClick={submitReconsult}
            >
              {t('experts.followUp.submit')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t('experts.followUp.cancel')}
            </Button>
          </div>
        </div>
      )}
      {state.kind === 'running' && (
        <p className={styles.note} role="status">
          {t('experts.followUp.running')}
        </p>
      )}
      {state.kind === 'done' && (
        <p className={styles.note} role="status">
          {t('experts.followUp.done')}
        </p>
      )}
      {state.kind === 'failed' && (
        <p className={styles.alert} role="alert">
          {state.key.startsWith('stream.')
            ? dt(
                `chat.streamErrors.${state.key.slice('stream.'.length)}`,
                t('experts.followUp.errors.unknown'),
              )
            : dt(`experts.followUp.errors.${state.key}`, t('experts.followUp.errors.unknown'))}
        </p>
      )}
    </div>
  );
}
