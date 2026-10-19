import {
  compareFollowUps,
  type ClientSummary,
  type FollowUpItem,
  type TwinDomain,
  type TwinDomainView,
  type TwinForecast,
  type TwinForecastDetailResponse,
  type TwinRef,
  type TwinResponse,
} from '@health-buddy/shared';
import { Button, EmptyState } from '@health-buddy/ui';
import { Activity } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAbortError } from '../api/http';
import { getCriticalThresholds, getForecastDetail, getTwin, listFollowUps } from '../api/twin';
import { BodyOutline } from './BodyOutline';
import { twinErrorKey, type TwinErrorKey } from './errors';
import { FollowUpCard } from './FollowUpCard';
import { ForecastCard, ForecastDialog, type ForecastThreshold } from './ForecastChart';
import { ManualReadings } from './ManualReadings';
import { StatusCard } from './StatusCard';
import styles from './Twin.module.css';
import { TwinTimeline } from './TwinTimeline';
import { followUpTwinRef, useCanAskExpert, useTwinActions } from './TwinActions';

/** 队列还没算完时，隔一会儿重新读一次（先显示上一次的结果） */
export const TWIN_POLL_MS = 3000;

type DetailState = {
  status: 'loading' | 'ready' | 'error';
  detail: TwinForecastDetailResponse | null;
};

export interface TwinViewProps {
  client: ClientSummary;
  /** 手机宽度：人体轮廓缩小放在顶部，四个方面单列（data-layout="narrow"） */
  narrow?: boolean;
  /** 改变时重新加载（如对话里核对了报告） */
  refreshKey?: string;
  /** 点状态依据：切到“档案”子视图 */
  onOpenRecord: () => void;
  /** 孪生里处理了跟进项、调整了状态、录入了数据：左侧栏的角标和状态圆点据此刷新 */
  onTwinChanged?: () => void;
}

/**
 * 结果区“客户 · 孪生”（规格 2.2）。从上到下：固定提示条、画像（人体轮廓 + 四个方面的状态卡片）、
 * 趋势预测、待跟进、时间轴，以及手动录入监测数据（Q29）。
 * 状态、依据、预测全部由后端确定性计算，这里只按模板显示，不调用大模型。
 * “生成孪生小结”和“请专家看看”（专家预览打开时）都回到对话区，在这位客户的任务里预先填好，
 * 由健管师发送（M4 规格 2.6 之二、2.7）。
 */
export function TwinView({
  client,
  narrow = false,
  refreshKey,
  onOpenRecord,
  onTwinChanged,
}: TwinViewProps) {
  const { t } = useTranslation();
  const clientId = client.id;
  const [twin, setTwin] = useState<TwinResponse | null>(null);
  const [error, setError] = useState<TwinErrorKey | null>(null);
  const [version, setVersion] = useState(0);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [followUps, setFollowUps] = useState<FollowUpItem[] | null>(null);
  const [openForecast, setOpenForecast] = useState<TwinForecast | null>(null);
  // 危急阈值：读不到时只是少一条提醒，不影响其他内容
  const [thresholds, setThresholds] = useState<ForecastThreshold[] | null>(null);
  const cardRefs = useRef<Partial<Record<TwinDomain, HTMLElement | null>>>({});
  const actions = useTwinActions();
  const canAskExpert = useCanAskExpert();
  const askExpert = (ref: TwinRef, followUpItemId?: string) =>
    canAskExpert
      ? () =>
          actions.askExpert?.({
            client,
            ref,
            ...(followUpItemId ? { followUpItemId } : {}),
          })
      : undefined;

  useEffect(() => {
    setTwin((current) => (current?.client.id === clientId ? current : null));
    setDetails({});
    setFollowUps(null);
    setOpenForecast(null);
  }, [clientId]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const changed = useCallback(() => {
    reload();
    onTwinChanged?.();
  }, [reload, onTwinChanged]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    getTwin(clientId, controller.signal)
      .then(setTwin)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(twinErrorKey(err));
      });
    return () => controller.abort();
  }, [clientId, refreshKey, version]);

  // 正在更新：过一会儿再读，算完后显示新结果
  const computing = twin?.client.id === clientId && twin.computing;
  useEffect(() => {
    if (!computing) return;
    const timer = setTimeout(reload, TWIN_POLL_MS);
    return () => clearTimeout(timer);
  }, [computing, reload, twin]);

  // 预测小图要用历次实际数值：每个指标读一次大图数据
  // 预测有变化（新的一行）时才重新读
  const metricsKey =
    twin?.client.id === clientId && twin.forecasts.length > 0
      ? `${[...new Set(twin.forecasts.map((f) => f.metric))].sort().join(',')}|${twin.forecasts
          .map((f) => f.id)
          .sort()
          .join(',')}`
      : '';
  useEffect(() => {
    if (!metricsKey) return;
    const controller = new AbortController();
    for (const metric of metricsKey.split('|')[0]!.split(',')) {
      setDetails((d) => ({
        ...d,
        [metric]: { status: 'loading', detail: d[metric]?.detail ?? null },
      }));
      getForecastDetail(clientId, metric, controller.signal)
        .then((detail) => setDetails((d) => ({ ...d, [metric]: { status: 'ready', detail } })))
        .catch((err: unknown) => {
          if (!isAbortError(err))
            setDetails((d) => ({
              ...d,
              [metric]: { status: 'error', detail: d[metric]?.detail ?? null },
            }));
        });
    }
    return () => controller.abort();
  }, [clientId, metricsKey]);

  useEffect(() => {
    const controller = new AbortController();
    getCriticalThresholds(controller.signal)
      .then(setThresholds)
      .catch(() => {
        if (!controller.signal.aborted) setThresholds(null);
      });
    return () => controller.abort();
  }, [refreshKey]);

  // 这位客户未处理的跟进项
  useEffect(() => {
    const controller = new AbortController();
    listFollowUps({ clientId }, controller.signal)
      .then((res) => setFollowUps(res.items))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setFollowUps([]);
      });
    return () => controller.abort();
  }, [clientId, version, refreshKey]);

  const shown = twin?.client.id === clientId ? twin : null;

  const updateDomain = (next: TwinDomainView) => {
    setTwin((current) =>
      current
        ? {
            ...current,
            domains: current.domains.map((d) => (d.domain === next.domain ? next : d)),
          }
        : current,
    );
    onTwinChanged?.();
  };

  const focusCard = (domain: TwinDomain) => {
    const el = cardRefs.current[domain];
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    el?.focus();
  };

  if (!shown) {
    return (
      <div className={styles.twin} data-layout={narrow ? 'narrow' : 'wide'}>
        <ClientHeading client={client} />
        <Banner critical={false} />
        {error ? (
          <div className={styles.section} role="alert">
            <p className={styles.error}>
              {error === 'notFound' ? t('twin.notFound') : t('twin.loadFailed')}
            </p>
            <div>
              <Button onClick={reload}>{t('twin.retry')}</Button>
            </div>
          </div>
        ) : (
          <p className={styles.muted} role="status">
            {t('twin.loading')}
          </p>
        )}
      </div>
    );
  }

  const sortedFollowUps = [...(followUps ?? [])].sort(compareFollowUps);
  const detailFor = (f: TwinForecast) => details[f.metric] ?? { status: 'loading', detail: null };

  return (
    <div className={styles.twin} data-layout={narrow ? 'narrow' : 'wide'}>
      <ClientHeading client={shown.client} />
      <Banner critical={shown.hasOpenCritical} />
      {actions.summarize && shown.hasData && (
        <div className={styles.cardActions}>
          <Button onClick={() => actions.summarize?.(client)}>{t('twin.ai.summarize')}</Button>
          <span className={styles.muted}>{t('twin.ai.summarizeNote')}</span>
        </div>
      )}
      {shown.computing && (
        <p className={styles.computing} role="status" data-testid="twin-computing">
          <span className={styles.spinner} aria-hidden />
          {t('twin.computing')}
        </p>
      )}
      {!shown.hasData && (
        <EmptyState
          icon={<Activity size={20} />}
          title={t('twin.empty.title')}
          description={t('twin.empty.hint')}
        />
      )}

      <Section title={t('twin.portrait.title')}>
        <p className={styles.tierLine}>
          {t('twin.riskTier.label', {
            tier: shown.riskTier
              ? t(`record.tier.levels.${shown.riskTier.tier}`)
              : t('twin.riskTier.none'),
          })}
          <span className={styles.muted}> {t('twin.riskTier.note')}</span>
        </p>
        <div className={styles.portrait}>
          <BodyOutline domains={shown.domains} onSelect={focusCard} />
          <div className={styles.cards}>
            {shown.domains.map((view) => (
              <StatusCard
                key={view.domain}
                ref={(el) => {
                  cardRefs.current[view.domain] = el;
                }}
                clientId={clientId}
                view={view}
                onChanged={updateDomain}
                onOpenRecord={onOpenRecord}
                {...optional('onAskExpert', askExpert({ kind: 'domain', code: view.domain }))}
              />
            ))}
          </div>
        </div>
        <p className={styles.muted}>{t('twin.portrait.note')}</p>
        <p className={styles.muted} data-testid="twin-rules-note">
          {t('twin.portrait.rulesNote')}
        </p>
      </Section>

      {shown.hasData && (
        <Section title={t('twin.forecast.title')}>
          {shown.forecasts.length === 0 ? (
            <p className={styles.muted}>{t('twin.forecast.empty')}</p>
          ) : (
            <ul className={styles.forecastList}>
              {shown.forecasts.map((f) => (
                <ForecastCard
                  key={f.id}
                  forecast={f}
                  detail={detailFor(f).detail}
                  detailState={detailFor(f).status}
                  thresholds={thresholds}
                  onOpen={() => setOpenForecast(f)}
                />
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title={t('twin.followUps.title')}>
        {followUps !== null && sortedFollowUps.length === 0 && (
          <p className={styles.muted}>{t('twin.followUps.empty')}</p>
        )}
        {sortedFollowUps.length > 0 && (
          <ul className={styles.followUpList}>
            {sortedFollowUps.map((item) => {
              const ref = followUpTwinRef(item);
              return (
                <FollowUpCard
                  key={item.id}
                  item={item}
                  showClient={false}
                  onChanged={changed}
                  {...optional('onAskExpert', ref ? askExpert(ref, item.id) : undefined)}
                />
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={t('twin.timeline.title')}>
        <TwinTimeline clientId={clientId} refreshKey={version} />
      </Section>

      <ManualReadings clientId={clientId} onChanged={changed} />

      {openForecast && (
        <ForecastDialog
          forecast={openForecast}
          detail={detailFor(openForecast).detail}
          thresholds={thresholds}
          onClose={() => setOpenForecast(null)}
          {...optional('onAskExpert', askExpert({ kind: 'metric', code: openForecast.metric }))}
        />
      )}
    </div>
  );
}

/** exactOptionalPropertyTypes：没有值时不传这个属性 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function ClientHeading({ client }: { client: ClientSummary }) {
  const { t } = useTranslation();
  return (
    <h3 className={styles.clientName}>
      {client.displayName}
      {client.isSynthetic && <span className={styles.tag}>{t('record.synthetic')}</span>}
    </h3>
  );
}

/** 顶部提示条（规格 2.2）：固定“仅供参考，非医疗诊断”；有未处理的危急指标时变为醒目样式 */
function Banner({ critical }: { critical: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={styles.banner} data-variant={critical ? 'critical' : 'default'} role="note">
      {critical && (
        <strong className={styles.bannerCritical}>
          <span aria-hidden>! </span>
          {t('twin.criticalBanner')}
        </strong>
      )}
      <span>{t('twin.disclaimer')}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h5 id={id} className={styles.sectionTitle}>
        {title}
      </h5>
      {children}
    </section>
  );
}
