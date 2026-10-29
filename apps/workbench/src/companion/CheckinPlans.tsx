import {
  CHECKIN_KINDS,
  CHECKIN_METRICS,
  CHECKIN_NOTE_MAX,
  CHECKIN_SLOT_WINDOWS,
  CHECKIN_SLOTS,
  checkinTimeInSlot,
  type Checkin,
  type CheckinKind,
  type CheckinMetric,
  type CheckinPlan,
  type CheckinSlot,
  type CheckinSlotTime,
  type GoalTemplateManagerView,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import type { TFunction } from 'i18next';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listGoalTemplates } from '../api/care';
import {
  createCheckinPlan,
  listCheckinPlans,
  listCheckins,
  updateCheckinPlan,
} from '../api/companion';
import { ApiError, isAbortError } from '../api/http';
import styles from '../twin/Twin.module.css';
import care from './Companion.module.css';

/** 新建计划时每个时间段的默认提醒时间（都在窗口内） */
const DEFAULT_TIMES: Readonly<Record<CheckinSlot, string>> = {
  morning: '08:00',
  noon: '12:00',
  evening: '18:00',
  bedtime: '21:00',
};

/**
 * “伴侣”视图的打卡（M6 规格 2.3、2.8）：打卡计划的新增、修改、停用，近 30 天的打卡情况。
 * 计划只由健管师设置（Q16）；服药计划不填药名（N15），备注只给健管师看，福宝读不到。
 */
export function CheckinSection({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    clientId: string;
    plans: CheckinPlan[];
    checkins: Checkin[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [goals, setGoals] = useState<GoalTemplateManagerView[]>([]);
  const [editing, setEditing] = useState<CheckinPlan | 'new' | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    Promise.all([
      listCheckinPlans(clientId, controller.signal),
      listCheckins(clientId, controller.signal),
    ])
      .then(([plans, checkins]) => setData({ clientId, plans, checkins }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(true);
      });
    return () => controller.abort();
  }, [clientId, version]);

  useEffect(() => {
    const controller = new AbortController();
    listGoalTemplates({ section: 'exercise' }, controller.signal)
      .then(setGoals)
      .catch(() => setGoals([]));
    return () => controller.abort();
  }, []);

  useEffect(() => setEditing(null), [clientId]);

  const shown = data?.clientId === clientId ? data : null;
  if (!shown) {
    return error ? (
      <div role="alert">
        <p className={styles.error}>{t('companion.checkin.loadFailed')}</p>
        <Button onClick={reload}>{t('companion.retry')}</Button>
      </div>
    ) : (
      <p className={styles.muted} role="status">
        {t('companion.checkin.loading')}
      </p>
    );
  }

  const saved = () => {
    setEditing(null);
    reload();
  };

  return (
    <>
      <p className={styles.muted}>{t('companion.checkin.hint')}</p>
      {shown.plans.length === 0 ? (
        <p className={styles.muted}>{t('companion.checkin.noPlans')}</p>
      ) : (
        <ul className={care.planList}>
          {shown.plans.map((plan) =>
            editing !== 'new' && editing?.id === plan.id ? (
              <li key={plan.id}>
                <PlanForm
                  clientId={clientId}
                  plan={plan}
                  goals={goals}
                  onDone={saved}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <PlanItem
                key={plan.id}
                clientId={clientId}
                plan={plan}
                goals={goals}
                onEdit={() => setEditing(plan)}
                onChanged={reload}
              />
            ),
          )}
        </ul>
      )}
      {editing === 'new' ? (
        <PlanForm
          clientId={clientId}
          plan={null}
          goals={goals}
          onDone={saved}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className={styles.cardActions}>
          <Button onClick={() => setEditing('new')}>{t('companion.checkin.add')}</Button>
        </div>
      )}
      <History plans={shown.plans} checkins={shown.checkins} />
    </>
  );
}

/** “服药”“测量 · 血压”“运动” */
function planName(t: TFunction, p: { kind: CheckinKind; metric: CheckinMetric | null }): string {
  const kind = t(`companion.checkin.kinds.${p.kind}`);
  return p.metric ? `${kind} · ${t(`companion.checkin.metrics.${p.metric}`)}` : kind;
}

function slotsText(t: TFunction, slots: readonly CheckinSlotTime[]): string {
  return slots
    .map((s) =>
      t('companion.checkin.slotAt', { slot: t(`companion.checkin.slots.${s.slot}`), time: s.time }),
    )
    .join(t('companion.checkin.separator'));
}

/** 目标模板的文字：参数占位换成省略号（具体数值在方案里） */
function goalText(goal: GoalTemplateManagerView): string {
  return goal.text.replace(/\{[a-z0-9_]+\}/g, '…');
}

function errorText(t: TFunction, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.reasons.includes('too_many_plans')) {
      return t('companion.checkin.errors.tooMany');
    }
    if (err.status === 400) return t('companion.checkin.errors.badRequest');
    if (err.status === 404) return t('companion.errors.notFound');
    if (err.code === 'network') return t('companion.errors.network');
  }
  return t('companion.errors.unknown');
}

function PlanItem({
  clientId,
  plan,
  goals,
  onEdit,
  onChanged,
}: {
  clientId: string;
  plan: CheckinPlan;
  goals: readonly GoalTemplateManagerView[];
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goal = plan.goalTemplateId ? goals.find((g) => g.id === plan.goalTemplateId) : undefined;
  const toggle = () => {
    setBusy(true);
    setError(null);
    updateCheckinPlan(clientId, plan.id, { active: !plan.active })
      .then(onChanged)
      .catch((err: unknown) => setError(errorText(t, err)))
      .finally(() => setBusy(false));
  };
  return (
    <li className={care.planItem} data-active={plan.active}>
      <div className={care.planHeader}>
        <strong>{planName(t, plan)}</strong>
        {!plan.active && <span className={styles.tag}>{t('companion.checkin.stopped')}</span>}
      </div>
      <p className={styles.cardLine}>{slotsText(t, plan.slots)}</p>
      {goal && (
        <p className={styles.cardLine}>
          {t('companion.checkin.goalValue', { goal: goalText(goal) })}
        </p>
      )}
      {plan.note && (
        <p className={styles.muted}>{t('companion.checkin.noteValue', { note: plan.note })}</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        {plan.active && (
          <Button variant="ghost" disabled={busy} onClick={onEdit}>
            {t('companion.checkin.edit')}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={toggle}>
          {plan.active ? t('companion.checkin.stop') : t('companion.checkin.restart')}
        </Button>
      </div>
    </li>
  );
}

function PlanForm({
  clientId,
  plan,
  goals,
  onDone,
  onCancel,
}: {
  clientId: string;
  /** null 时新建 */
  plan: CheckinPlan | null;
  goals: readonly GoalTemplateManagerView[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<CheckinKind>(plan?.kind ?? 'medication');
  const [metric, setMetric] = useState<CheckinMetric>(plan?.metric ?? 'bp');
  const [times, setTimes] = useState<Partial<Record<CheckinSlot, string>>>(() =>
    plan ? Object.fromEntries(plan.slots.map((s) => [s.slot, s.time])) : { morning: '08:00' },
  );
  const [goalId, setGoalId] = useState(plan?.goalTemplateId ?? '');
  const [note, setNote] = useState(plan?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots: CheckinSlotTime[] = CHECKIN_SLOTS.flatMap((slot) => {
    const time = times[slot];
    return time === undefined ? [] : [{ slot, time }];
  });
  const valid = slots.length > 0 && slots.every((s) => checkinTimeInSlot(s.slot, s.time));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const goalTemplateId = kind === 'exercise' && goalId ? goalId : null;
    const request = plan
      ? updateCheckinPlan(clientId, plan.id, {
          slots,
          note,
          ...(plan.kind === 'exercise' && { goalTemplateId }),
        })
      : createCheckinPlan(clientId, {
          kind,
          metric: kind === 'measurement' ? metric : null,
          slots,
          goalTemplateId,
          note,
        });
    request
      .then(onDone)
      .catch((err: unknown) => setError(errorText(t, err)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      noValidate
      aria-label={plan ? t('companion.checkin.editTitle') : t('companion.checkin.addTitle')}
    >
      {plan ? (
        <p className={styles.cardLine}>
          <strong>{planName(t, plan)}</strong>
        </p>
      ) : (
        <div className={care.formRow}>
          <label className={styles.label}>
            {t('companion.checkin.kind')}
            <select
              className={styles.select}
              value={kind}
              onChange={(e) => setKind(e.target.value as CheckinKind)}
            >
              {CHECKIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`companion.checkin.kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          {kind === 'measurement' && (
            <label className={styles.label}>
              {t('companion.checkin.metric')}
              <select
                className={styles.select}
                value={metric}
                onChange={(e) => setMetric(e.target.value as CheckinMetric)}
              >
                {CHECKIN_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {t(`companion.checkin.metrics.${m}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {kind === 'medication' && (
        <p className={styles.muted}>{t('companion.checkin.medicationHint')}</p>
      )}
      <fieldset className={care.slotGroup}>
        <legend className={styles.label}>{t('companion.checkin.slotsLabel')}</legend>
        {CHECKIN_SLOTS.map((slot) => {
          const time = times[slot];
          const window = CHECKIN_SLOT_WINDOWS[slot];
          const label = t(`companion.checkin.slots.${slot}`);
          return (
            <div key={slot} className={care.slotRow}>
              <label className={care.checkRow}>
                <input
                  type="checkbox"
                  checked={time !== undefined}
                  onChange={(e) =>
                    setTimes((prev) => {
                      const next = { ...prev };
                      if (e.target.checked) next[slot] = DEFAULT_TIMES[slot];
                      else delete next[slot];
                      return next;
                    })
                  }
                />
                {t('companion.checkin.slotWindow', {
                  slot: label,
                  start: window.start,
                  end: window.end,
                })}
              </label>
              {time !== undefined && (
                <input
                  type="time"
                  className={styles.input}
                  aria-label={t('companion.checkin.timeOf', { slot: label })}
                  value={time}
                  min={window.start}
                  max={window.end}
                  aria-invalid={!checkinTimeInSlot(slot, time)}
                  onChange={(e) => setTimes((prev) => ({ ...prev, [slot]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </fieldset>
      {slots.length > 0 && !valid && (
        <p className={styles.error} role="alert">
          {t('companion.checkin.timeOutside')}
        </p>
      )}
      {kind === 'exercise' && (
        <label className={styles.label}>
          {t('companion.checkin.goal')}
          <select
            className={styles.select}
            value={goalId}
            onChange={(e) => setGoalId(e.target.value)}
          >
            <option value="">{t('companion.checkin.noGoal')}</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {goalText(g)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={styles.label}>
        {t('companion.checkin.note', { max: CHECKIN_NOTE_MAX })}
        <textarea
          className={styles.input}
          value={note}
          maxLength={CHECKIN_NOTE_MAX}
          rows={2}
          placeholder={t('companion.checkin.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {t('companion.checkin.save')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t('companion.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** 近 30 天的打卡：日期、项目、时间段、结果（测量类显示客户报的数，不评价） */
function History({
  plans,
  checkins,
}: {
  plans: readonly CheckinPlan[];
  checkins: readonly Checkin[];
}) {
  const { t } = useTranslation();
  if (!plans.length && !checkins.length) return null;
  return (
    <div className={care.history}>
      <h6 className={styles.basisTitle}>{t('companion.checkin.historyTitle')}</h6>
      {checkins.length === 0 ? (
        <p className={styles.muted}>{t('companion.checkin.noHistory')}</p>
      ) : (
        <table className={care.table}>
          <thead>
            <tr>
              <th scope="col">{t('companion.checkin.columns.date')}</th>
              <th scope="col">{t('companion.checkin.columns.item')}</th>
              <th scope="col">{t('companion.checkin.columns.slot')}</th>
              <th scope="col">{t('companion.checkin.columns.result')}</th>
            </tr>
          </thead>
          <tbody>
            {checkins.map((c) => (
              <tr key={c.id} data-status={c.status}>
                <td>{c.dueOn}</td>
                <td>{planName(t, c)}</td>
                <td>{t(`companion.checkin.slots.${c.slot}`)}</td>
                <td>
                  {t(`companion.checkin.statuses.${c.status}`)}
                  {c.values.length > 0 &&
                    ` ${t('companion.checkin.reported', { values: c.values.join(' / ') })}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
