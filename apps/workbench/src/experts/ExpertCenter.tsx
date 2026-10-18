import { Button, EmptyState, IconButton } from '@health-buddy/ui';
import type { ExpertDetail, ExpertSource, ExpertSummary } from '@health-buddy/shared';
import { ArrowLeft, Menu, MessageCircleQuestion, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getExpert } from '../api/experts';
import { isAbortError } from '../api/http';
import { AiBadge, ExpertAvatar } from './ExpertBadges';
import styles from './Experts.module.css';

export interface ExpertListState {
  status: 'loading' | 'ready' | 'error';
  experts: ExpertSummary[];
}

export interface ExpertCenterProps {
  narrow: boolean;
  onOpenMenu: () => void;
  state: ExpertListState;
  onRetry: () => void;
  /** 点了“向 TA 提问”：新建绑定这位专家的任务，固定问一问（规格 2.3、Q9） */
  onAsk: (expert: ExpertSummary) => void;
}

/** 中间区域的专家库和专家详情（M3 规格 2.2） */
export function ExpertCenter({ narrow, onOpenMenu, state, onRetry, onAsk }: ExpertCenterProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ExpertSummary | null>(null);

  return (
    <main className={styles.center}>
      <header className={styles.topbar}>
        {narrow && (
          <IconButton
            label={t('nav.openMenu')}
            icon={<Menu size={18} />}
            aria-controls="hb-sidebar"
            onClick={onOpenMenu}
          />
        )}
        {selected && (
          <IconButton
            label={t('experts.back')}
            icon={<ArrowLeft size={18} />}
            onClick={() => setSelected(null)}
          />
        )}
        <h1 className={styles.topbarTitle}>{selected ? selected.name : t('experts.title')}</h1>
      </header>
      <div className={styles.scroll}>
        <div className={styles.column}>
          {selected ? (
            <ExpertDetailView summary={selected} onAsk={() => onAsk(selected)} />
          ) : (
            <ExpertLibrary state={state} onRetry={onRetry} onOpen={setSelected} />
          )}
        </div>
      </div>
    </main>
  );
}

function ExpertLibrary({
  state,
  onRetry,
  onOpen,
}: {
  state: ExpertListState;
  onRetry: () => void;
  onOpen: (expert: ExpertSummary) => void;
}) {
  const { t } = useTranslation();
  if (state.status === 'loading' && state.experts.length === 0) {
    return (
      <p className={styles.status} role="status">
        {t('experts.loading')}
      </p>
    );
  }
  if (state.status === 'error' && state.experts.length === 0) {
    return (
      <div className={styles.status} role="alert">
        <p>{t('experts.loadFailed')}</p>
        <Button onClick={onRetry}>{t('experts.retry')}</Button>
      </div>
    );
  }
  if (state.experts.length === 0) {
    return (
      <EmptyState
        icon={<Stethoscope size={20} />}
        title={t('experts.empty')}
        description={t('experts.emptyHint')}
      />
    );
  }
  return (
    <>
      <p className={styles.intro}>{t('experts.intro')}</p>
      <ul className={styles.grid} aria-label={t('experts.library')}>
        {state.experts.map((expert) => (
          <li key={expert.id}>
            <button
              type="button"
              className={styles.card}
              aria-label={t('experts.openDetail', { name: expert.name })}
              onClick={() => onOpen(expert)}
            >
              <span className={styles.cardHead}>
                <ExpertAvatar name={expert.name} />
                <span className={styles.name}>{expert.name}</span>
                <AiBadge />
              </span>
              <span className={styles.tagline}>{expert.tagline}</span>
              <ExpertStateBadges expert={expert} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 知识来源待确认（仅供试用，Q2）、已被平台暂停（Q11） */
function ExpertStateBadges({ expert }: { expert: ExpertSummary }) {
  const { t } = useTranslation();
  const pending = expert.sourcesPending || expert.status === 'review';
  if (!pending && expert.available) return null;
  return (
    <span className={styles.actions}>
      {pending && <span className={styles.pendingBadge}>{t('experts.pending')}</span>}
      {!expert.available && <span className={styles.pausedBadge}>{t('experts.paused')}</span>}
    </span>
  );
}

type DetailState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: ExpertDetail };

function ExpertDetailView({ summary, onAsk }: { summary: ExpertSummary; onAsk: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setState({ status: 'loading' });
    const controller = new AbortController();
    getExpert(summary.id, controller.signal)
      .then((detail) => setState({ status: 'ready', detail }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [summary.id, reload]);

  const expert = state.status === 'ready' ? state.detail : summary;
  const pending = expert.sourcesPending || expert.status === 'review';

  return (
    <article aria-labelledby="hb-expert-title">
      <div className={styles.detailHead}>
        <ExpertAvatar name={expert.name} />
        <div>
          <h2 id="hb-expert-title" className={styles.detailTitle}>
            {expert.name}
            <AiBadge />
          </h2>
          <p className={styles.tagline}>{expert.tagline}</p>
        </div>
      </div>

      {pending && (
        <p className={styles.notice} role="note">
          {t('experts.pending')}
        </p>
      )}
      {!expert.available && (
        <p className={styles.notice} role="note">
          {t('experts.pausedHint')}
        </p>
      )}
      <p className={styles.note}>{t('experts.aiNote')}</p>

      <div className={styles.meta}>
        <span>{t('experts.version', { version: expert.version })}</span>
        {state.status === 'ready' && (
          <span>{t('experts.usage', { count: state.detail.myUsageCount })}</span>
        )}
      </div>

      <div className={styles.actions}>
        <Button
          variant="primary"
          icon={<MessageCircleQuestion size={16} />}
          disabled={!expert.available}
          onClick={onAsk}
        >
          {t('experts.ask')}
        </Button>
      </div>

      {state.status === 'loading' && (
        <p className={styles.status} role="status">
          {t('experts.detailLoading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.status} role="alert">
          <p>{t('experts.detailFailed')}</p>
          <Button onClick={() => setReload((v) => v + 1)}>{t('experts.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && <DetailBody detail={state.detail} />}
    </article>
  );
}

function DetailBody({ detail }: { detail: ExpertDetail }) {
  const { t } = useTranslation();
  return (
    <>
      <section className={styles.section} aria-labelledby="hb-expert-strengths">
        <h3 id="hb-expert-strengths" className={styles.sectionTitle}>
          {t('experts.strengths')}
        </h3>
        <ul className={styles.bullets}>
          {detail.strengths.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </section>
      <section className={styles.section} aria-labelledby="hb-expert-out">
        <h3 id="hb-expert-out" className={styles.sectionTitle}>
          {t('experts.outOfScope')}
        </h3>
        <ul className={styles.bullets}>
          {detail.outOfScope.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <p className={styles.note}>{t('experts.outOfScopeHint')}</p>
      </section>
      <SourceList sources={detail.sources} />
    </>
  );
}

/** 按清单原文的病种分组，保持来源清单里的顺序 */
export function groupSources(
  sources: readonly ExpertSource[],
): { section: string | null; sources: ExpertSource[] }[] {
  const groups: { section: string | null; sources: ExpertSource[] }[] = [];
  for (const source of sources) {
    const last = groups.at(-1);
    if (last && last.section === source.section) last.sources.push(source);
    else {
      const existing = groups.find((g) => g.section === source.section);
      if (existing) existing.sources.push(source);
      else groups.push({ section: source.section, sources: [source] });
    }
  }
  return groups;
}

/**
 * 知识来源清单（规格 5.1、5.2 第 4 条）：列为来源文件原名、优先级、使用范围、确认状态。
 * 颁布机构和版本只在来源已确认时由后端返回，未确认时不显示。
 */
function SourceList({ sources }: { sources: readonly ExpertSource[] }) {
  const { t } = useTranslation();
  const groups = groupSources(sources);
  const columns = {
    name: t('experts.sources.columns.name'),
    priority: t('experts.sources.columns.priority'),
    scope: t('experts.sources.columns.scope'),
    status: t('experts.sources.columns.status'),
  };
  return (
    <section className={styles.section} aria-labelledby="hb-expert-sources">
      <h3 id="hb-expert-sources" className={styles.sectionTitle}>
        {t('experts.sources.title')}
      </h3>
      <p className={styles.note}>
        {t('experts.sources.count', { count: sources.length })} · {t('experts.sources.nameHint')}
      </p>
      {groups.map((group, index) => {
        const section = group.section ?? t('experts.sources.noSection');
        return (
          <details key={section} className={styles.sourceGroup} open={index === 0}>
            <summary>
              {t('experts.sources.sectionCount', { section, count: group.sources.length })}
            </summary>
            <table className={styles.table} aria-label={section}>
              <thead>
                <tr>
                  <th scope="col">{columns.name}</th>
                  <th scope="col">{columns.priority}</th>
                  <th scope="col">{columns.scope}</th>
                  <th scope="col">{columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {group.sources.map((s) => (
                  <tr key={s.sourceId}>
                    <td data-label={columns.name}>
                      {s.name}
                      {s.publisher && s.version && (
                        <span className={styles.sub}>
                          {t('experts.sources.publisherVersion', {
                            publisher: s.publisher,
                            version: s.version,
                          })}
                        </span>
                      )}
                    </td>
                    <td data-label={columns.priority}>
                      {t(`experts.sources.priority.${s.priority}`)}
                    </td>
                    <td data-label={columns.scope}>{t(`experts.sources.scope.${s.scope}`)}</td>
                    <td data-label={columns.status}>{t(`experts.sources.status.${s.status}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        );
      })}
    </section>
  );
}
