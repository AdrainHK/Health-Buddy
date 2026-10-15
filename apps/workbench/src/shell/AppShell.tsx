import type { ClientSummary, SkillSummary, Task } from '@health-buddy/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listClients, listSkills, listTasks, updateTask } from '../api/workbench';
import styles from './AppShell.module.css';
import { ChatPane } from './ChatPane';
import { ResultsPanel } from './ResultsPanel';
import { Sidebar, type SidebarAccount, type TaskListState, type TaskListView } from './Sidebar';
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
    closeDrawerOnNarrow();
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
    if (view === 'active') refreshTasks();
    else changeView('active');
  };

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
      />
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
      />
      <ResultsPanel
        mode={narrow ? 'sheet' : 'docked'}
        open={resultsOpen}
        onClose={() => setResultsOpen(false)}
        task={activeTask}
        onArtifactsChanged={refreshTasks}
        refreshKey={`${activeTask?.id ?? 'none'}:${artifactsVersion}`}
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
  );
}
