import {
  CRITICAL_COMPARATORS,
  FOLLOW_UP_DISMISS_REASONS,
  FOLLOW_UP_NOTE_MAX,
  FOLLOW_UP_RESOLUTIONS,
  FOLLOW_UP_SNOOZE_DAYS,
  FORECAST_INTERVAL_LEVEL,
  TWIN_LEVELS,
  type FollowUpItem,
  type UpdateFollowUpRequest,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type FormEvent, useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { updateFollowUp } from '../api/twin';
import { displayDateTime, twinErrorKey } from './errors';
import { formatNumber, useComparator, useMetricName } from './format';
import styles from './Twin.module.css';

/** 后端按模板存的依据（结构化数据），这里按类型宽松解析，解析不了就显示“依据见孪生” */
const valueSchema = z.object({
  source: z.enum(['report', 'monitoring']),
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  observedOn: z.string(),
});
const criticalBasisSchema = valueSchema.extend({
  rule: z.object({ comparator: z.enum(CRITICAL_COMPARATORS), value: z.number() }),
});
const statusBasisSchema = z.object({
  domain: z.enum(['metabolic', 'cardiovascular', 'sleep', 'weight']),
  from: z.enum(TWIN_LEVELS).nullable(),
  to: z.enum(TWIN_LEVELS),
  items: z.array(valueSchema).default([]),
});
const deviationBasisSchema = valueSchema.extend({
  expected: z.object({ low: z.number(), high: z.number() }),
  side: z.enum(['above', 'below']),
  // 旧数据没有区间水平，按预测固定的 FORECAST_INTERVAL_LEVEL 显示
  intervalLevel: z.number().optional(),
  direction: z.enum(['worse', 'better', 'unknown']).nullable().optional(),
});

/**
 * 每一项的一句依据（规格 2.6），如“收缩压 182 mmHg（2026-10-17 监测）达到危急阈值 ≥ 180”。
 * 全部由后端存的结构化数据按模板拼出，不经大模型。
 */
export function useFollowUpBasis(): (item: FollowUpItem) => string {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const comparator = useComparator();
  return useCallback(
    (item: FollowUpItem) => {
      const valueText = (v: z.infer<typeof valueSchema>) =>
        t('followUps.basis.value', {
          metric: metricName(v.metric),
          value: formatNumber(v.value),
          unit: v.unit,
          date: v.observedOn,
          source: t(`followUps.source.${v.source}`),
        });
      if (item.kind === 'critical') {
        const b = criticalBasisSchema.safeParse(item.basis);
        if (!b.success) return t('followUps.basis.unknown');
        return t('followUps.basis.critical', {
          value: valueText(b.data),
          comparator: comparator(b.data.rule.comparator),
          threshold: formatNumber(b.data.rule.value),
        });
      }
      if (item.kind === 'forecast_deviation') {
        const b = deviationBasisSchema.safeParse(item.basis);
        if (!b.success) return t('followUps.basis.unknown');
        return (
          t('followUps.basis.deviation', {
            value: valueText(b.data),
            side: t(`followUps.basis.side.${b.data.side}`),
            low: formatNumber(b.data.expected.low),
            high: formatNumber(b.data.expected.high),
            level: Math.round((b.data.intervalLevel ?? FORECAST_INTERVAL_LEVEL) * 100),
          }) + t(`followUps.basis.direction.${b.data.direction ?? 'unknown'}`)
        );
      }
      const b = statusBasisSchema.safeParse(item.basis);
      if (!b.success) return t('followUps.basis.unknown');
      const domain = t(`twin.domains.${b.data.domain}`);
      const status = b.data.from
        ? t('followUps.basis.status', {
            domain,
            from: t(`twin.colors.${b.data.from}`),
            to: t(`twin.colors.${b.data.to}`),
          })
        : t('followUps.basis.statusFirst', { domain, to: t(`twin.colors.${b.data.to}`) });
      if (b.data.items.length === 0) return status;
      return t('followUps.basis.statusItems', {
        status,
        items: b.data.items.map(valueText).join(t('followUps.basis.separator')),
      });
    },
    [t, metricName, comparator],
  );
}

type Mode = 'done' | 'snooze' | 'dismiss';

export interface FollowUpCardProps {
  item: FollowUpItem;
  /** 所有客户的清单里显示客户称呼和“打开客户”；孪生视图里只有这位客户的，不显示 */
  showClient: boolean;
  onOpenClient?: (clientId: string) => void;
  /** 处理成功（或发现这一项已变化）后刷新清单 */
  onChanged: () => void;
  /** “请专家看看”（M4 规格 2.6 之二，专家预览打开时才有）：请过后显示“已请专家（时间）”，状态不变 */
  onAskExpert?: () => void;
}

/**
 * 一条跟进项（规格 2.6）：类型、方面或指标、一句依据、生成时间、“已延续 x 天”；
 * 按钮“打开客户”“处理”，专家预览打开时还有“请专家看看”。
 */
export function FollowUpCard({
  item,
  showClient,
  onOpenClient,
  onChanged,
  onAskExpert,
}: FollowUpCardProps) {
  const { t } = useTranslation();
  const basis = useFollowUpBasis();
  const titleId = useId();
  const [handling, setHandling] = useState(false);
  const kind = t(`followUps.kinds.${item.kind}`);
  const metricName = useMetricName();
  const subject = item.domain
    ? t(`twin.domains.${item.domain}`)
    : item.metric
      ? metricName(item.metric)
      : null;

  return (
    <li className={styles.followUp} data-severity={item.severity} aria-labelledby={titleId}>
      <div className={styles.followUpHead}>
        <span
          className={styles.severity}
          data-severity={item.severity}
          aria-label={t('followUps.severityLabel', { level: item.severity })}
          title={t('followUps.severityLabel', { level: item.severity })}
        >
          {t('followUps.severity', { level: item.severity })}
        </span>
        <span id={titleId} className={styles.followUpTitle}>
          {showClient && <strong>{item.clientName} · </strong>}
          {kind}
          {subject && ` · ${subject}`}
        </span>
        <span className={styles.carried}>
          {item.carriedDays > 0
            ? t('followUps.carried', { count: item.carriedDays })
            : t('followUps.today')}
        </span>
      </div>
      <p className={styles.followUpBasis}>{basis(item)}</p>
      <p className={styles.muted}>
        {t('followUps.triggeredAt', { time: displayDateTime(item.lastTriggeredAt) })}
        {item.consultedAt &&
          ` · ${t('followUps.consulted', { time: displayDateTime(item.consultedAt) })}`}
      </p>
      {handling ? (
        <HandleForm
          item={item}
          onCancel={() => setHandling(false)}
          onDone={() => {
            setHandling(false);
            onChanged();
          }}
        />
      ) : (
        <div className={styles.cardActions}>
          {showClient && onOpenClient && (
            <Button
              onClick={() => onOpenClient(item.clientId)}
              aria-label={t('followUps.openClientLabel', { name: item.clientName })}
            >
              {t('followUps.openClient')}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => setHandling(true)}
            aria-label={t('followUps.handleLabel', { name: item.clientName, kind })}
          >
            {t('followUps.handle')}
          </Button>
          {onAskExpert && (
            <Button
              variant="ghost"
              onClick={onAskExpert}
              aria-label={t('twin.ai.askExpertLabel', { subject: subject ?? kind })}
            >
              {t('twin.ai.askExpert')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * 处理（Q14）：已处理（可选方式类别和备注）、暂缓（明天、3 天后、7 天后）、
 * 忽略（必须选原因）。危急指标类不能忽略：不提供这个选项，后端返回 400 时也提示。
 */
function HandleForm({
  item,
  onCancel,
  onDone,
}: {
  item: FollowUpItem;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const canDismiss = item.kind !== 'critical';
  const modes: Mode[] = canDismiss ? ['done', 'snooze', 'dismiss'] : ['done', 'snooze'];
  const [mode, setMode] = useState<Mode>('done');
  const [resolution, setResolution] = useState<string>('');
  const [snoozeDays, setSnoozeDays] = useState<1 | 3 | 7>(1);
  const [dismissReason, setDismissReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedNote = note.trim();
  const dismissMissing = mode === 'dismiss' && dismissReason === '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (dismissMissing || trimmedNote.length > FOLLOW_UP_NOTE_MAX) return;
    const noteField = trimmedNote ? { note: trimmedNote } : {};
    let body: UpdateFollowUpRequest;
    if (mode === 'done')
      body = {
        action: 'done',
        ...(resolution ? { resolution: resolution as (typeof FOLLOW_UP_RESOLUTIONS)[number] } : {}),
        ...noteField,
      };
    else if (mode === 'snooze') body = { action: 'snooze', snoozeDays, ...noteField };
    else
      body = {
        action: 'dismiss',
        dismissReason: dismissReason as (typeof FOLLOW_UP_DISMISS_REASONS)[number],
        ...noteField,
      };
    setBusy(true);
    setError(null);
    updateFollowUp(item.id, body)
      .then(onDone)
      .catch((err: unknown) => {
        const key = twinErrorKey(err);
        // 请求本身合法时，忽略被 400 拒绝只有一种原因：危急类不能忽略（Q14）。
        // 危急类前端已不提供“忽略”，这里兜底（清单过期等情况）
        if (key === 'badRequest' && mode === 'dismiss') setError(t('followUps.errors.critical'));
        else setError(t(`followUps.errors.${key}`));
        // 这一项已经不在了或状态变了：刷新清单
        if (key === 'notFound' || key === 'conflict') onDone();
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{t('followUps.form.mode')}</legend>
        <div className={styles.choices}>
          {modes.map((m) => (
            <label key={m} className={styles.choice}>
              <input
                type="radio"
                name={`${id}-mode`}
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {t(`followUps.form.modes.${m}`)}
            </label>
          ))}
        </div>
        {!canDismiss && <p className={styles.muted}>{t('followUps.form.criticalNoDismiss')}</p>}
      </fieldset>

      {mode === 'done' && (
        <label className={styles.label}>
          {t('followUps.form.resolution')}
          <select
            className={styles.select}
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          >
            <option value="">{t('followUps.form.resolutionNone')}</option>
            {FOLLOW_UP_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {t(`followUps.form.resolutions.${r}`)}
              </option>
            ))}
          </select>
        </label>
      )}

      {mode === 'snooze' && (
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{t('followUps.form.snooze')}</legend>
          <div className={styles.choices}>
            {FOLLOW_UP_SNOOZE_DAYS.map((d) => (
              <label key={d} className={styles.choice}>
                <input
                  type="radio"
                  name={`${id}-snooze`}
                  value={d}
                  checked={snoozeDays === d}
                  onChange={() => setSnoozeDays(d)}
                />
                {t(`followUps.form.snoozeDays.${d}`)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {mode === 'dismiss' && (
        <label className={styles.label}>
          {t('followUps.form.dismissReason')}
          <select
            className={styles.select}
            value={dismissReason}
            aria-invalid={touched && dismissMissing ? true : undefined}
            onChange={(e) => setDismissReason(e.target.value)}
          >
            <option value="">{t('followUps.form.resolutionNone')}</option>
            {FOLLOW_UP_DISMISS_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`followUps.form.dismissReasons.${r}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {touched && dismissMissing && (
        <p className={styles.error} role="alert">
          {t('followUps.form.dismissRequired')}
        </p>
      )}

      <label className={styles.label}>
        {t('followUps.form.note', { max: FOLLOW_UP_NOTE_MAX })}
        <textarea
          className={styles.textarea}
          value={note}
          maxLength={FOLLOW_UP_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {touched && trimmedNote.length > FOLLOW_UP_NOTE_MAX && (
        <p className={styles.error} role="alert">
          {t('followUps.form.noteTooLong', { max: FOLLOW_UP_NOTE_MAX })}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('followUps.form.submitting') : t('followUps.form.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('followUps.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
