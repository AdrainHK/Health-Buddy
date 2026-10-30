import type {
  ClientSummary,
  ExpertSummary,
  SkillSummary,
  Task,
  TwinLevel,
} from '@health-buddy/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listExperts } from '../api/experts';
import { isAbortError } from '../api/http';
import { ExpertCenter, type ExpertListState } from '../experts/ExpertCenter';
import { ExpertsContext } from '../experts/ExpertsContext';
import { getTodayVisits } from '../api/care';
import { getCompanionInbox } from '../api/companion';
import { companionInboxCount, type CompanionInboxState } from '../companion/CompanionInbox';
import { getTwinLevels, listFollowUps } from '../api/twin';
import {
  createTask,
  getTask,
  listClients,
  listSkills,
  listTasks,
  updateTask,
} from '../api/workbench';
import { PlanLibrary } from '../care/PlanLibrary';
import {
  FollowUpCenter,
  type FollowUpListState,
  type TodayVisitsState,
} from '../twin/FollowUpCenter';
import {
  TwinActionsContext,
  useTwinRefLabel,
  type TwinActions,
  type TwinConsultRequest,
} from '../twin/TwinActions';
import styles from './AppShell.module.css';
import { ChatPane, type ComposerPrefill } from './ChatPane';
import { ResultsPanel } from './ResultsPanel';
import { Sidebar, type SidebarAccount, type TaskListState, type TaskListView } from './Sidebar';
import { isReadOnlyTask } from './taskGroups';
import { readUrlId, writeUrlId } from './urlState';
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery';

/**
 * 工作台三栏布局：左侧栏、中间对话区、右侧结果区。
 * 宽屏时三栏并排；窄屏时侧栏和结果区都改为浮层，同一时间最多打开一个。
 */
export interface AppShellProps {
  /** 当前登录的账号，显示在侧栏底部。 */
  account?: SidebarAccount;
}

export function AppShell({ account }: AppShellProps = {}) {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(!narrow);

  const [view, setView] = useState<TaskListView>('active');
  const [taskList, setTaskList] = useState<TaskListState>({ status: 'loading', tasks: [] });
  const [listVersion, setListVersion] = useState(0);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [artifactsVersion, setArtifactsVersion] = useState(0);
  /** 对话在对话区之外有了变化（结果区里退回重写），对话区据此重新加载 */
  const [conversationVersion, setConversationVersion] = useState(0);
  /** 对话区里 @ 的客户（任务还没关联客户时用来在结果区显示资料） */
  const [draftClient, setDraftClient] = useState<ClientSummary | null>(null);
  /**
   * 结果区先显示的客户：刚在档案标签里新建的，或在左侧栏客户列表里点的（M4）。
   * 换任务或 @ 了别的客户后恢复为任务关联的客户。
   */
  const [focusClientId, setFocusClientId] = useState<string | null>(null);
  /** 对话区里点了“去核对”的识别记录 */
  const [reviewRequest, setReviewRequest] = useState<{ uploadId: string; key: number } | null>(
    null,
  );
  /** 识别记录有变化（对话里上传、识别结束、核对确认），对话区和结果区据此刷新 */
  const [uploadsVersion, setUploadsVersion] = useState(0);
  /** 中间区域显示对话、专家库（M3 规格 2.1）、今日跟进清单（M4 规格 2.6，Q12）还是方案库（M5 规格 2.4） */
  const [centerView, setCenterView] = useState<'chat' | 'experts' | 'followUps' | 'library'>(
    'chat',
  );
  /** 今日跟进清单（所有客户的未处理项目），左侧栏角标也用它 */
  const [followUpList, setFollowUpList] = useState<FollowUpListState>({
    status: 'loading',
    data: null,
  });
  /** 今日随访（M5 规格 2.7，Q19）：今日跟进入口的第二个分组，角标是两组之和 */
  const [todayVisits, setTodayVisits] = useState<TodayVisitsState>({
    status: 'loading',
    data: null,
  });
  /** 今日跟进的“伴侣”分组（M6 规格 2.8）：角标加上它的三组；有未处理预警的客户在列表里标红点 */
  const [companionInbox, setCompanionInbox] = useState<CompanionInboxState>({
    status: 'loading',
    data: null,
  });
  /** 每位客户的孪生整体状态（左侧栏客户列表的小圆点） */
  const [twinLevels, setTwinLevels] = useState<ReadonlyMap<string, TwinLevel>>(new Map());
  /** 跟进、状态有变化：角标、清单和圆点重新加载 */
  const [twinSummaryVersion, setTwinSummaryVersion] = useState(0);
  /** 在中间的清单里处理了跟进项：结果区的孪生重新加载 */
  const [twinPanelVersion, setTwinPanelVersion] = useState(0);
  /** 在左侧栏点了客户：结果区切到“客户 · 孪生” */
  const [clientTabRequest, setClientTabRequest] = useState<{ key: number } | null>(null);
  /** 当前账号可用的专家：专家库、@ 列表、步骤和专家标签里的名称都用它 */
  const [expertList, setExpertList] = useState<ExpertListState>({
    status: 'loading',
    experts: [],
  });
  const [expertsReload, setExpertsReload] = useState(0);
  /** 在专家中心点了“向 TA 提问”、还没发出第一条消息 */
  const [pendingExpert, setPendingExpert] = useState<ExpertSummary | null>(null);
  /** 一次专家调用结束，结果区的专家标签据此刷新 */
  const [consultationsVersion, setConsultationsVersion] = useState(0);
  /** 孪生里点了“请专家看看”“生成孪生小结”：对话区在这位客户的任务里预先填好输入框 */
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);
  /** 对话区里点了“查看专家意见”：结果区切到专家标签 */
  const [expertsTabRequest, setExpertsTabRequest] = useState<{
    key: number;
    consultationId: string | null;
  } | null>(null);

  // 刷新页面后恢复当前任务（验收反馈：刷新后产物和记录都空了）。任务 id 记在地址栏，
  // 恢复时按 id 重新取任务，后端按行级安全判断；取不到（别人的、已删除）就回到欢迎页
  const restoringTaskRef = useRef<string | null>(readUrlId('task'));
  useEffect(() => {
    const id = restoringTaskRef.current;
    if (!id) return;
    const controller = new AbortController();
    getTask(id, controller.signal)
      .then(({ task }) => {
        restoringTaskRef.current = null;
        // 恢复期间健管师已经点了别的任务或新建了任务：以健管师的操作为准
        setActiveTask((current) => current ?? task);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        restoringTaskRef.current = null;
        writeUrlId('task', null);
        writeUrlId('artifact', null);
      });
    return () => controller.abort();
  }, []);
  const activeTaskId = activeTask?.id ?? null;
  useEffect(() => {
    if (restoringTaskRef.current !== null && activeTaskId === null) return;
    restoringTaskRef.current = null;
    writeUrlId('task', activeTaskId);
  }, [activeTaskId]);

  // 技能和客户列表：/ 和 @ 补全、任务按客户分组都要用
  useEffect(() => {
    let cancelled = false;
    listSkills()
      .then((items) => !cancelled && setSkills(items))
      .catch(() => {});
    listClients()
      .then((items) => !cancelled && setClients(items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 今日跟进清单和客户状态圆点（孪生不调用大模型，只读后端算好的结果）
  useEffect(() => {
    const controller = new AbortController();
    setFollowUpList((list) => ({ status: 'loading', data: list.data }));
    listFollowUps({}, controller.signal)
      .then((data) => setFollowUpList({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setFollowUpList((list) => ({ status: 'error', data: list.data }));
      });
    setTodayVisits((v) => ({ status: 'loading', data: v.data }));
    getTodayVisits(controller.signal)
      .then((data) => setTodayVisits({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setTodayVisits((v) => ({ status: 'error', data: v.data }));
      });
    setCompanionInbox((v) => ({ status: 'loading', data: v.data }));
    getCompanionInbox(controller.signal)
      .then((data) => setCompanionInbox({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setCompanionInbox((v) => ({ status: 'error', data: v.data }));
      });
    getTwinLevels(controller.signal)
      .then((levels) => setTwinLevels(new Map(levels.map((l) => [l.clientId, l.level]))))
      .catch(() => {});
    return () => controller.abort();
  }, [twinSummaryVersion]);

  const onTwinChanged = useCallback(() => setTwinSummaryVersion((v) => v + 1), []);
  const onFollowUpsChanged = useCallback(() => {
    setTwinSummaryVersion((v) => v + 1);
    setTwinPanelVersion((v) => v + 1);
  }, []);

  // 专家列表（专家预览没开时为空，所有专家入口都不显示内容）
  useEffect(() => {
    const controller = new AbortController();
    setExpertList((list) => ({ status: 'loading', experts: list.experts }));
    listExperts(controller.signal)
      .then((experts) => setExpertList({ status: 'ready', experts }))
      .catch((err: unknown) => {
        if (!isAbortError(err))
          setExpertList((list) => ({ status: 'error', experts: list.experts }));
      });
    return () => controller.abort();
  }, [expertsReload]);

  // 任务列表。刷新时保留旧列表，避免闪烁；当前任务换成最新的数据（比如刚关联了客户、变成只读）
  useEffect(() => {
    let cancelled = false;
    listTasks({ archived: view === 'archived' })
      .then((tasks) => {
        if (cancelled) return;
        setTaskList({ status: 'ready', tasks });
        setActiveTask((current) =>
          current ? (tasks.find((task) => task.id === current.id) ?? current) : current,
        );
      })
      .catch(() => {
        if (!cancelled) setTaskList((list) => ({ status: 'error', tasks: list.tasks }));
      });
    return () => {
      cancelled = true;
    };
  }, [view, listVersion]);

  const refreshTasks = useCallback(() => setListVersion((v) => v + 1), []);

  const changeView = (next: TaskListView) => {
    if (next === view) return;
    setTaskList({ status: 'loading', tasks: [] });
    setView(next);
  };

  const closeDrawerOnNarrow = () => {
    if (narrow) setDrawerOpen(false);
  };

  const selectTask = (task: Task | null) => {
    setActiveTask(task);
    setFocusClientId(null);
    setPendingExpert(null);
    setCenterView('chat');
    closeDrawerOnNarrow();
  };

  const openExpertCenter = () => {
    setCenterView('experts');
    closeDrawerOnNarrow();
  };

  const openLibrary = () => {
    setCenterView('library');
    closeDrawerOnNarrow();
  };

  const openFollowUps = () => {
    setCenterView('followUps');
    setTwinSummaryVersion((v) => v + 1);
    closeDrawerOnNarrow();
  };

  /**
   * 左侧栏点客户（M4 规格 2.2 第 1 条）：进入该客户的任务分组（打开这位客户最近的任务，
   * 没有就回到欢迎页），右侧结果区打开“客户 · 孪生”。
   */
  const selectClient = (client: ClientSummary) => {
    setPendingExpert(null);
    setCenterView('chat');
    if (activeTask?.clientId !== client.id) {
      const latest =
        view === 'active'
          ? taskList.tasks
              .filter((task) => task.clientId === client.id && !isReadOnlyTask(task))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
          : undefined;
      setActiveTask(latest ?? null);
    }
    setFocusClientId(client.id);
    setClientTabRequest((r) => ({ key: (r?.key ?? 0) + 1 }));
    setDrawerOpen(false);
    setResultsOpen(true);
  };

  const openClientById = (clientId: string) => {
    const client = clients?.find((c) => c.id === clientId);
    if (client) selectClient(client);
  };

  /** 专家详情里的“向 TA 提问”：回到对话区，发第一条消息时新建绑定这位专家的任务 */
  const askExpert = (expert: ExpertSummary) => {
    setActiveTask(null);
    setFocusClientId(null);
    setPendingExpert(expert);
    setCenterView('chat');
  };

  /**
   * 孪生里的操作回到对话区（M4 规格 2.6 之二、2.7）：用这位客户正在进行的任务（当前任务或最近一个），
   * 没有就新建一个，标题如“孪生 · 心血管（2026-10-19）”。输入框预先填好，由健管师发送。
   */
  const twinRefLabel = useTwinRefLabel();
  const prefillSeq = useRef(0);
  const openClientTask = async (
    client: Pick<ClientSummary, 'id' | 'displayName'>,
    title: string,
  ): Promise<Task | null> => {
    const usable = (task: Task) =>
      task.clientId === client.id && !isReadOnlyTask(task) && !task.expertId;
    const existing =
      activeTask && usable(activeTask)
        ? activeTask
        : view === 'active'
          ? taskList.tasks.filter(usable).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
          : undefined;
    let task = existing ?? null;
    if (!task) {
      try {
        task = await createTask({ clientId: client.id, title });
      } catch {
        return null;
      }
      if (view === 'active') refreshTasks();
      else changeView('active');
    }
    setActiveTask(task);
    setPendingExpert(null);
    setCenterView('chat');
    setFocusClientId(client.id);
    closeDrawerOnNarrow();
    if (narrow) setResultsOpen(false);
    return task;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const twinActions: TwinActions = {
    askExpert: (request: TwinConsultRequest) => {
      const label = twinRefLabel(request.ref);
      void openClientTask(
        request.client,
        t('twin.ai.taskTitle', { subject: label, date: today() }),
      ).then((task) => {
        if (!task) return;
        setPrefill({
          key: ++prefillSeq.current,
          taskId: task.id,
          mode: 'ask',
          twinRefs: [request.ref],
          twinConsult: true,
          ...(request.followUpItemId ? { followUpItemId: request.followUpItemId } : {}),
        });
      });
    },
    summarize: (client) => {
      void openClientTask(client, t('twin.ai.summaryTaskTitle', { date: today() })).then((task) => {
        if (!task) return;
        setPrefill({
          key: ++prefillSeq.current,
          taskId: task.id,
          mode: 'craft',
          skillId: 'twin-summary',
        });
      });
    },
    planAndVisits: (client) => {
      void openClientTask(client, t('twin.ai.planAndVisitsTaskTitle', { date: today() })).then(
        (task) => {
          if (!task) return;
          setPrefill({
            key: ++prefillSeq.current,
            taskId: task.id,
            mode: 'plan',
            skillId: 'plan-and-visits',
          });
        },
      );
    },
    visitSkill: (client, visitId, skillId) => {
      const title = t(
        skillId === 'visit-script'
          ? 'twin.ai.visitScriptTaskTitle'
          : 'twin.ai.visitRecordTaskTitle',
        { date: today() },
      );
      void openClientTask(client, title).then((task) => {
        if (!task) return;
        setPrefill({ key: ++prefillSeq.current, taskId: task.id, mode: 'craft', skillId, visitId });
      });
    },
    handoffReply: (client, handoffId) => {
      void openClientTask(client, t('twin.ai.handoffReplyTaskTitle', { date: today() })).then(
        (task) => {
          if (!task) return;
          setPrefill({
            key: ++prefillSeq.current,
            taskId: task.id,
            mode: 'craft',
            skillId: 'handoff-reply',
            handoffRefs: [handoffId],
          });
        },
      );
    },
  };

  const archiveTask = (task: Task, archived: boolean) => {
    updateTask(task.id, { archived })
      .then((updated) => {
        setActiveTask((current) => (current?.id === updated.id ? updated : current));
      })
      .catch(() => {})
      .finally(refreshTasks);
  };

  const onTaskCreated = (task: Task) => {
    setActiveTask(task);
    setPendingExpert(null);
    if (view === 'active') refreshTasks();
    else changeView('active');
  };

  const onConversationChanged = useCallback(() => {
    setConversationVersion((v) => v + 1);
    refreshTasks();
  }, [refreshTasks]);

  const onReviewUpload = useCallback((uploadId: string) => {
    setReviewRequest((r) => ({ uploadId, key: (r?.key ?? 0) + 1 }));
    setDrawerOpen(false);
    setResultsOpen(true);
  }, []);
  const onUploadsChanged = useCallback(() => setUploadsVersion((v) => v + 1), []);
  const onConsultation = useCallback(() => setConsultationsVersion((v) => v + 1), []);
  const onOpenExperts = useCallback((consultationId: string | null) => {
    setExpertsTabRequest((r) => ({ key: (r?.key ?? 0) + 1, consultationId }));
    setDrawerOpen(false);
    setResultsOpen(true);
  }, []);

  const onArtifact = useCallback(() => {
    // 结果区自动打开并刷新（规格 3.2）
    setArtifactsVersion((v) => v + 1);
    setDrawerOpen(false);
    setResultsOpen(true);
  }, []);

  // 从宽屏切到窄屏时收起浮层，避免遮住对话区。
  useEffect(() => {
    if (narrow) {
      setDrawerOpen(false);
      setResultsOpen(false);
    }
  }, [narrow]);

  /** 新建或修改了客户：更新客户列表（@ 补全、任务分组都用它） */
  const upsertClient = useCallback((client: ClientSummary) => {
    setClients((list) => {
      const current = list ?? [];
      return current.some((c) => c.id === client.id)
        ? current.map((c) => (c.id === client.id ? client : c))
        : [...current, client];
    });
  }, []);

  const onClientCreated = useCallback(
    (client: ClientSummary) => {
      upsertClient(client);
      setFocusClientId(client.id);
    },
    [upsertClient],
  );

  const onDraftClientChange = useCallback((client: ClientSummary | null) => {
    setDraftClient(client);
    if (client) setFocusClientId(null);
  }, []);

  const linkedClientId = activeTask?.clientId ?? null;
  const panelClientId = focusClientId ?? linkedClientId;
  const panelClient = panelClientId
    ? (clients?.find((c) => c.id === panelClientId) ?? null)
    : draftClient;

  const overlayOpen = narrow && (drawerOpen || resultsOpen);

  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        setResultsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen]);

  const toggleResults = () => {
    if (narrow) setDrawerOpen(false);
    setResultsOpen((open) => !open);
  };

  return (
    <ExpertsContext.Provider value={expertList.experts}>
      <TwinActionsContext.Provider value={twinActions}>
        <div
          className={styles.shell}
          data-layout={narrow ? 'narrow' : 'wide'}
          data-sidebar={!narrow && sidebarCollapsed ? 'collapsed' : 'expanded'}
          data-results={!narrow && resultsOpen ? 'open' : 'closed'}
        >
          <Sidebar
            mode={narrow ? 'drawer' : 'docked'}
            collapsed={!narrow && sidebarCollapsed}
            open={narrow ? drawerOpen : true}
            onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
            onClose={() => setDrawerOpen(false)}
            {...(account ? { account } : {})}
            tasks={{
              view,
              list: taskList,
              clients,
              activeTaskId: activeTask?.id ?? null,
              onViewChange: changeView,
              onSelect: selectTask,
              // 新建任务先回到欢迎页，发送第一条消息时才真正创建，避免留下空任务
              onNewTask: () => selectTask(null),
              onArchive: archiveTask,
              onRetry: refreshTasks,
            }}
            experts={{ active: centerView === 'experts', onOpen: openExpertCenter }}
            library={{ active: centerView === 'library', onOpen: openLibrary }}
            followUps={{
              active: centerView === 'followUps',
              count:
                followUpList.data || todayVisits.data || companionInbox.data
                  ? (followUpList.data?.openCount ?? 0) +
                    (todayVisits.data?.count ?? 0) +
                    companionInboxCount(companionInbox.data)
                  : null,
              onOpen: openFollowUps,
            }}
            clientList={{
              clients,
              levels: twinLevels,
              companionAlerts: new Set(companionInbox.data?.alerts.map((a) => a.clientId) ?? []),
              activeClientId: panelClient?.id ?? null,
              onSelect: selectClient,
            }}
          />
          <div className={styles.center}>
            {centerView === 'experts' && (
              <ExpertCenter
                narrow={narrow}
                onOpenMenu={() => {
                  setResultsOpen(false);
                  setDrawerOpen(true);
                }}
                state={expertList}
                onRetry={() => setExpertsReload((v) => v + 1)}
                onAsk={askExpert}
              />
            )}
            {centerView === 'followUps' && (
              <FollowUpCenter
                narrow={narrow}
                onOpenMenu={() => {
                  setResultsOpen(false);
                  setDrawerOpen(true);
                }}
                state={followUpList}
                onRetry={() => setTwinSummaryVersion((v) => v + 1)}
                onOpenClient={openClientById}
                onChanged={onFollowUpsChanged}
                visits={todayVisits}
                onVisitsRetry={() => setTwinSummaryVersion((v) => v + 1)}
                onVisitsChanged={onFollowUpsChanged}
                companion={companionInbox}
                onCompanionRetry={() => setTwinSummaryVersion((v) => v + 1)}
                onCompanionChanged={onFollowUpsChanged}
              />
            )}
            {centerView === 'library' && (
              <PlanLibrary
                narrow={narrow}
                onOpenMenu={() => {
                  setResultsOpen(false);
                  setDrawerOpen(true);
                }}
              />
            )}
            {/* 看专家库时对话区仍保持挂载（只是隐藏），正在进行的生成不会被打断 */}
            <div className={styles.slot} hidden={centerView !== 'chat'}>
              <ChatPane
                narrow={narrow}
                onOpenMenu={() => {
                  setResultsOpen(false);
                  setDrawerOpen(true);
                }}
                resultsOpen={resultsOpen}
                onToggleResults={toggleResults}
                task={activeTask}
                skills={skills}
                clients={clients ?? []}
                onTaskCreated={onTaskCreated}
                onTaskChanged={refreshTasks}
                onArtifact={onArtifact}
                conversationVersion={conversationVersion}
                onDraftClientChange={onDraftClientChange}
                onNewTask={() => selectTask(null)}
                onReviewUpload={onReviewUpload}
                onUploadsChanged={onUploadsChanged}
                uploadsVersion={uploadsVersion}
                pendingExpert={activeTask ? null : pendingExpert}
                onOpenExperts={onOpenExperts}
                onConsultation={onConsultation}
                prefill={prefill}
              />
            </div>
          </div>
          <ResultsPanel
            mode={narrow ? 'sheet' : 'docked'}
            open={resultsOpen}
            onClose={() => setResultsOpen(false)}
            task={activeTask}
            client={panelClient}
            onArtifactsChanged={refreshTasks}
            onConversationChanged={onConversationChanged}
            onClientCreated={onClientCreated}
            onClientSaved={upsertClient}
            refreshKey={`${activeTask?.id ?? 'none'}:${artifactsVersion}`}
            reviewRequest={reviewRequest}
            uploadsVersion={uploadsVersion}
            // 结果区里确认核对、放弃、重新识别后，对话区的识别卡片也要刷新（验收反馈 3）
            onUploadsChanged={onUploadsChanged}
            consultationsVersion={consultationsVersion}
            expertsTabRequest={expertsTabRequest}
            clientTabRequest={clientTabRequest}
            twinRefreshKey={twinPanelVersion}
            onTwinChanged={onTwinChanged}
          />
          {overlayOpen && (
            <button
              type="button"
              className={styles.backdrop}
              aria-label={drawerOpen ? t('nav.closeMenu') : t('results.close')}
              onClick={() => {
                setDrawerOpen(false);
                setResultsOpen(false);
              }}
            />
          )}
        </div>
      </TwinActionsContext.Provider>
    </ExpertsContext.Provider>
  );
}
