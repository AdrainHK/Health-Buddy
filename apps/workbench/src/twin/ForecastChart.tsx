import {
  matchesRule,
  type CriticalComparator,
  type CriticalThreshold,
  type TwinForecast,
  type TwinForecastDetailResponse,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { displayDate } from './errors';
import { formatNumber, useComparator, useMetricName, useRangeText } from './format';
import styles from './Twin.module.css';

const DAY_MS = 86_400_000;
const at = (iso: string) => Date.parse(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);

export interface ChartCrossing {
  side: 'high' | 'low';
  months: 3 | 6;
}

/**
 * 预测越过报告参考范围（规格 2.4，Q11）：按中间值找第一个越过上限（或下限）的预测点。
 * 只在图上和文字里提醒，不生成跟进项、不改状态。
 */
export function forecastCrossing(
  forecast: Pick<TwinForecast, 'status' | 'points'>,
  reference: TwinForecastDetailResponse['reference'],
): ChartCrossing | null {
  if (forecast.status !== 'ok' || !reference) return null;
  for (const p of forecast.points) {
    if (reference.high !== null && p.mid > reference.high)
      return { side: 'high', months: p.monthsAhead };
    if (reference.low !== null && p.mid < reference.low)
      return { side: 'low', months: p.monthsAhead };
  }
  return null;
}

/** 危急阈值里预测要用到的字段（GET /critical-thresholds，全平台一套） */
export type ForecastThreshold = Pick<
  CriticalThreshold,
  'metric' | 'comparator' | 'value' | 'enabled'
>;

export interface CriticalCrossing {
  side: 'high' | 'low';
  months: 3 | 6;
  comparator: CriticalComparator;
  value: number;
}

/**
 * 预测达到危急阈值（规格 2.4）：按中间值找第一个命中启用的危急阈值的预测点。
 * 和越过参考范围一样，只在图上和文字里提醒，不生成跟进项、不改状态。
 */
export function forecastCriticalCrossing(
  forecast: Pick<TwinForecast, 'status' | 'points' | 'metric'>,
  thresholds: readonly ForecastThreshold[] | null,
): CriticalCrossing | null {
  if (forecast.status !== 'ok' || !thresholds) return null;
  const rules = thresholds.filter((r) => r.enabled && r.metric === forecast.metric);
  for (const p of forecast.points) {
    const hit = rules.find((r) => matchesRule(r, p.mid));
    if (hit)
      return {
        side: hit.comparator === 'gte' || hit.comparator === 'gt' ? 'high' : 'low',
        months: p.monthsAhead,
        comparator: hit.comparator,
        value: hit.value,
      };
  }
  return null;
}

export interface CrossingReminder {
  kind: 'reference' | 'critical';
  side: 'high' | 'low';
  months: 3 | 6;
  text: string;
}

/** 两种越线提醒的文字（参考范围、危急阈值），危急的排在前面 */
export function useCrossings(): (
  forecast: TwinForecast,
  detail: TwinForecastDetailResponse | null,
  thresholds: readonly ForecastThreshold[] | null,
) => CrossingReminder[] {
  const { t } = useTranslation();
  const comparator = useComparator();
  return useCallback(
    (forecast, detail, thresholds) => {
      const out: CrossingReminder[] = [];
      const critical = forecastCriticalCrossing(forecast, thresholds);
      if (critical)
        out.push({
          kind: 'critical',
          side: critical.side,
          months: critical.months,
          text: t('twin.forecast.crossing.critical', {
            months: critical.months,
            comparator: comparator(critical.comparator),
            threshold: formatNumber(critical.value),
            unit: detail?.unit ?? '',
          }),
        });
      const reference = forecastCrossing(forecast, detail?.reference ?? null);
      if (reference)
        out.push({
          kind: 'reference',
          side: reference.side,
          months: reference.months,
          text: t(`twin.forecast.crossing.${reference.side}`, { months: reference.months }),
        });
      return out;
    },
    [t, comparator],
  );
}

/** 区间水平的显示：0.8 → 80（%），以及“10 次里有几次” */
export function intervalParams(level: number): { level: number; n: string } {
  return { level: Math.round(level * 100), n: formatNumber(level * 10) };
}

interface Size {
  width: number;
  height: number;
  pad: { left: number; right: number; top: number; bottom: number };
}

const SMALL: Size = { width: 300, height: 110, pad: { left: 6, right: 6, top: 8, bottom: 8 } };
const LARGE: Size = { width: 640, height: 260, pad: { left: 48, right: 16, top: 16, bottom: 28 } };

/**
 * 小图和大图（规格 2.4）：实线是实际数值，虚线是预测的中间值，阴影带是 80% 区间，
 * 浅色横带是最近一份报告上的参考范围。不确定性高时虚线和阴影更浅（data-uncertainty）。
 * 数据不足时只画实际数值，不画虚线。颜色全部来自 CSS 里的 --hb-* 令牌。
 */
export function ForecastSvg({
  forecast,
  detail,
  thresholds = null,
  large = false,
}: {
  forecast: TwinForecast;
  detail: TwinForecastDetailResponse | null;
  thresholds?: readonly ForecastThreshold[] | null;
  large?: boolean;
}) {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const crossingsFor = useCrossings();
  const size = large ? LARGE : SMALL;
  const actual = (detail?.actual ?? [])
    .filter((a) => a.source === forecast.source)
    .map((a) => ({ x: at(a.at), y: a.value, manual: a.manual, date: a.at }));
  const ok = forecast.status === 'ok' && forecast.points.length > 0;
  const points = ok ? forecast.points.map((p) => ({ ...p, x: at(p.date) })) : [];
  const reference = detail?.reference ?? null;

  const xs = [...actual.map((a) => a.x), ...points.map((p) => p.x)];
  const ys = [
    ...actual.map((a) => a.y),
    ...points.flatMap((p) => [p.low, p.high, p.mid]),
    ...(reference ? [reference.low, reference.high].filter((v): v is number => v !== null) : []),
  ];
  const label = t(ok ? 'twin.forecast.chartLabel' : 'twin.forecast.chartLabelNoForecast', {
    metric: metricName(forecast.metric),
    level: intervalParams(forecast.intervalLevel).level,
  });
  if (xs.length === 0 || ys.length === 0) {
    return (
      <svg
        className={styles.chart}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="img"
        aria-label={label}
      />
    );
  }
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMax - xMin < DAY_MS) {
    xMin -= DAY_MS;
    xMax += DAY_MS;
  }
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  const span = yMax - yMin || Math.abs(yMax) || 1;
  yMin -= span * 0.1;
  yMax += span * 0.1;
  const { width, height, pad } = size;
  const sx = (x: number) =>
    pad.left + ((x - xMin) / (xMax - xMin)) * (width - pad.left - pad.right);
  const sy = (y: number) =>
    pad.top + ((yMax - y) / (yMax - yMin)) * (height - pad.top - pad.bottom);
  const line = (pts: { x: number; y: number }[]) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
      .join(' ');

  // 预测从最后一个实际数值连出去（没有实际数值时从第一个预测点开始）
  const last = actual[actual.length - 1];
  const start = last ? { x: last.x, low: last.y, high: last.y, mid: last.y } : null;
  const band = start ? [start, ...points] : points;
  const bandPath =
    band.length > 1
      ? `${band.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.high).toFixed(1)}`).join(' ')} ${[
          ...band,
        ]
          .reverse()
          .map((p) => `L${sx(p.x).toFixed(1)},${sy(p.low).toFixed(1)}`)
          .join(' ')} Z`
      : null;
  const median = band.map((p) => ({ x: p.x, y: p.mid }));
  // 越线标记：同一个预测点上的提醒合成一个标记，图形是箭头（不和红色状态的“!”混淆），
  // <title> 里写明提醒文字，读屏和悬停都能看到
  const byMonths = new Map<number, CrossingReminder[]>();
  for (const c of crossingsFor(forecast, detail, thresholds))
    byMonths.set(c.months, [...(byMonths.get(c.months) ?? []), c]);
  const markers = [...byMonths].flatMap(([months, reminders]) => {
    const point = points.find((p) => p.monthsAhead === months);
    return point ? [{ point, reminders }] : [];
  });

  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      data-uncertainty={forecast.uncertainty ?? undefined}
      data-status={forecast.status}
    >
      {reference && (reference.low !== null || reference.high !== null) && (
        <rect
          className={styles.refBand}
          data-testid="reference-band"
          x={pad.left}
          width={width - pad.left - pad.right}
          y={sy(Math.min(reference.high ?? yMax, yMax))}
          height={Math.max(
            0,
            sy(Math.max(reference.low ?? yMin, yMin)) - sy(Math.min(reference.high ?? yMax, yMax)),
          )}
        />
      )}
      {large && (
        <g className={styles.axis} aria-hidden>
          <text x={pad.left - 6} y={sy(yMax - span * 0.1)} textAnchor="end">
            {formatNumber(yMax - span * 0.1)}
          </text>
          <text x={pad.left - 6} y={sy(yMin + span * 0.1)} textAnchor="end">
            {formatNumber(yMin + span * 0.1)}
          </text>
          <text x={pad.left} y={height - 8}>
            {displayDate(new Date(xMin).toISOString())}
          </text>
          <text x={width - pad.right} y={height - 8} textAnchor="end">
            {displayDate(new Date(xMax).toISOString())}
          </text>
        </g>
      )}
      {ok && bandPath && <path className={styles.band} data-testid="forecast-band" d={bandPath} />}
      {ok && median.length > 1 && (
        <path
          className={styles.median}
          data-testid="forecast-median"
          data-uncertainty={forecast.uncertainty ?? undefined}
          d={line(median)}
        />
      )}
      {actual.length > 1 && (
        <path className={styles.actual} data-testid="actual-line" d={line(actual)} />
      )}
      {actual.length <= 40 &&
        actual.map((a) => (
          <circle
            key={`${a.date}:${a.y}`}
            className={styles.actualDot}
            cx={sx(a.x)}
            cy={sy(a.y)}
            r={large ? 4 : 3}
          >
            <title>{`${displayDate(a.date)} ${formatNumber(a.y)}`}</title>
          </circle>
        ))}
      {markers.map(({ point, reminders }) => (
        <g
          key={point.monthsAhead}
          className={styles.crossing}
          data-testid="forecast-crossing"
          data-kind={reminders.map((r) => r.kind).join(' ')}
        >
          <title>{reminders.map((r) => r.text).join(' ')}</title>
          <circle cx={sx(point.x)} cy={sy(point.mid)} r={large ? 7 : 6} />
          <text
            x={sx(point.x)}
            y={sy(point.mid)}
            textAnchor="middle"
            dominantBaseline="central"
            aria-hidden
          >
            {reminders[0]!.side === 'high' ? '↗' : '↘'}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** 数据不足时的说明：还需要几次数据（规格 2.4，Q7） */
export function useInsufficientText(): (forecast: TwinForecast) => string {
  const { t } = useTranslation();
  return (forecast) => {
    if (forecast.insufficientReason === 'not_forecastable')
      return t('twin.forecast.insufficient.notForecastable');
    if (forecast.pointsNeeded !== null)
      return t(`twin.forecast.insufficient.${forecast.source}`, { count: forecast.pointsNeeded });
    return t('twin.forecast.insufficient.span');
  };
}

/** 小图卡片：点开看大图和依据 */
export function ForecastCard({
  forecast,
  detail,
  detailState,
  thresholds = null,
  onOpen,
}: {
  forecast: TwinForecast;
  detail: TwinForecastDetailResponse | null;
  detailState: 'loading' | 'ready' | 'error';
  thresholds?: readonly ForecastThreshold[] | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const insufficient = useInsufficientText();
  const metric = metricName(forecast.metric);
  const source = t(`twin.forecast.source.${forecast.source}`);
  const crossings = useCrossings()(forecast, detail, thresholds);
  return (
    <li className={styles.forecastItem}>
      <button
        type="button"
        className={styles.forecastCard}
        aria-label={t('twin.forecast.open', { metric, source })}
        onClick={onOpen}
      >
        <span className={styles.forecastHead}>
          <span className={styles.forecastTitle}>
            {t('twin.forecast.cardTitle', { metric, source })}
          </span>
          {forecast.status === 'ok' && forecast.uncertainty && (
            <span className={styles.uncertainty} data-uncertainty={forecast.uncertainty}>
              {t(`twin.forecast.uncertainty.${forecast.uncertainty}`)}
            </span>
          )}
        </span>
        <ForecastSvg forecast={forecast} detail={detail} thresholds={thresholds} />
        {detailState === 'loading' && !detail && (
          <span className={styles.muted}>{t('twin.forecast.loading')}</span>
        )}
        {detailState === 'error' && !detail && (
          <span className={styles.muted}>{t('twin.forecast.loadFailed')}</span>
        )}
        {forecast.status === 'insufficient_data' && (
          <span className={styles.muted} data-testid="forecast-insufficient">
            {insufficient(forecast)}
          </span>
        )}
        {crossings.length > 0 && (
          <span className={styles.crossingText} data-testid="forecast-crossing-text">
            {crossings.map((c) => c.text).join('')}
            <span className={styles.muted}>{t('twin.forecast.crossingNoteShort')}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/** 大图（规格 2.4）：下方固定写明依据、方法、区间含义、局限和不确定性等级 */
export function ForecastDialog({
  forecast,
  detail,
  thresholds = null,
  onClose,
}: {
  forecast: TwinForecast;
  detail: TwinForecastDetailResponse | null;
  thresholds?: readonly ForecastThreshold[] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const metricName = useMetricName();
  const range = useRangeText();
  const insufficient = useInsufficientText();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const metric = metricName(forecast.metric);
  const source = t(`twin.forecast.source.${forecast.source}`);
  const unit = detail?.unit ?? '';
  const crossings = useCrossings()(forecast, detail, thresholds);
  const interval = intervalParams(forecast.intervalLevel);
  const refText = detail?.reference ? range(detail.reference.low, detail.reference.high) : null;

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
            {t('twin.forecast.cardTitle', { metric, source })}
          </h4>
          <Button variant="ghost" onClick={onClose}>
            {t('twin.forecast.detail.close')}
          </Button>
        </header>
        <ForecastSvg forecast={forecast} detail={detail} thresholds={thresholds} large />
        <ul className={styles.legend}>
          <li data-series="actual">{t('twin.forecast.legend.actual')}</li>
          {forecast.status === 'ok' && (
            <>
              <li data-series="median" data-uncertainty={forecast.uncertainty ?? undefined}>
                {t('twin.forecast.legend.median')}
              </li>
              <li data-series="band">
                {t('twin.forecast.legend.band', { level: interval.level })}
              </li>
            </>
          )}
          {refText && <li data-series="reference">{t('twin.forecast.legend.reference')}</li>}
        </ul>
        {crossings.length > 0 && (
          <p className={styles.crossingText}>
            {crossings.map((c) => c.text).join('')}
            {t('twin.forecast.crossingNote')}
          </p>
        )}
        <div className={styles.explain}>
          {forecast.status === 'ok' && forecast.basis ? (
            <>
              <p>
                {forecast.basis.kind === 'report_values'
                  ? t('twin.forecast.detail.basisReport', {
                      from: forecast.basis.from,
                      to: forecast.basis.to,
                      count: forecast.nPoints,
                    })
                  : t('twin.forecast.detail.basisMonitoring', {
                      from: forecast.basis.from,
                      to: forecast.basis.to,
                      count: forecast.nPoints,
                    })}
              </p>
              <p>{t('twin.forecast.detail.method', { version: forecast.methodVersion })}</p>
              <p>{t('twin.forecast.detail.interval', interval)}</p>
              <p data-uncertainty={forecast.uncertainty ?? undefined}>
                {forecast.uncertainty === 'high'
                  ? t('twin.forecast.detail.uncertaintyHigh')
                  : t('twin.forecast.detail.uncertaintyNormal')}
              </p>
              <ul className={styles.pointList}>
                {forecast.points.map((p) => (
                  <li key={p.monthsAhead}>
                    {t('twin.forecast.detail.point', {
                      months: p.monthsAhead,
                      date: p.date,
                      mid: formatNumber(p.mid),
                      low: formatNumber(p.low),
                      high: formatNumber(p.high),
                      unit,
                      level: interval.level,
                    })}
                    {p.clipped && t('twin.forecast.detail.clipped')}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>{insufficient(forecast)}</p>
          )}
          <p>{t('twin.forecast.detail.limitation')}</p>
          {/* 规格 5.4 第 5 条：每张预测大图下方都标注 */}
          <p data-testid="forecast-disclaimer">{t('twin.disclaimer')}</p>
          {refText && <p>{t('twin.forecast.detail.reference', { range: refText, unit })}</p>}
          <p className={styles.muted}>
            {t('twin.forecast.detail.computedAt', { date: displayDate(forecast.computedAt) })}
          </p>
        </div>
      </div>
    </div>
  );
}
