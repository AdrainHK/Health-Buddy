import {
  HOME_DEFAULT_SKILLS,
  HOME_SECTION_LIMIT,
  HOME_SHORTCUT_EXPERTS,
  HOME_SHORTCUT_SKILLS,
  compareFollowUps,
  orderShortcuts,
  type ClientSummary,
  type ExpertSummary,
  type HomeDraft,
  type HomeResponse,
  type PlanFeatures,
  type SkillSummary,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getHome } from '../api/home';
import { isAbortError } from '../api/http';
import { useArtifactTitle } from '../artifacts/artifactTitle';
import care from '../care/Care.module.css';
import { VisitCard } from '../care/VisitCard';
import { AlertItem, HandoffItem } from '../companion/CompanionCases';
import type { CompanionInboxState } from '../companion/CompanionInbox';
import companion from '../companion/Companion.module.css';
import { useExperts } from '../experts/ExpertsContext';
import { useSkillName } from '../i18n/dynamic';
import { FollowUpCard } from '../twin/FollowUpCard';
import type { FollowUpListState, TodayVisitsState } from '../twin/FollowUpCenter';
import twin from '../twin/Twin.module.css';
import styles from './Home.module.css';

/**
 * 套餐关闭某个功能时，首页快捷入口里不显示的技能（M8 验收 11，M7 规格 2.5 第 4 条）。
 * 后端照样按套餐拒绝对应的接口，这里只是不显示入口。
 */
const FEATURE_SKILLS: Record<keyof PlanFeatures, readonly string[]> = {
  care: ['care-plan', 'visit-schedule', 'visit-script', 'visit-record', 'plan-and-visits'],
  twin: ['twin-summary', 'twin-review'],
  companion: ['handoff-reply', 'companion-follow-up'],
  experts: [],
};

export interface HomeSectionsProps {
  features: PlanFeatures | null;
  companion: CompanionInboxState;
  followUps: FollowUpListState;
  visits: TodayVisitsState;
  /** 重新加载伴侣、跟进和随访（三个分区各自重试） */
  onRetry: () => void;
  /** 在首页处理了预警、跟进或随访 */
  onChanged: () => void;
  onOpenClient: (clientId: string) => void;
  /** “查看全部”：打开今日跟进清单 */
  onViewAll: () => void;
  onOpenDraft: (draft: HomeDraft) => void;
  skills: readonly SkillSummary[];
  clients: readonly ClientSummary[];
  onUseSkill: (skill: SkillSummary) => void;
  onAskExpert: (expert: ExpertSummary) => void;
  /** 变了就重新读待审核草稿和快捷入口 */
  refreshKey?: number;
}

/**
 * 工作台首页（M8 规格 2.4，Q8、Q12）：显示在欢迎语和输入框下面。
 * 分区从上到下：伴侣预警和转交（永远第一，不受套餐和其他分区出错的影响，红线 4）、今日优先跟进、
 * 今日随访、待审核草稿、快捷入口。每个分区单独加载，最多显示 5 条。不调用模型。
 */
export function HomeSections({
  features,
  companion: inbox,
  followUps,
  visits,
  onRetry,
  onChanged,
  onOpenClient,
  onViewAll,
  onOpenDraft,
  skills,
  clients,
  onUseSkill,
  onAskExpert,
  refreshKey = 0,
}: HomeSectionsProps) {
  const [home, setHome] = useState<{
    status: 'loading' | 'ready' | 'error';
    data: HomeResponse | null;
  }>({ status: 'loading', data: null });
  const [homeReload, setHomeReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHome((h) => ({ status: 'loading', data: h.data }));
    getHome(controller.signal)
      .then((data) => setHome({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setHome((h) => ({ status: 'error', data: h.data }));
      });
    return () => controller.abort();
  }, [refreshKey, homeReload]);

  return (
    <div className={styles.home} data-testid="home">
      <CompanionSection
        state={inbox}
        onRetry={onRetry}
        onOpenClient={onOpenClient}
        onChanged={onChanged}
        onViewAll={onViewAll}
      />
      {features?.twin !== false && (
        <FollowUpSection
          state={followUps}
          onRetry={onRetry}
          onOpenClient={onOpenClient}
          onChanged={onChanged}
          onViewAll={onViewAll}
        />
      )}
      {features?.care !== false && (
        <VisitSection
          state={visits}
          onRetry={onRetry}
          onOpenClient={onOpenClient}
          onChanged={onChanged}
          onViewAll={onViewAll}
        />
      )}
      <DraftSection
        state={home}
        clients={clients}
        onRetry={() => setHomeReload((v) => v + 1)}
        onOpenDraft={onOpenDraft}
      />
      <ShortcutSection
        usage={home.data?.usage ?? null}
        features={features}
        skills={skills}
        onUseSkill={onUseSkill}
        onAskExpert={onAskExpert}
      />
    </div>
  );
}

function Section({
  title,
  count,
  onViewAll,
  children,
}: {
  title: string;
  count?: number | null | undefined;
  onViewAll?: (() => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <h2 id={id} className={care.groupTitle}>
          {title}
          {count != null && (
            <span className={care.groupCount}>{t('followUps.groups.count', { count })}</span>
          )}
        </h2>
        {onViewAll && (
          <button type="button" className={styles.viewAll} onClick={onViewAll}>
            {t('home.viewAll')}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function LoadStatus({
  status,
  hasData,
  errorText,
  onRetry,
}: {
  status: 'loading' | 'ready' | 'error';
  hasData: boolean;
  errorText: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  // 之前加载过、这次刷新失败：旧内容照常显示，另外提示可能已过时（合规审查 S1，避免漏看新预警）
  if (hasData && status === 'error')
    return (
      <div role="alert" className={styles.errorBox}>
        <p className={twin.error}>{t('home.refreshFailed')}</p>
        <Button onClick={onRetry}>{t('followUps.retry')}</Button>
      </div>
    );
  if (hasData) return null;
  if (status === 'loading')
    return (
      <p className={twin.muted} role="status">
        {t('followUps.loading')}
      </p>
    );
  if (status === 'error')
    return (
      <div role="alert" className={styles.errorBox}>
        <p className={twin.error}>{errorText}</p>
        <Button onClick={onRetry}>{t('followUps.retry')}</Button>
      </div>
    );
  return null;
}

function CompanionSection({
  state,
  onRetry,
  onOpenClient,
  onChanged,
  onViewAll,
}: {
  state: CompanionInboxState;
  onRetry: () => void;
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
  onViewAll: () => void;
}) {
  const { t } = useTranslation();
  const data = state.data;
  const total = data ? data.alerts.length + data.handoffs.length : null;
  // 预警在前，转交在后，合起来最多 5 条
  const alerts = data?.alerts.slice(0, HOME_SECTION_LIMIT) ?? [];
  const handoffs = data?.handoffs.slice(0, HOME_SECTION_LIMIT - alerts.length) ?? [];
  return (
    <Section
      title={t('home.sections.companion')}
      count={total}
      onViewAll={total ? onViewAll : undefined}
    >
      <LoadStatus
        status={state.status}
        hasData={Boolean(data)}
        errorText={t('companion.inbox.loadFailed')}
        onRetry={onRetry}
      />
      {total === 0 && <p className={twin.muted}>{t('home.empty.companion')}</p>}
      {alerts.length > 0 && (
        <ul className={companion.planList} aria-label={t('companion.inbox.alerts')}>
          {alerts.map((a) => (
            <AlertItem
              key={a.id}
              alert={a}
              showClient
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {handoffs.length > 0 && (
        <ul className={companion.planList} aria-label={t('companion.inbox.handoffs')}>
          {handoffs.map((h) => (
            <HandoffItem
              key={h.id}
              handoff={h}
              showClient
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function FollowUpSection({
  state,
  onRetry,
  onOpenClient,
  onChanged,
  onViewAll,
}: {
  state: FollowUpListState;
  onRetry: () => void;
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
  onViewAll: () => void;
}) {
  const { t } = useTranslation();
  const data = state.data;
  // 严重程度 1 级（红色）最先，后端和今日跟进清单同一个排序
  const items = [...(data?.items ?? [])].sort(compareFollowUps).slice(0, HOME_SECTION_LIMIT);
  return (
    <Section
      title={t('home.sections.followUps')}
      count={data?.openCount ?? null}
      onViewAll={data?.openCount ? onViewAll : undefined}
    >
      <LoadStatus
        status={state.status}
        hasData={Boolean(data)}
        errorText={t('followUps.loadFailed')}
        onRetry={onRetry}
      />
      {data && items.length === 0 && <p className={twin.muted}>{t('home.empty.followUps')}</p>}
      {items.length > 0 && (
        <ul className={twin.followUpList} aria-label={t('home.sections.followUps')}>
          {items.map((item) => (
            <FollowUpCard
              key={item.id}
              item={item}
              showClient
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function VisitSection({
  state,
  onRetry,
  onOpenClient,
  onChanged,
  onViewAll,
}: {
  state: TodayVisitsState;
  onRetry: () => void;
  onOpenClient: (clientId: string) => void;
  onChanged: () => void;
  onViewAll: () => void;
}) {
  const { t } = useTranslation();
  const data = state.data;
  const items = data?.items.slice(0, HOME_SECTION_LIMIT) ?? [];
  return (
    <Section
      title={t('home.sections.visits')}
      count={data?.count ?? null}
      onViewAll={data?.count ? onViewAll : undefined}
    >
      <LoadStatus
        status={state.status}
        hasData={Boolean(data)}
        errorText={t('followUps.visitsLoadFailed')}
        onRetry={onRetry}
      />
      {data && items.length === 0 && <p className={twin.muted}>{t('home.empty.visits')}</p>}
      {items.length > 0 && (
        <ul className={twin.followUpList} aria-label={t('home.sections.visits')}>
          {items.map((v) => (
            <VisitCard
              key={v.id}
              visit={v}
              clientName={v.clientName}
              overdueDays={v.overdueDays}
              onOpenClient={onOpenClient}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function DraftSection({
  state,
  clients,
  onRetry,
  onOpenDraft,
}: {
  state: { status: 'loading' | 'ready' | 'error'; data: HomeResponse | null };
  clients: readonly ClientSummary[];
  onRetry: () => void;
  onOpenDraft: (draft: HomeDraft) => void;
}) {
  const { t } = useTranslation();
  const title = useArtifactTitle();
  const [expanded, setExpanded] = useState(false);
  const drafts = state.data?.drafts ?? null;
  const items = drafts ? (expanded ? drafts.items : drafts.items.slice(0, HOME_SECTION_LIMIT)) : [];
  const clientName = (id: string | null) =>
    id ? (clients.find((c) => c.id === id)?.displayName ?? null) : null;
  return (
    <Section
      title={t('home.sections.drafts')}
      count={drafts?.total ?? null}
      onViewAll={
        drafts && !expanded && drafts.items.length > HOME_SECTION_LIMIT
          ? () => setExpanded(true)
          : undefined
      }
    >
      <LoadStatus
        status={state.status}
        hasData={Boolean(state.data)}
        errorText={t('home.draftsLoadFailed')}
        onRetry={onRetry}
      />
      {drafts && drafts.total === 0 && <p className={twin.muted}>{t('home.empty.drafts')}</p>}
      {items.length > 0 && (
        <ul className={styles.draftList} aria-label={t('home.sections.drafts')}>
          {items.map((d) => (
            <li key={d.artifactId}>
              <button type="button" className={styles.draftItem} onClick={() => onOpenDraft(d)}>
                <span className={styles.draftTitle}>{title(d, clientName(d.clientId))}</span>
                <span className={styles.draftMeta}>
                  {d.taskTitle}
                  {d.hasCriticalFlags && (
                    <span className={styles.critical}>{t('home.draftCritical')}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {expanded && drafts && drafts.total > drafts.items.length && (
        <p className={twin.muted}>{t('home.draftsMore', { count: drafts.items.length })}</p>
      )}
    </Section>
  );
}

function ShortcutSection({
  usage,
  features,
  skills,
  onUseSkill,
  onAskExpert,
}: {
  usage: HomeResponse['usage'] | null;
  features: PlanFeatures | null;
  skills: readonly SkillSummary[];
  onUseSkill: (skill: SkillSummary) => void;
  onAskExpert: (expert: ExpertSummary) => void;
}) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  const experts = useExperts();
  const hidden = new Set(
    (Object.keys(FEATURE_SKILLS) as (keyof PlanFeatures)[])
      .filter((f) => features?.[f] === false)
      .flatMap((f) => FEATURE_SKILLS[f]),
  );
  const skillIds = orderShortcuts(
    usage?.skills ?? [],
    HOME_DEFAULT_SKILLS,
    skills.map((s) => s.id).filter((id) => !hidden.has(id)),
    HOME_SHORTCUT_SKILLS,
  );
  const expertIds =
    features?.experts === false
      ? []
      : orderShortcuts(
          usage?.experts ?? [],
          [],
          experts.filter((e) => e.available).map((e) => e.id),
          HOME_SHORTCUT_EXPERTS,
        );
  if (skillIds.length === 0 && expertIds.length === 0) return null;
  return (
    <Section title={t('home.sections.shortcuts')}>
      <ul className={styles.shortcuts} aria-label={t('home.shortcutSkills')}>
        {skillIds.map((id) => {
          const skill = skills.find((s) => s.id === id);
          if (!skill) return null;
          return (
            <li key={id}>
              <button type="button" className={styles.shortcut} onClick={() => onUseSkill(skill)}>
                /{skillName(id)}
              </button>
            </li>
          );
        })}
      </ul>
      {expertIds.length > 0 && (
        <ul className={styles.shortcuts} aria-label={t('home.shortcutExperts')}>
          {expertIds.map((id) => {
            const expert = experts.find((e) => e.id === id);
            if (!expert) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  className={styles.shortcut}
                  onClick={() => onAskExpert(expert)}
                >
                  @{expert.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
