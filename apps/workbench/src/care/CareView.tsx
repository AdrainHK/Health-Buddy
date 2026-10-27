import {
  CARE_PLAN_END_REASONS,
  VISIT_ADDENDUM_MAX,
  renderGoal,
  type AdherenceResponse,
  type CarePlan,
  type CarePlanListResponse,
  type CarePlanSummary,
  type ClientSummary,
  type ExportFormat,
  type GoalTemplateManagerView,
  type PlanSection,
  type Visit,
  type VisitRecord,
  type VisitRecordSummary,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import type { TFunction } from 'i18next';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { copyArtifactText, downloadBlob, exportArtifact } from '../api/artifacts';
import {
  addVisitRecordAddendum,
  endCarePlan,
  getAdherence,
  getCarePlan,
  getVisitRecord,
  listCarePlans,
  listGoalTemplates,
  listVisitRecords,
  listVisits,
} from '../api/care';
import { isAbortError } from '../api/http';
import { PlainMarkdown } from '../artifacts/PlainMarkdown';
import { useTwinActions } from '../twin/TwinActions';
import { twinErrorKey } from '../twin/errors';
import { formatNumber } from '../twin/format';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';
import { AddVisitForm } from './AddVisitForm';
import { VisitCard } from './VisitCard';

/** 日程里显示的随访：待随访、未联系上（已顺延）、待方案生效 */
const OPEN_STATUSES: readonly Visit['status'][] = ['planned', 'missed', 'pending_plan'];

interface CareData {
  clientId: string;
  plans: CarePlanListResponse;
  /** 当前方案的快照（行为目标要用）；没有生效方案时为 null */
  current: CarePlan | null;
  adherence: AdherenceResponse | null | 'error';
  visits: Visit[];
  records: VisitRecordSummary[];
  /** 已发布的目标模板（把行为目标渲染成文字）；读不到时为空，目标显示“请查看全文” */
  templates: GoalTemplateManagerView[];
}

export interface CareViewProps {
  client: ClientSummary;
  /** 改变时重新加载（如确认了方案、随访计划、随访记录） */
  refreshKey?: string;
  /** 处理了随访、结束了方案：左侧栏的今日随访角标据此刷新 */
  onChanged?: () => void;
}

/**
 * 结果区“客户 · 方案与随访”（M5 规格 2.6）。从上到下：固定提示条、当前方案、执行情况、
 * 随访日程、随访记录、历史方案。全部是后端确定性计算的结果，不调用大模型；只给健管师看。
 */
export function CareView({ client, refreshKey, onChanged }: CareViewProps) {
  const { t } = useTranslation();
  const { planAndVisits } = useTwinActions();
  const clientId = client.id;
  const [data, setData] = useState<CareData | null>(null);
  const [error, setError] = useState<'notFound' | 'failed' | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [fullPlan, setFullPlan] = useState<CarePlanSummary | null>(null);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const changed = useCallback(() => {
    reload();
    onChanged?.();
  }, [reload, onChanged]);

  useEffect(() => {
    setData((d) => (d?.clientId === clientId ? d : null));
    setAdding(false);
    setFullPlan(null);
  }, [clientId]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setError(null);
    (async () => {
      const [plans, visits, records, templates] = await Promise.all([
        listCarePlans(clientId, signal),
        listVisits({ clientId }, signal),
        listVisitRecords(clientId, signal),
        listGoalTemplates({}, signal).catch((err: unknown) => {
          if (isAbortError(err)) throw err;
          return [];
        }),
      ]);
      const [current, adherence] = plans.current
        ? await Promise.all([
            getCarePlan(plans.current.id, signal),
            getAdherence(clientId, signal).catch((err: unknown) => {
              if (isAbortError(err)) throw err;
              return 'error' as const;
            }),
          ])
        : [null, null];
      return { clientId, plans, current, adherence, visits, records, templates };
    })()
      .then(setData)
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setError(twinErrorKey(err) === 'notFound' ? 'notFound' : 'failed');
      });
    return () => controller.abort();
  }, [clientId, refreshKey, version]);

  const shown = data?.clientId === clientId ? data : null;

  if (!shown) {
    return (
      <div className={styles.twin}>
        <Banner />
        {error ? (
          <div className={styles.section} role="alert">
            <p className={styles.error}>
              {error === 'notFound' ? t('care.notFound') : t('care.loadFailed')}
            </p>
            <div>
              <Button onClick={reload}>{t('care.retry')}</Button>
            </div>
          </div>
        ) : (
          <p className={styles.muted} role="status">
            {t('care.loading')}
          </p>
        )}
      </div>
    );
  }

  const templates = new Map(shown.templates.map((tpl) => [tpl.id, tpl]));
  const openVisits = shown.visits
    .filter((v) => OPEN_STATUSES.includes(v.status))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return (
    <div className={styles.twin}>
      <Banner />
      {planAndVisits && (
        <div className={styles.cardActions}>
          <Button onClick={() => planAndVisits(client)}>{t('twin.ai.planAndVisits')}</Button>
          <span className={styles.muted}>{t('twin.ai.planAndVisitsNote')}</span>
        </div>
      )}

      <Section title={t('care.plan.title')}>
        {shown.current ? (
          <CurrentPlan
            plan={shown.current}
            templates={templates}
            onViewFull={() => setFullPlan(shown.current)}
            onEnded={changed}
          />
        ) : (
          <>
            <p className={styles.followUpBasis}>{t('care.plan.none')}</p>
            <p className={styles.muted}>{t('care.plan.noneHint')}</p>
          </>
        )}
      </Section>

      {shown.current && (
        <Section title={t('care.adherence.title')}>
          <Adherence state={shown.adherence} plan={shown.current} templates={templates} />
        </Section>
      )}

      <Section
        title={t('care.visits.title')}
        action={!adding && <Button onClick={() => setAdding(true)}>{t('care.visits.add')}</Button>}
      >
        {adding && (
          <AddVisitForm
            clientId={clientId}
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              changed();
            }}
          />
        )}
        {openVisits.length === 0 ? (
          <p className={styles.muted}>{t('care.visits.empty')}</p>
        ) : (
          <ul className={styles.followUpList} aria-label={t('care.visits.title')}>
            {openVisits.map((v) => (
              <VisitCard key={v.id} visit={v} onChanged={changed} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('care.records.title')}>
        {shown.records.length === 0 ? (
          <p className={styles.muted}>{t('care.records.empty')}</p>
        ) : (
          <ul className={styles.followUpList} aria-label={t('care.records.title')}>
            {shown.records.map((r) => (
              <RecordItem key={r.id} summary={r} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('care.history.title')}>
        {shown.plans.history.length === 0 ? (
          <p className={styles.muted}>{t('care.history.empty')}</p>
        ) : (
          <ul className={care.plainList} aria-label={t('care.history.title')}>
            {shown.plans.history.map((p) => (
              <li key={p.id} className={care.historyItem}>
                <span>
                  {t('care.history.line', {
                    start: p.startDate,
                    end: p.endedAt ? p.endedAt.slice(0, 10) : p.reviewDate,
                    sections: sectionsText(t, p.sections),
                    status: t(`care.plan.status.${p.status}`),
                  })}
                </span>
                <Button variant="ghost" onClick={() => setFullPlan(p)}>
                  {t('care.plan.viewFull')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {fullPlan && <PlanFullDialog plan={fullPlan} onClose={() => setFullPlan(null)} />}
    </div>
  );
}

type T = TFunction;

function sectionsText(t: T, sections: readonly PlanSection[]): string {
  return sections.map((s) => t(`care.sections.${s}`)).join(t('care.separator'));
}

/** 行为目标的文字：模板 + 参数（2.3）。模板已停用或参数对不上时提示查看全文 */
function goalText(
  t: T,
  templates: ReadonlyMap<string, GoalTemplateManagerView>,
  goal: { templateId: string; params: Record<string, number | string> },
): string {
  const tpl = templates.get(goal.templateId);
  if (!tpl) return t('care.plan.goalUnavailable');
  try {
    return renderGoal(tpl, goal.params);
  } catch {
    return t('care.plan.goalUnavailable');
  }
}

function CurrentPlan({
  plan,
  templates,
  onViewFull,
  onEnded,
}: {
  plan: CarePlan;
  templates: ReadonlyMap<string, GoalTemplateManagerView>;
  onViewFull: () => void;
  onEnded: () => void;
}) {
  const { t } = useTranslation();
  const [ending, setEnding] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const artifactId = plan.artifactId;

  const copy = () => {
    if (!artifactId) return;
    setBusy(true);
    setNotice(null);
    copyArtifactText(artifactId)
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => setNotice({ kind: 'ok', text: t('care.plan.copied') }))
      .catch(() => setNotice({ kind: 'error', text: t('care.plan.copyFailed') }))
      .finally(() => setBusy(false));
  };
  const exportAs = (format: ExportFormat) => {
    if (!artifactId) return;
    setBusy(true);
    setNotice(null);
    exportArtifact(artifactId, format)
      .then(downloadBlob)
      .catch(() => setNotice({ kind: 'error', text: t('care.plan.exportFailed') }))
      .finally(() => setBusy(false));
  };

  return (
    <div className={care.plan} data-testid="current-plan">
      <p className={styles.followUpBasis}>
        {t('care.plan.dates', {
          start: plan.startDate,
          weeks: plan.cycleWeeks,
          review: plan.reviewDate,
        })}
      </p>
      <p className={styles.muted}>
        {t('care.plan.includes', { sections: sectionsText(t, plan.sections) })}
      </p>
      <h6 className={care.subTitle}>{t('care.plan.goals')}</h6>
      <ul className={care.goalGroups}>
        {plan.snapshot.structured.sections.map((s) => (
          <li key={s.section}>
            <strong>{t(`care.sections.${s.section}`)}</strong>
            {s.goals.length === 0 ? (
              <span className={styles.muted}> {t('care.plan.noGoals')}</span>
            ) : (
              <ul className={care.goalList}>
                {s.goals.map((g, i) => (
                  <li key={`${g.templateId}-${i}`}>{goalText(t, templates, g)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {ending ? (
        <EndPlanForm
          planId={plan.id}
          onCancel={() => setEnding(false)}
          onDone={() => {
            setEnding(false);
            onEnded();
          }}
        />
      ) : (
        <div className={styles.cardActions}>
          <Button onClick={onViewFull}>{t('care.plan.viewFull')}</Button>
          {artifactId && (
            <>
              <Button onClick={copy} disabled={busy}>
                {t('care.plan.copy')}
              </Button>
              <Button onClick={() => exportAs('pdf')} disabled={busy}>
                {t('care.plan.exportPdf')}
              </Button>
              <Button onClick={() => exportAs('png')} disabled={busy}>
                {t('care.plan.exportPng')}
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => setEnding(true)}>
            {t('care.plan.end')}
          </Button>
        </div>
      )}
      {!artifactId && <p className={styles.muted}>{t('care.plan.noArtifact')}</p>}
      {notice && (
        <p
          className={notice.kind === 'error' ? styles.error : styles.muted}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

/** 结束方案（2.6）：必须选原因 */
function EndPlanForm({
  planId,
  onCancel,
  onDone,
}: {
  planId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!reason) return;
    setBusy(true);
    setError(null);
    endCarePlan(planId, { reason: reason as (typeof CARE_PLAN_END_REASONS)[number] })
      .then(onDone)
      .catch((err: unknown) => {
        const key = twinErrorKey(err);
        if (key === 'conflict' || key === 'notFound') {
          setError(t('care.plan.endConflict'));
          onDone();
        } else setError(t('care.plan.endFailed'));
      })
      .finally(() => setBusy(false));
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <label className={styles.label}>
        {t('care.plan.endReason')}
        <select
          className={styles.select}
          value={reason}
          aria-invalid={touched && !reason ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        >
          <option value="">{t('care.plan.endReasonNone')}</option>
          {CARE_PLAN_END_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`care.plan.endReasons.${r}`)}
            </option>
          ))}
        </select>
      </label>
      {touched && !reason && (
        <p className={styles.error} role="alert">
          {t('care.plan.endReasonRequired')}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('care.plan.ending') : t('care.plan.endSubmit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('care.plan.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * 执行情况（2.6、Q10）：关联了监测指标的目标显示近 7、14 天的平均值和达到目标的天数；
 * 其余目标“需在随访时了解”。只显示，不生成跟进项、不改孪生状态。
 */
function Adherence({
  state,
  plan,
  templates,
}: {
  state: AdherenceResponse | null | 'error';
  plan: CarePlan;
  templates: ReadonlyMap<string, GoalTemplateManagerView>;
}) {
  const { t } = useTranslation();
  if (state === 'error') return <p className={styles.error}>{t('care.adherence.loadFailed')}</p>;
  const goals = plan.snapshot.structured.sections.flatMap((s) => s.goals);
  const untracked = state
    ? goals.filter((g) => state.untrackedTemplateIds.includes(g.templateId))
    : goals;
  return (
    <>
      <p className={styles.muted}>{t('care.adherence.note')}</p>
      {state && state.goals.length > 0 && (
        <ul className={care.plainList} data-testid="adherence">
          {state.goals.map((g) => {
            const unit = t(`care.adherence.units.${g.metric}`);
            return (
              <li key={g.templateId} className={care.adherenceItem}>
                <strong>
                  {t('care.adherence.target', {
                    metric: t(`care.adherence.metrics.${g.metric}`),
                    target: formatNumber(g.target),
                    unit,
                  })}
                </strong>
                {g.hasData ? (
                  g.windows.map((w) => (
                    <span key={w.days}>
                      {w.daysWithData === 0 || w.average === null
                        ? t('care.adherence.windowNoData', { days: w.days })
                        : t('care.adherence.window', {
                            days: w.days,
                            average: formatNumber(Math.round(w.average * 10) / 10),
                            unit,
                            met: w.daysMet,
                            withData: w.daysWithData,
                          })}
                    </span>
                  ))
                ) : (
                  <span className={styles.muted}>{t('care.adherence.noData')}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {untracked.length > 0 && (
        <ul className={care.plainList}>
          {untracked.map((g, i) => (
            <li key={`${g.templateId}-${i}`} className={care.adherenceItem}>
              <span>{goalText(t, templates, g)}</span>
              <span className={styles.muted}>{t('care.adherence.untracked')}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 一条随访记录：日期、方式、摘要的开头；点开看全文和补充说明（只追加） */
function RecordItem({ summary }: { summary: VisitRecordSummary }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VisitRecord | null>(null);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  useEffect(() => {
    if (!open || record) return;
    const controller = new AbortController();
    setFailed(false);
    getVisitRecord(summary.id, controller.signal)
      .then(setRecord)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setFailed(true);
      });
    return () => controller.abort();
  }, [open, record, summary.id]);
  return (
    <li className={care.visit} aria-labelledby={titleId}>
      <div className={styles.followUpHead}>
        <span id={titleId} className={styles.followUpTitle}>
          {t('care.records.line', {
            date: summary.visitDate,
            method: t(`care.visits.methods.${summary.method}`),
          })}
        </span>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('care.records.close') : t('care.records.open')}
        </Button>
      </div>
      {!open && <p className={styles.followUpBasis}>{summary.excerpt}</p>}
      {open && !record && !failed && (
        <p className={styles.muted} role="status">
          {t('care.records.loading')}
        </p>
      )}
      {open && failed && (
        <p className={styles.error} role="alert">
          {t('care.records.loadFailed')}
        </p>
      )}
      {open && record && <RecordBody record={record} onRecord={setRecord} />}
    </li>
  );
}

function RecordBody({
  record,
  onRecord,
}: {
  record: VisitRecord;
  onRecord: (r: VisitRecord) => void;
}) {
  const { t } = useTranslation();
  const s = record.snapshot;
  const list = (title: string, items: readonly string[]) => (
    <div>
      <h6 className={care.subTitle}>{title}</h6>
      {items.length === 0 ? (
        <p className={styles.muted}>{t('care.records.nothing')}</p>
      ) : (
        <ul className={care.goalList}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className={care.recordBody}>
      <div>
        <h6 className={care.subTitle}>{t('care.records.summary')}</h6>
        <p className={styles.followUpBasis}>{s.summary || t('care.records.nothing')}</p>
      </div>
      <div>
        <h6 className={care.subTitle}>{t('care.records.feedback')}</h6>
        {s.feedback.length === 0 ? (
          <p className={styles.muted}>{t('care.records.nothing')}</p>
        ) : (
          <ul className={care.goalGroups}>
            {s.feedback.map((f) => (
              <li key={f.topic}>
                <strong>{t(`care.records.topics.${f.topic}`)}</strong>
                <ul className={care.goalList}>
                  {f.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
      {list(t('care.records.planProgress'), s.planProgress)}
      {list(t('care.records.agreements'), s.agreements)}
      {list(t('care.records.attentionPoints'), s.attentionPoints)}
      {list(
        t('care.records.historySuggestions'),
        s.historySuggestions.map((h) =>
          t('care.records.historyLine', {
            category: t(`record.history.categories.${h.category}`),
            content: h.content,
          }),
        ),
      )}
      {list(t('care.records.openQuestions'), s.openQuestions)}
      <Addenda record={record} onRecord={onRecord} />
    </div>
  );
}

/** 补充说明：记录确认后不能修改，只能追加（2.9 第 7 条） */
function Addenda({
  record,
  onRecord,
}: {
  record: VisitRecord;
  onRecord: (r: VisitRecord) => void;
}) {
  const { t } = useTranslation();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(false);
    addVisitRecordAddendum(record.id, trimmed)
      .then((next) => {
        onRecord(next);
        setText('');
        setWriting(false);
      })
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };
  return (
    <div>
      <h6 className={care.subTitle}>{t('care.records.addenda')}</h6>
      {record.addenda.length > 0 && (
        <ul className={care.goalList}>
          {record.addenda.map((a) => (
            <li key={a.id}>
              <span className={styles.muted}>{a.createdAt.slice(0, 10)} </span>
              {a.text}
            </li>
          ))}
        </ul>
      )}
      {writing ? (
        <form className={styles.form} onSubmit={submit} noValidate>
          <label className={styles.label}>
            {t('care.records.addendumLabel', { max: VISIT_ADDENDUM_MAX })}
            <textarea
              className={styles.textarea}
              value={text}
              maxLength={VISIT_ADDENDUM_MAX}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {t('care.records.addendumFailed')}
            </p>
          )}
          <div className={styles.cardActions}>
            <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
              {busy ? t('care.records.addendumSaving') : t('care.records.addendumSubmit')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setWriting(false)} disabled={busy}>
              {t('care.records.addendumCancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.cardActions}>
          <Button variant="ghost" onClick={() => setWriting(true)}>
            {t('care.records.addendumAdd')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 方案全文：确认那一刻的快照（专业版和通俗版），库条目以后改了也不变 */
function PlanFullDialog({ plan, onClose }: { plan: CarePlanSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState<CarePlan | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getCarePlan(plan.id, controller.signal)
      .then(setFull)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setFailed(true);
      });
    return () => controller.abort();
  }, [plan.id]);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={styles.dialogBackdrop}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={styles.dialogHeader}>
          <h4 id={titleId} className={styles.cardTitle}>
            {t('care.full.title')}
          </h4>
          <Button variant="ghost" onClick={onClose}>
            {t('care.full.close')}
          </Button>
        </header>
        {failed && (
          <p className={styles.error} role="alert">
            {t('care.full.loadFailed')}
          </p>
        )}
        {!full && !failed && (
          <p className={styles.muted} role="status">
            {t('care.full.loading')}
          </p>
        )}
        {full && (
          <>
            <h5 className={styles.sectionTitle}>{t('care.full.professional')}</h5>
            <PlainMarkdown source={full.snapshot.content.professional} />
            <h5 className={styles.sectionTitle}>{t('care.full.clientFacing')}</h5>
            <PlainMarkdown source={full.snapshot.content.clientFacing} />
          </>
        )}
      </div>
    </div>
  );
}

function Banner() {
  const { t } = useTranslation();
  return (
    <div className={styles.banner} role="note">
      <span>{t('twin.disclaimer')}</span>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <h5 id={id} className={styles.sectionTitle}>
          {title}
        </h5>
        {action}
      </div>
      {children}
    </section>
  );
}
