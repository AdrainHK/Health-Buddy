import type {
  ArtifactDetailResponse,
  ArtifactSummary,
  ClientSummary,
  ReportUploadSummary,
  Task,
} from '@health-buddy/shared';
import { Button, EmptyState, IconButton } from '@health-buddy/ui';
import { FileText, History, Plus, UserRound, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getArtifact } from '../api/artifacts';
import { isAbortError } from '../api/http';
import { listUploads } from '../api/reports';
import { getTask } from '../api/workbench';
import { ArtifactHistory } from '../artifacts/ArtifactHistory';
import { ArtifactList, sortArtifacts } from '../artifacts/ArtifactList';
import { ArtifactView } from '../artifacts/ArtifactView';
import { ClientForm } from '../record/ClientForm';
import { ClientRecord } from '../record/ClientRecord';
import { ReviewTab } from '../reports/ReviewTab';
import styles from './ResultsPanel.module.css';
import { isReadOnlyTask } from './taskGroups';

const TABS = ['artifacts', 'client', 'review', 'history'] as const;
type Tab = (typeof TABS)[number];

type LoadState = 'loading' | 'ready' | 'error';

export interface ResultsPanelProps {
  /** docked：宽屏固定在右侧；sheet：窄屏从右侧滑出。 */
  mode: 'docked' | 'sheet';
  open: boolean;
  onClose: () => void;
  /** 当前任务；为空时是欢迎页 */
  task?: Task | null;
  /** 当前任务关联的客户；任务还没关联时是输入框里 @ 的客户 */
  client?: ClientSummary | null;
  /**
   * 当前任务和产物有变化时改变，结果区据此重新加载。
   * 同一任务内变化（对话里生成了新草稿）时自动打开最新的产物。
   */
  refreshKey?: string;
  /** 结果区里的操作改变了产物或任务状态（确认、退回、发现任务只读等） */
  onArtifactsChanged?: () => void;
  /** 退回重写跑完了一轮生成，对话区需要重新加载 */
  onConversationChanged?: () => void;
  /** 在档案标签里新建了客户（Q13） */
  onClientCreated?: (client: ClientSummary) => void;
  /** 在档案标签里修改了客户的基本信息 */
  onClientSaved?: (client: ClientSummary) => void;
  /** 要打开核对界面的识别记录（对话区里点了“去核对”）；key 变了就重新打开 */
  reviewRequest?: { uploadId: string; key: number } | null;
  /** 识别记录有变化（对话里上传了报告）时改变，核对标签据此重新加载 */
  uploadsVersion?: number;
  /** 核对标签里的识别记录有变化（确认、放弃、重新识别） */
  onUploadsChanged?: () => void;
}

/** 右侧结果区：产物预览和审核、客户档案、修改记录（M1 规格 3.1、3.6；M2 规格 2.2） */
export function ResultsPanel({
  mode,
  open,
  onClose,
  task = null,
  client = null,
  refreshKey,
  onArtifactsChanged,
  onConversationChanged,
  onClientCreated,
  onClientSaved,
  reviewRequest = null,
  uploadsVersion = 0,
  onUploadsChanged,
}: ResultsPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('artifacts');
  /** 档案标签里正在新建客户 */
  const [creatingClient, setCreatingClient] = useState(false);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  /** 当前客户的识别记录（核对标签和角标）；看不到（非健管师）时为空列表 */
  const [uploads, setUploads] = useState<ReportUploadSummary[] | null>(null);
  const [uploadsReload, setUploadsReload] = useState(0);
  const [reviewId, setReviewId] = useState<string | null>(null);
  /** 档案需要重新加载（核对后写入了正式报告） */
  const [recordVersion, setRecordVersion] = useState(0);

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
  /** 当前打开的产物有未保存的修改时，不自动切到新产物，只提示 */
  const dirtyRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const [newerId, setNewerId] = useState<string | null>(null);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  // 在输入框里 @ 了一位客户（任务还没关联客户）：没有打开的产物时切到“客户”标签，
  // 让健管师马上看到资料。打开已关联客户的任务时仍停在产物标签。
  const clientId = client?.id ?? null;
  const fromDraft = task?.clientId == null;
  const seenClientRef = useRef<string | null>(null);
  useEffect(() => {
    if (seenClientRef.current === clientId) return;
    seenClientRef.current = clientId;
    if (clientId !== null && fromDraft && selectedRef.current === null) setTab('client');
  }, [clientId, fromDraft]);

  const readOnly = task !== null && (isReadOnlyTask(task) || readOnlyTaskId === task.id);

  // 识别记录：换客户时重新加载
  useEffect(() => {
    setReviewId(null);
    setUploads(null);
  }, [clientId]);
  useEffect(() => {
    if (clientId === null) return;
    const controller = new AbortController();
    listUploads(clientId, controller.signal)
      .then(setUploads)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setUploads([]);
      });
    return () => controller.abort();
  }, [clientId, uploadsVersion, uploadsReload]);

  // 对话区里点了“去核对”：切到核对标签打开那条记录
  const reviewKey = reviewRequest?.key ?? null;
  const reviewUploadId = reviewRequest?.uploadId ?? null;
  useEffect(() => {
    if (reviewUploadId === null) return;
    setReviewId(reviewUploadId);
    setTab('review');
  }, [reviewUploadId, reviewKey]);

  const uploadsChanged = useCallback(() => {
    setUploadsReload((v) => v + 1);
    setRecordVersion((v) => v + 1);
    onUploadsChanged?.();
  }, [onUploadsChanged]);
  const reviewCount = (uploads ?? []).filter((u) => u.status === 'needs_review').length;

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
      setNewerId(null);
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
          const current = selectedRef.current;
          if (dirtyRef.current && current !== null && current !== latest.id) {
            // 不覆盖健管师未保存的修改：留在当前产物，提示有新版本
            setNewerId(latest.id);
            return;
          }
          setNewerId(null);
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
    setNewerId((current) => (current === id ? null : current));
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
            newerArtifactId={newerId}
            onDirtyChange={onDirtyChange}
            {...(onConversationChanged ? { onRegenerated: onConversationChanged } : {})}
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
            {id === 'review' && reviewCount > 0 && (
              <span
                className={styles.badge}
                aria-label={t('reports.tab.badge', { count: reviewCount })}
              >
                {reviewCount}
              </span>
            )}
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
        {tab === 'client' && creatingClient && (
          <div className={styles.form}>
            <ClientForm
              onCancel={() => setCreatingClient(false)}
              onSaved={(created) => {
                setCreatingClient(false);
                onClientCreated?.(created);
              }}
            />
          </div>
        )}
        {tab === 'client' && !creatingClient && client && (
          <ClientRecord
            client={client}
            refreshKey={`${refreshKey ?? ''}:${recordVersion}`}
            onClientSaved={(saved) => onClientSaved?.(saved)}
            onNewClient={() => setCreatingClient(true)}
            onReportUploaded={() => {
              uploadsChanged();
              setReviewId(null);
              setTab('review');
            }}
          />
        )}
        {tab === 'client' && !creatingClient && !client && (
          <EmptyState
            icon={<UserRound size={20} />}
            title={t('results.empty.client')}
            description={t('results.empty.clientHint')}
            action={
              <Button
                variant="primary"
                icon={<Plus size={16} />}
                onClick={() => setCreatingClient(true)}
              >
                {t('record.newClient')}
              </Button>
            }
          />
        )}
        {tab === 'review' && (
          <ReviewTab
            client={client}
            uploads={uploads}
            selectedId={reviewId}
            onSelect={setReviewId}
            onChanged={uploadsChanged}
            taskId={task?.clientId && task.clientId === clientId ? task.id : null}
            readOnly={readOnly}
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
