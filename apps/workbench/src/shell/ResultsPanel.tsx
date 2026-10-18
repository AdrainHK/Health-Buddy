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
import { listTaskConsultations } from '../api/experts';
import { isAbortError } from '../api/http';
import { listUploads } from '../api/reports';
import { getTask } from '../api/workbench';
import { ArtifactHistory } from '../artifacts/ArtifactHistory';
import { ArtifactList, sortArtifacts } from '../artifacts/ArtifactList';
import { ArtifactView } from '../artifacts/ArtifactView';
import { type ConsultationListState, ExpertsTab } from '../experts/ExpertsTab';
import { ClientForm } from '../record/ClientForm';
import { ClientRecord } from '../record/ClientRecord';
import { ReviewTab } from '../reports/ReviewTab';
import styles from './ResultsPanel.module.css';
import { isReadOnlyTask } from './taskGroups';
import { readUrlId, writeUrlId } from './urlState';

const ALL_TABS = ['artifacts', 'experts', 'client', 'review', 'history'] as const;
type Tab = (typeof ALL_TABS)[number];

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
  /** 一次专家调用结束时改变，专家标签据此重新加载 */
  consultationsVersion?: number;
  /** 要切到专家标签（对话区里点了“查看专家意见”）；key 变了就重新切 */
  expertsTabRequest?: { key: number; consultationId: string | null } | null;
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
  consultationsVersion = 0,
  expertsTabRequest = null,
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
  /** 本任务的专家调用（专家标签，M3 规格 2.7）；没有调用时不显示这个标签 */
  const [consultations, setConsultations] = useState<ConsultationListState>({
    status: 'loading',
    consultations: [],
  });
  const [consultationsReload, setConsultationsReload] = useState(0);
  const [focusConsultation, setFocusConsultation] = useState<string | null>(null);
  const hasExperts = consultations.consultations.length > 0;
  const TABS = ALL_TABS.filter((id) => id !== 'experts' || hasExperts);

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
  /**
   * 刷新页面前打开的产物（记在地址栏）：任务恢复、产物列表加载后重新打开它
   * （验收反馈：刷新后产物和记录都空了）。列表里没有就不打开。
   */
  const restoringArtifactRef = useRef<string | null>(
    readUrlId('task') ? readUrlId('artifact') : null,
  );

  useEffect(() => {
    selectedRef.current = selectedId;
    // 恢复完成前不改地址栏，免得把要恢复的产物 id 清掉
    if (restoringArtifactRef.current === null) writeUrlId('artifact', selectedId);
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

  // 专家调用：换任务、生成了新草稿、一次专家调用结束时重新加载
  useEffect(() => {
    setConsultations((c) =>
      c.consultations[0] && c.consultations[0].taskId !== taskId
        ? { status: 'loading', consultations: [] }
        : { ...c, status: 'loading' },
    );
    if (taskId === null) return;
    const controller = new AbortController();
    listTaskConsultations(taskId, controller.signal)
      .then((list) => setConsultations({ status: 'ready', consultations: list }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setConsultations({ status: 'error', consultations: [] });
      });
    return () => controller.abort();
  }, [taskId, refreshKey, consultationsVersion, consultationsReload]);

  // 对话区里点了“查看专家意见”：切到专家标签，展开那一次调用
  const expertsRequestKey = expertsTabRequest?.key ?? null;
  const expertsRequestId = expertsTabRequest?.consultationId ?? null;
  useEffect(() => {
    if (expertsRequestKey === null) return;
    setFocusConsultation(expertsRequestId);
    setTab('experts');
  }, [expertsRequestKey, expertsRequestId]);

  const openExpertsTab = useCallback((consultationId: string | null) => {
    setFocusConsultation(consultationId);
    setTab('experts');
  }, []);

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
        const restoring = restoringArtifactRef.current;
        if (restoring !== null) {
          restoringArtifactRef.current = null;
          if (items.some((a) => a.id === restoring)) {
            setSelectedId(restoring);
            setDetailVersion((v) => v + 1);
            return;
          }
          writeUrlId('artifact', selectedRef.current);
        }
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
    const next = TABS[(TABS.indexOf(shownTab) + step + TABS.length) % TABS.length] ?? 'artifacts';
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  // 专家标签只在有专家调用时出现；没有了（换了任务）就回到产物标签
  const shownTab: Tab = tab === 'experts' && !hasExperts ? 'artifacts' : tab;

  const classes = [styles.panel, mode === 'sheet' && styles.sheet].filter(Boolean).join(' ');
  /** 产物标题里的客户称呼（只在健管师界面上显示） */
  const clientName = client?.displayName ?? null;
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
            clientName={clientName}
            consultation={
              consultations.consultations.find(
                (c) => c.id === shownDetail.artifact.consultationId,
              ) ?? null
            }
            onOpenExperts={openExpertsTab}
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
    return (
      <ArtifactList
        artifacts={artifacts}
        selectedId={selectedId}
        onSelect={openArtifact}
        clientName={clientName}
      />
    );
  };

  // 记录标签：打开了产物就显示它的版本和记录；还没打开时列出本任务的产物，点一个看它的记录
  // （验收反馈：刷新后记录页是空的）
  const renderHistory = () => {
    if (shownDetail) {
      return (
        <ArtifactHistory
          detail={shownDetail}
          clientName={clientName}
          onOpenVersion={(id) => {
            openArtifact(id);
            setTab('artifacts');
          }}
        />
      );
    }
    if (selectedId !== null && detailState !== 'error') {
      return (
        <p className={styles.status} role="status">
          {t('results.artifacts.loading')}
        </p>
      );
    }
    if (artifacts.length > 0) {
      return (
        <>
          <p className={styles.status}>{t('results.history.selectArtifact')}</p>
          <ArtifactList
            artifacts={artifacts}
            selectedId={selectedId}
            onSelect={openArtifact}
            clientName={clientName}
            label={t('results.history.pickArtifact')}
          />
        </>
      );
    }
    return (
      <EmptyState
        icon={<History size={20} />}
        title={t('results.empty.history')}
        description={t('results.history.selectArtifact')}
      />
    );
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
            aria-selected={shownTab === id}
            aria-controls={`hb-tabpanel-${id}`}
            tabIndex={shownTab === id ? 0 : -1}
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
        data-fill={shownTab === 'artifacts' && shownDetail !== null ? true : undefined}
        role="tabpanel"
        id={`hb-tabpanel-${shownTab}`}
        aria-labelledby={`hb-tab-${shownTab}`}
      >
        {shownTab === 'artifacts' && renderArtifacts()}
        {shownTab === 'experts' && (
          <ExpertsTab
            state={consultations}
            focusId={focusConsultation}
            onRetry={() => setConsultationsReload((v) => v + 1)}
          />
        )}
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
        {tab === 'history' && renderHistory()}
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
