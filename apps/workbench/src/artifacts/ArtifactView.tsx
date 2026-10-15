import {
  approveRejectionSchema,
  type ArtifactDetailResponse,
  type CriticalFlag,
  type ExportFormat,
  type TaskStep,
} from '@health-buddy/shared';
import { Button, IconButton } from '@health-buddy/ui';
import { ArrowLeft } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApproveRejectedError,
  approveArtifact,
  copyArtifactText,
  downloadBlob,
  exportArtifact,
  returnArtifact,
  reviseArtifact,
  updateArtifact,
} from '../api/artifacts';
import { isAbortError } from '../api/http';
import { useDynamicT, useSkillName } from '../i18n/dynamic';
import styles from './ArtifactView.module.css';
import { PlainMarkdown } from './PlainMarkdown';
import { type ArtifactErrorKey, classifyArtifactError } from './errors';
import {
  bannedTermMarks,
  criticalMarks,
  hintCriticalMarks,
  judgementMarks,
  segmentText,
  serverBannedMarks,
  type TextMark,
} from './textMarks';

const VIEWS = ['clientFacing', 'professional'] as const;
type View = (typeof VIEWS)[number];

const REJECT_REASONS: readonly string[] = approveRejectionSchema.shape.reasons.element.options;
type RejectReason = (typeof approveRejectionSchema.shape.reasons.element.options)[number];

const RETURN_REASON_MAX = 500;

/** 确认被拒绝时的信息。text 是当时的通俗版，文字改过后位置就不再适用。 */
interface Rejection {
  reasons: string[];
  bannedTerms: { term: string; index: number }[];
  criticalValueMentions: { metric: string; index: number }[];
  text: string;
}

type Notice =
  | { kind: 'stale' }
  | { kind: 'error'; key: ArtifactErrorKey | 'copyFailed' }
  | { kind: 'saved' }
  | { kind: 'approved' }
  | { kind: 'copied' }
  | { kind: 'exported'; filename: string }
  | { kind: 'revised' };

type Busy = 'save' | 'approve' | 'copy' | 'png' | 'pdf' | 'revise' | 'return' | null;

interface ReturnProgress {
  steps: TaskStep[];
  error?: string;
}

export interface ArtifactViewProps {
  detail: ArtifactDetailResponse;
  /** 任务只读（客户已转出或删除）：所有操作禁用 */
  readOnly: boolean;
  /** 接口返回了新的详情（保存、确认之后） */
  onDetail: (detail: ArtifactDetailResponse) => void;
  /** 重新加载当前产物（版本过期时） */
  onReload: () => void;
  /** 打开另一个产物（新版本）。已经拿到详情时一并传入，免得再请求一次 */
  onOpen: (artifactId: string, detail?: ArtifactDetailResponse) => void;
  /** 本任务的产物列表有变化 */
  onChanged: () => void;
  /** 后端报告任务只读 */
  onReadOnly: () => void;
  onBack: () => void;
  /**
   * 生成了更新的产物，但因为这里有未保存的修改没有自动打开。
   * 显示提示，由健管师决定是否打开（打开会放弃修改）。
   */
  newerArtifactId?: string | null;
  /** 编辑框里有没有未保存的修改 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 退回重写结束（不论是否生成了新版本）：对话里多了这一轮，对话区需要重新加载 */
  onRegenerated?: () => void;
}

/** 产物预览和审核栏（M1 规格 3.6） */
export function ArtifactView({
  detail,
  readOnly,
  onDetail,
  onReload,
  onOpen,
  onChanged,
  onReadOnly,
  onBack,
  newerArtifactId = null,
  onDirtyChange,
  onRegenerated,
}: ArtifactViewProps) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  const { artifact, hints } = detail;
  const saved = artifact.content.clientFacing;

  const [view, setView] = useState<View>('clientFacing');
  const [text, setText] = useState(saved);
  const [baseHash, setBaseHash] = useState(artifact.contentHash);
  /** 本地编辑基于的已保存内容 */
  const [baseText, setBaseText] = useState(saved);
  /** 服务端内容在别处变了，而本地还有未保存的修改：等健管师选择 */
  const [newerLoaded, setNewerLoaded] = useState(false);
  const [dismissedNewerId, setDismissedNewerId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [progress, setProgress] = useState<ReturnProgress | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});
  const abortRef = useRef<AbortController | null>(null);
  /** 自己保存后服务端返回的内容指纹：这次变化来自本地，直接采用 */
  const ownHashRef = useRef<string | null>(null);

  const isDraft = artifact.status === 'draft';
  const hasCritical = artifact.criticalFlags.length > 0;
  const working = busy !== null;
  const editable = isDraft && !readOnly;

  // 服务端内容变了（保存、刷新），上一次的检查结果以新内容为准。
  // 别处改过、而本地有未保存的修改时，不悄悄覆盖本地修改，提示健管师选择。
  if (baseHash !== artifact.contentHash) {
    const keepEdits = ownHashRef.current !== artifact.contentHash && editable && text !== baseText;
    setBaseHash(artifact.contentHash);
    setBaseText(saved);
    setRejection(null);
    setAcknowledged(false);
    if (keepEdits) {
      setNewerLoaded(true);
      if (notice?.kind === 'stale') setNotice(null);
    } else {
      setText(saved);
      setNewerLoaded(false);
    }
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  const dirty = text !== saved;
  const unsavedEdits = editable && dirty;

  useEffect(() => {
    onDirtyChange?.(unsavedEdits);
  }, [onDirtyChange, unsavedEdits]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const marks = useMemo(() => {
    const result: TextMark[] = bannedTermMarks(text);
    if (rejection && rejection.text === text) {
      for (const mark of serverBannedMarks(text, rejection.bannedTerms)) {
        if (!result.some((m) => m.start === mark.start)) result.push(mark);
      }
      result.push(...criticalMarks(text, rejection.criticalValueMentions));
    }
    // 详情里提前给出的危急指标数值位置（打开草稿就标出，不必等确认被拒绝）
    for (const mark of hintCriticalMarks(text, hints.criticalValueMentions, saved)) {
      if (!result.some((m) => m.kind === 'critical' && m.start === mark.start)) result.push(mark);
    }
    result.push(...judgementMarks(text, hints.judgementHints, saved));
    return result.sort((a, b) => a.start - b.start);
  }, [text, rejection, hints.judgementHints, hints.criticalValueMentions, saved]);

  const localBanned = marks.some((m) => m.kind === 'banned');
  const hasCriticalValue = marks.some((m) => m.kind === 'critical');
  const hasJudgement = marks.some((m) => m.kind === 'judgement');

  const approveBlock:
    'newerBlock' | 'unsaved' | 'bannedBlock' | 'criticalValueBlock' | 'criticalBlock' | null =
    !editable
      ? null
      : newerLoaded
        ? 'newerBlock'
        : localBanned
          ? 'bannedBlock'
          : dirty
            ? 'unsaved'
            : hasCriticalValue
              ? 'criticalValueBlock'
              : hasCritical && !acknowledged
                ? 'criticalBlock'
                : null;

  const showNewerArtifact =
    newerArtifactId !== null &&
    newerArtifactId !== artifact.id &&
    dismissedNewerId !== newerArtifactId;

  /** 放弃本地修改，载入服务端的最新内容 */
  const reloadLatest = () => {
    setText(saved);
    setNewerLoaded(false);
    setNotice(null);
  };

  const handleError = (err: unknown) => {
    if (isAbortError(err)) return;
    const kind = classifyArtifactError(err);
    if (kind.kind === 'stale') {
      setRejection(null);
      setNotice({ kind: 'stale' });
      onReload();
      return;
    }
    if (kind.key === 'readOnly') onReadOnly();
    if (kind.key === 'conflict' || kind.key === 'notFound') onReload();
    setNotice({ kind: 'error', key: kind.key });
  };

  const run = async (which: Exclude<Busy, null>, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(which);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      const next = await updateArtifact(artifact.id, {
        version: artifact.version,
        contentHash: artifact.contentHash,
        content: { professional: artifact.content.professional, clientFacing: text },
      });
      ownHashRef.current = next.artifact.contentHash;
      setNewerLoaded(false);
      onDetail(next);
      setNotice({ kind: 'saved' });
    });

  const approve = () =>
    run('approve', async () => {
      try {
        const next = await approveArtifact(artifact.id, {
          version: artifact.version,
          contentHash: artifact.contentHash,
          acknowledgedCritical: hasCritical ? acknowledged : false,
        });
        setRejection(null);
        onDetail(next);
        onChanged();
        setNotice({ kind: 'approved' });
      } catch (err) {
        if (
          err instanceof ApproveRejectedError &&
          !err.reasons.includes('not_latest_draft') &&
          !err.reasons.includes('read_only')
        ) {
          // 以后端的检查结果为准，逐条显示并标出位置
          setRejection({
            reasons: [...err.reasons],
            bannedTerms: err.bannedTerms,
            criticalValueMentions: err.criticalValueMentions,
            text: saved,
          });
          if (err.reasons.includes('critical_not_acknowledged')) setAcknowledged(false);
          if (err.reasons.some((r) => r === 'banned_terms' || r.startsWith('critical_value'))) {
            setView('clientFacing');
          }
          return;
        }
        throw err;
      }
    });

  const copy = () =>
    run('copy', async () => {
      const value = await copyArtifactText(artifact.id);
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        setNotice({ kind: 'error', key: 'copyFailed' });
        onChanged();
        return;
      }
      setNotice({ kind: 'copied' });
      onChanged();
    });

  const doExport = (format: ExportFormat) =>
    run(format, async () => {
      const file = await exportArtifact(artifact.id, format);
      downloadBlob(file);
      setNotice({ kind: 'exported', filename: file.filename });
      onChanged();
    });

  const revise = () =>
    run('revise', async () => {
      const next = await reviseArtifact(artifact.id);
      onChanged();
      onOpen(next.artifact.id, next);
    });

  const submitReturn = () => {
    setReasonTouched(true);
    const trimmed = reason.trim();
    if (!trimmed || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const result: { created: string | null; error: string | null } = {
      created: null,
      error: null,
    };
    void run('return', async () => {
      setProgress({ steps: [] });
      let opened = false;
      try {
        await returnArtifact(artifact.id, trimmed, {
          signal: controller.signal,
          onOpen: () => {
            opened = true;
            setReturnOpen(false);
            setReason('');
            setReasonTouched(false);
          },
          onEvent: (event) => {
            if (event.type === 'step') {
              setProgress((p) => ({
                ...p,
                steps: [...(p?.steps ?? []).filter((s) => s.id !== event.step.id), event.step],
              }));
            } else if (event.type === 'artifact') {
              result.created = event.artifact.id;
            } else if (event.type === 'error') {
              result.error = event.kind;
            }
          },
        });
      } catch (err) {
        setProgress(null);
        // 流打开后断开：后端可能已经保存了这一轮的部分内容
        if (opened) onRegenerated?.();
        throw err;
      } finally {
        abortRef.current = null;
      }
      onChanged();
      onRegenerated?.();
      if (result.created) {
        setProgress(null);
        onOpen(result.created);
      } else {
        // 没有生成新版本（模型拒答、输出不合格等）：显示原因，并刷新当前产物的状态
        setProgress((p) => ({ steps: p?.steps ?? [], error: result.error ?? 'no_artifact' }));
        onReload();
      }
    });
  };

  const locate = (mark: TextMark) => {
    setView('clientFacing');
    // 等切换到通俗版后再定位
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(mark.start, mark.end);
    });
  };

  const onTabKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = VIEWS[(VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length] ?? view;
    setView(next);
    tabRefs.current[next]?.focus();
  };

  const statusNote = readOnly
    ? t('results.artifacts.statusNote.readOnlyTask')
    : artifact.status === 'draft'
      ? null
      : t(`results.artifacts.statusNote.${artifact.status}`);

  return (
    <section className={styles.view} aria-labelledby="hb-artifact-title">
      <div className={styles.header}>
        <IconButton
          label={t('results.artifacts.back')}
          icon={<ArrowLeft size={16} />}
          size="small"
          onClick={onBack}
        />
        <h3 id="hb-artifact-title" className={styles.title}>
          {t('results.artifacts.item', {
            name: skillName(artifact.skillId),
            version: artifact.version,
          })}
        </h3>
        <StatusBadge status={artifact.status} />
      </div>

      <div className={styles.tabs} role="tablist" aria-label={t('results.artifacts.views.label')}>
        {VIEWS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`hb-artifact-tab-${id}`}
            aria-selected={view === id}
            aria-controls={`hb-artifact-panel-${id}`}
            tabIndex={view === id ? 0 : -1}
            className={styles.tab}
            onClick={() => setView(id)}
            onKeyDown={onTabKeyDown}
          >
            {t(`results.artifacts.views.${id}`)}
          </button>
        ))}
      </div>

      <div
        className={styles.body}
        role="tabpanel"
        id={`hb-artifact-panel-${view}`}
        aria-labelledby={`hb-artifact-tab-${view}`}
      >
        {view === 'professional' ? (
          <>
            <p className={styles.note}>{t('results.artifacts.professionalNote')}</p>
            <div className={styles.document} data-testid="artifact-professional">
              <PlainMarkdown source={artifact.content.professional} />
            </div>
          </>
        ) : (
          <>
            {editable ? (
              <label className={styles.editor}>
                <span className={styles.editorLabel}>
                  {t('results.artifacts.clientFacingLabel')}
                </span>
                <textarea
                  ref={textareaRef}
                  className={styles.textarea}
                  value={text}
                  disabled={working}
                  onChange={(e) => {
                    setText(e.target.value);
                    if (notice?.kind === 'saved') setNotice(null);
                  }}
                />
              </label>
            ) : (
              <div className={styles.document} data-testid="artifact-client-facing">
                {segmentText(text, marks).map((seg, i) =>
                  seg.mark ? (
                    <mark key={i} className={styles.mark} data-kind={seg.mark.kind}>
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </div>
            )}
            {editable && <p className={styles.note}>{t('results.artifacts.disclaimerNote')}</p>}
            {hasCriticalValue && (
              <p className={styles.criticalNote} role="alert">
                {t('results.artifacts.marks.criticalNote')}
              </p>
            )}
            {hasJudgement && (
              <p className={styles.hintNote} role="note">
                {t('results.artifacts.marks.judgementNote')}
              </p>
            )}
            {marks.length > 0 && (
              <MarkList text={text} marks={marks} onLocate={editable ? locate : undefined} />
            )}
          </>
        )}
      </div>

      <div
        className={styles.reviewBar}
        role="region"
        aria-label={t('results.artifacts.review.label')}
      >
        {hasCritical && (
          <CriticalPanel
            flags={artifact.criticalFlags}
            showAcknowledge={isDraft}
            acknowledged={acknowledged}
            disabled={!editable || working}
            onAcknowledge={setAcknowledged}
          />
        )}

        {statusNote && <p className={styles.statusNote}>{statusNote}</p>}

        {newerLoaded && editable && (
          <div className={styles.newer} role="alert">
            <p>{t('results.artifacts.newer.loaded')}</p>
            <div className={styles.actions}>
              <Button disabled={working} onClick={reloadLatest}>
                {t('results.artifacts.newer.reload')}
              </Button>
              <Button variant="ghost" disabled={working} onClick={() => setNewerLoaded(false)}>
                {t('results.artifacts.newer.keep')}
              </Button>
            </div>
          </div>
        )}

        {showNewerArtifact && newerArtifactId && (
          <div className={styles.newer} role="alert">
            <p>{t('results.artifacts.newer.generated')}</p>
            <div className={styles.actions}>
              <Button disabled={working} onClick={() => onOpen(newerArtifactId)}>
                {t('results.artifacts.newer.open')}
              </Button>
              <Button
                variant="ghost"
                disabled={working}
                onClick={() => setDismissedNewerId(newerArtifactId)}
              >
                {t('results.artifacts.newer.stay')}
              </Button>
            </div>
          </div>
        )}

        {rejection && <RejectionList reasons={rejection.reasons} />}

        {notice && <NoticeLine notice={notice} />}

        {progress && <ReturnProgressView progress={progress} active={busy === 'return'} />}

        {returnOpen && editable && (
          <div className={styles.returnForm} role="group" aria-labelledby="hb-return-title">
            <p id="hb-return-title" className={styles.returnTitle}>
              {t('results.artifacts.returnDialog.title')}
            </p>
            <label className={styles.editor}>
              <span className={styles.editorLabel}>
                {t('results.artifacts.returnDialog.label')}
              </span>
              <textarea
                className={styles.reasonInput}
                value={reason}
                required
                maxLength={RETURN_REASON_MAX}
                placeholder={t('results.artifacts.returnDialog.placeholder')}
                aria-invalid={reasonTouched && !reason.trim() ? true : undefined}
                disabled={working}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setReasonTouched(true)}
              />
            </label>
            {reasonTouched && !reason.trim() && (
              <p className={styles.fieldError} role="alert">
                {t('results.artifacts.returnDialog.required')}
              </p>
            )}
            <div className={styles.actions}>
              <Button variant="primary" disabled={working || !reason.trim()} onClick={submitReturn}>
                {t('results.artifacts.returnDialog.submit')}
              </Button>
              <Button
                variant="ghost"
                disabled={working}
                onClick={() => {
                  setReturnOpen(false);
                  setReasonTouched(false);
                }}
              >
                {t('results.artifacts.returnDialog.cancel')}
              </Button>
            </div>
          </div>
        )}

        {isDraft && !returnOpen && (
          <>
            {approveBlock && (
              <p className={styles.blockNote}>{t(`results.artifacts.review.${approveBlock}`)}</p>
            )}
            <div className={styles.actions}>
              <Button disabled={!editable || working || !dirty || newerLoaded} onClick={save}>
                {busy === 'save'
                  ? t('results.artifacts.review.saving')
                  : t('results.artifacts.review.save')}
              </Button>
              <Button
                variant="primary"
                disabled={!editable || working || approveBlock !== null}
                onClick={approve}
              >
                {busy === 'approve'
                  ? t('results.artifacts.review.approving')
                  : t('results.artifacts.review.approve')}
              </Button>
              <Button
                variant="ghost"
                disabled={!editable || working}
                onClick={() => {
                  setReturnOpen(true);
                  setNotice(null);
                }}
              >
                {t('results.artifacts.review.return')}
              </Button>
            </div>
          </>
        )}

        {artifact.status === 'approved' && (
          <div className={styles.actions}>
            <Button variant="primary" disabled={readOnly || working} onClick={copy}>
              {t('results.artifacts.review.copy')}
            </Button>
            <Button disabled={readOnly || working} onClick={() => doExport('png')}>
              {busy === 'png'
                ? t('results.artifacts.review.exporting')
                : t('results.artifacts.review.exportPng')}
            </Button>
            <Button disabled={readOnly || working} onClick={() => doExport('pdf')}>
              {busy === 'pdf'
                ? t('results.artifacts.review.exporting')
                : t('results.artifacts.review.exportPdf')}
            </Button>
            <Button variant="ghost" disabled={readOnly || working} onClick={revise}>
              {t('results.artifacts.review.revise')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

export function StatusBadge({ status }: { status: ArtifactDetailResponse['artifact']['status'] }) {
  const { t } = useTranslation();
  return (
    <span className={styles.badge} data-status={status}>
      {t(`results.artifacts.status.${status}`)}
    </span>
  );
}

function MarkList({
  text,
  marks,
  onLocate,
}: {
  text: string;
  marks: TextMark[];
  onLocate?: ((mark: TextMark) => void) | undefined;
}) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const describe = (mark: TextMark) => {
    if (mark.kind === 'banned') return t('results.artifacts.marks.banned', { term: mark.label });
    if (mark.kind === 'critical') {
      return t('results.artifacts.marks.critical', {
        metric: dt(`indicators.${mark.label}`, mark.label),
      });
    }
    return t('results.artifacts.marks.judgement', { text: mark.label });
  };
  return (
    <div className={styles.marks}>
      <p className={styles.marksTitle}>{t('results.artifacts.marks.title')}</p>
      <ul className={styles.markList} aria-label={t('results.artifacts.marks.title')}>
        {marks.map((mark) => (
          <li key={`${mark.kind}-${mark.start}`} className={styles.markItem} data-kind={mark.kind}>
            <span className={styles.markLabel}>{describe(mark)}</span>
            <span className={styles.snippet}>
              {text.slice(Math.max(0, mark.start - 8), mark.start)}
              <mark className={styles.mark} data-kind={mark.kind}>
                {text.slice(mark.start, mark.end)}
              </mark>
              {text.slice(mark.end, mark.end + 8)}
            </span>
            {onLocate && (
              <Button variant="ghost" className={styles.locate} onClick={() => onLocate(mark)}>
                {t('results.artifacts.marks.locate')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CriticalPanel({
  flags,
  showAcknowledge,
  acknowledged,
  disabled,
  onAcknowledge,
}: {
  flags: CriticalFlag[];
  showAcknowledge: boolean;
  acknowledged: boolean;
  disabled: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  return (
    <div className={styles.critical} role="group" aria-labelledby="hb-critical-title">
      <p id="hb-critical-title" className={styles.criticalTitle}>
        {t('results.artifacts.critical.title')}
      </p>
      <ul className={styles.criticalList}>
        {flags.map((flag, i) => (
          <li key={`${flag.metric}-${i}`}>
            <span className={styles.criticalValue}>
              {t('results.artifacts.critical.item', {
                metric: dt(`indicators.${flag.metric}`, flag.metric),
                value: flag.value,
                unit: flag.unit,
              })}
            </span>
            <span className={styles.criticalLevel} data-level={flag.rule.level}>
              {t(`results.artifacts.critical.level.${flag.rule.level}`)}
            </span>
            <span className={styles.criticalMeta}>
              {t('results.artifacts.critical.observed', {
                date: flag.observedOn,
                source: t(`results.artifacts.critical.source.${flag.source}`),
              })}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.note}>{t('results.artifacts.critical.note')}</p>
      {showAcknowledge && (
        <label className={styles.acknowledge}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={(e) => onAcknowledge(e.target.checked)}
          />
          {t('results.artifacts.critical.acknowledge')}
        </label>
      )}
    </div>
  );
}

function RejectionList({ reasons }: { reasons: string[] }) {
  const { t } = useTranslation();
  const known = (r: string): r is RejectReason => REJECT_REASONS.includes(r);
  return (
    <div className={styles.rejection} role="alert">
      <p className={styles.rejectionTitle}>{t('results.artifacts.rejected')}</p>
      <ul>
        {reasons.map((r) => (
          <li key={r}>
            {known(r)
              ? t(`results.artifacts.reasons.${r}`)
              : t('results.artifacts.reasons.unknown')}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  const { t } = useTranslation();
  if (notice.kind === 'error') {
    const message =
      notice.key === 'copyFailed'
        ? t('results.artifacts.errors.copyFailed')
        : t(`results.artifacts.errors.${notice.key}`);
    return (
      <p className={styles.error} role="alert">
        {message}
      </p>
    );
  }
  const message =
    notice.kind === 'stale'
      ? t('results.artifacts.stale')
      : notice.kind === 'exported'
        ? t('results.artifacts.review.exported', { filename: notice.filename })
        : t(`results.artifacts.review.${notice.kind}`);
  return (
    <p className={notice.kind === 'stale' ? styles.warning : styles.success} role="status">
      {message}
    </p>
  );
}

function ReturnProgressView({ progress, active }: { progress: ReturnProgress; active: boolean }) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const errorText = progress.error
    ? progress.error === 'no_artifact'
      ? t('results.artifacts.returnDialog.noArtifact')
      : dt(`chat.streamErrors.${progress.error}`, t('results.artifacts.errors.unknown'))
    : null;
  return (
    <div className={styles.progress} role="status" aria-live="polite">
      {active && <p>{t('results.artifacts.returnDialog.progress')}</p>}
      {progress.steps.length > 0 && (
        <ol className={styles.progressSteps}>
          {[...progress.steps]
            .sort((a, b) => a.seq - b.seq)
            .map((step) => (
              <li key={step.id} data-status={step.status}>
                {dt(step.labelKey, t('steps.unknown'))} · {t(`chat.steps.${step.status}`)}
              </li>
            ))}
        </ol>
      )}
      {errorText && <p className={styles.error}>{errorText}</p>}
    </div>
  );
}
