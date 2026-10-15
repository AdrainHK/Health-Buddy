import type { ArtifactDetailResponse, ArtifactSummary, Task } from '@health-buddy/shared';
import { Button, EmptyState, IconButton } from '@health-buddy/ui';
import { FileText, History, UserRound, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getArtifact } from '../api/artifacts';
import { isAbortError } from '../api/http';
import { getTask } from '../api/workbench';
import { ArtifactHistory } from '../artifacts/ArtifactHistory';
import { ArtifactList, sortArtifacts } from '../artifacts/ArtifactList';
import { ArtifactView } from '../artifacts/ArtifactView';
import styles from './ResultsPanel.module.css';
import { isReadOnlyTask } from './taskGroups';

const TABS = ['artifacts', 'client', 'history'] as const;
type Tab = (typeof TABS)[number];

type LoadState = 'loading' | 'ready' | 'error';

export interface ResultsPanelProps {
  /** docked：宽屏固定在右侧；sheet：窄屏从右侧滑出。 */
  mode: 'docked' | 'sheet';
  open: boolean;
  onClose: () => void;
  /** 当前任务；为空时是欢迎页 */
  task?: Task | null;
  /**
   * 当前任务和产物有变化时改变，结果区据此重新加载。
   * 同一任务内变化（对话里生成了新草稿）时自动打开最新的产物。
   */
  refreshKey?: string;
  /** 结果区里的操作改变了产物或任务状态（确认、退回、发现任务只读等） */
  onArtifactsChanged?: () => void;
}

/** 右侧结果区：产物预览和审核、客户档案、修改记录（M1 规格 3.1、3.6） */
export function ResultsPanel({
  mode,
  open,
  onClose,
  task = null,
  refreshKey,
  onArtifactsChanged,
}: ResultsPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('artifacts');
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const taskId = task?.id ?? null;
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [listState, setListState] = useState<LoadState>('loading');
  const [listVersion, setListVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArtifactDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('loading');
  const [detailVersion, setDetailVersion] = useState(0);
  /** 操作时后端报告任务只读（409 read_only），在任务列表刷新前先禁用操作 */
  const [readOnlyTaskId, setReadOnlyTaskId] = useState<string | null>(null);

  const seenRef = useRef<{ taskId: string | null; refreshKey: string | undefined }>({
    taskId: null,
    refreshKey: undefined,
  });
  /** 已经拿到的详情（如“基于此版修改”的响应），打开时不再请求 */
  const preloadedRef = useRef<ArtifactDetailResponse | null>(null);

  const readOnly = task !== null && (isReadOnlyTask(task) || readOnlyTaskId === task.id);

  // 产物列表：来自任务详情。换任务时回到列表；同一任务里刷新时打开最新的产物。
  useEffect(() => {
    const seen = seenRef.current;
    const taskChanged = seen.taskId !== taskId;
    const openLatest = !taskChanged && seen.refreshKey !== refreshKey;
    seenRef.current = { taskId, refreshKey };
    if (taskChanged) {
      setArtifacts([]);
      setSelectedId(null);
      setDetail(null);
      setListState('loading');
    }
    if (taskId === null) return;
    const controller = new AbortController();
    getTask(taskId, controller.signal)
      .then(({ artifacts: items }) => {
        setArtifacts(items);
        setListState('ready');
        const latest = sortArtifacts(items)[0];
        if (openLatest && latest) {
          setSelectedId(latest.id);
          setDetailVersion((v) => v + 1);
          setTab('artifacts');
        }
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setListState('error');
      });
    return () => controller.abort();
  }, [taskId, refreshKey, listVersion]);

  // 产物详情
  useEffect(() => {
    if (selectedId === null) return;
    const preloaded = preloadedRef.current;
    preloadedRef.current = null;
    if (preloaded && preloaded.artifact.id === selectedId) {
      setDetail(preloaded);
      setDetailState('ready');
      return;
    }
    setDetail((current) => (current?.artifact.id === selectedId ? current : null));
    setDetailState('loading');
    const controller = new AbortController();
    getArtifact(selectedId, controller.signal)
      .then((next) => {
        setDetail(next);
        setDetailState('ready');
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setDetailState('error');
      });
    return () => controller.abort();
  }, [selectedId, detailVersion]);

  const refreshList = useCallback(() => {
    setListVersion((v) => v + 1);
    onArtifactsChanged?.();
  }, [onArtifactsChanged]);

  const openArtifact = useCallback((id: string, preloaded?: ArtifactDetailResponse) => {
    preloadedRef.current = preloaded ?? null;
    setSelectedId(id);
    setDetailVersion((v) => v + 1);
  }, []);

  // 方向键切换标签，符合 WAI-ARIA tabs 规范。
  const onTabKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? 'artifacts';
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const classes = [styles.panel, mode === 'sheet' && styles.sheet].filter(Boolean).join(' ');
  const shownDetail = detail && detail.artifact.id === selectedId ? detail : null;

  const renderArtifacts = () => {
    if (taskId === null || (listState === 'ready' && artifacts.length === 0)) {
      return (
        <EmptyState
          icon={<FileText size={20} />}
          title={t('results.empty.artifacts')}
          description={t('results.empty.artifactsHint')}
        />
      );
    }
    if (selectedId !== null) {
      if (shownDetail) {
        return (
          <ArtifactView
            key={shownDetail.artifact.id}
            detail={shownDetail}
            readOnly={readOnly}
            onDetail={setDetail}
            onReload={() => {
              setDetailVersion((v) => v + 1);
              refreshList();
            }}
            onOpen={openArtifact}
            onChanged={refreshList}
            onReadOnly={() => {
              setReadOnlyTaskId(taskId);
              onArtifactsChanged?.();
            }}
            onBack={() => setSelectedId(null)}
          />
        );
      }
      return detailState === 'error' ? (
        <LoadError onRetry={() => setDetailVersion((v) => v + 1)} />
      ) : (
        <p className={styles.status} role="status">
          {t('results.artifacts.loading')}
        </p>
      );
    }
    if (listState === 'error' && artifacts.length === 0) {
      return <LoadError onRetry={() => setListVersion((v) => v + 1)} />;
    }
    if (listState === 'loading' && artifacts.length === 0) {
      return (
        <p className={styles.status} role="status">
          {t('results.artifacts.loading')}
        </p>
      );
    }
    return <ArtifactList artifacts={artifacts} selectedId={selectedId} onSelect={openArtifact} />;
  };

  return (
    <aside
      id="hb-results"
      className={classes}
      data-open={open}
      aria-labelledby="hb-results-title"
      aria-hidden={!open ? true : undefined}
      inert={!open ? true : undefined}
    >
      <div className={styles.header}>
        <h2 id="hb-results-title" className={styles.title}>
          {t('results.title')}
        </h2>
        <IconButton label={t('results.close')} icon={<X size={18} />} onClick={onClose} />
      </div>

      <div className={styles.tabs} role="tablist" aria-label={t('results.title')}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`hb-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`hb-tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={styles.tab}
            onClick={() => setTab(id)}
            onKeyDown={onTabKeyDown}
          >
            {t(`results.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div
        className={styles.content}
        data-fill={tab === 'artifacts' && shownDetail !== null ? true : undefined}
        role="tabpanel"
        id={`hb-tabpanel-${tab}`}
        aria-labelledby={`hb-tab-${tab}`}
      >
        {tab === 'artifacts' && renderArtifacts()}
        {tab === 'client' && (
          <EmptyState
            icon={<UserRound size={20} />}
            title={t('results.empty.client')}
            description={t('results.empty.clientHint')}
          />
        )}
        {tab === 'history' &&
          (shownDetail ? (
            <ArtifactHistory
              detail={shownDetail}
              onOpenVersion={(id) => {
                openArtifact(id);
                setTab('artifacts');
              }}
            />
          ) : (
            <EmptyState
              icon={<History size={20} />}
              title={t('results.empty.history')}
              description={t('results.history.selectArtifact')}
            />
          ))}
      </div>
    </aside>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.status} role="alert">
      <p>{t('results.artifacts.loadFailed')}</p>
      <Button onClick={onRetry}>{t('results.artifacts.retry')}</Button>
    </div>
  );
}
