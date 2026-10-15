import { Button, IconButton } from '@health-buddy/ui';
import { PRODUCT_NAME, type ClientSummary, type Task } from '@health-buddy/shared';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Heart,
  Lock,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sparkles,
  Stethoscope,
  Timer,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Sidebar.module.css';
import { groupTasks, isReadOnlyTask, type TaskGroup } from './taskGroups';

export interface SidebarAccount {
  name: string;
  onLogout: () => void;
}

export type TaskListView = 'active' | 'archived';

export interface TaskListState {
  status: 'loading' | 'ready' | 'error';
  tasks: Task[];
}

export interface SidebarTasks {
  view: TaskListView;
  list: TaskListState;
  /** 用于按客户分组；null 表示还没加载出来 */
  clients: ClientSummary[] | null;
  activeTaskId: string | null;
  onViewChange: (view: TaskListView) => void;
  onSelect: (task: Task) => void;
  onNewTask: () => void;
  onArchive: (task: Task, archived: boolean) => void;
  onRetry: () => void;
}

export interface SidebarProps {
  /** docked：宽屏固定在左侧；drawer：窄屏从左侧滑出。 */
  mode: 'docked' | 'drawer';
  collapsed: boolean;
  open: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
  account?: SidebarAccount;
  tasks?: SidebarTasks;
}

export function Sidebar({
  mode,
  collapsed,
  open,
  onToggleCollapsed,
  onClose,
  account,
  tasks,
}: SidebarProps) {
  const { t } = useTranslation();
  const classes = [
    styles.sidebar,
    mode === 'drawer' && styles.drawer,
    collapsed && styles.collapsed,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <aside
      id="hb-sidebar"
      className={classes}
      data-open={open}
      aria-label={PRODUCT_NAME}
      aria-hidden={mode === 'drawer' && !open ? true : undefined}
      inert={mode === 'drawer' && !open ? true : undefined}
    >
      <div className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Heart size={16} strokeWidth={2.5} />
          </span>
          {!collapsed && <span>{PRODUCT_NAME}</span>}
        </div>
        {mode === 'drawer' ? (
          <IconButton label={t('nav.closeMenu')} icon={<X size={18} />} onClick={onClose} />
        ) : (
          <IconButton
            label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            aria-expanded={!collapsed}
            aria-controls="hb-sidebar"
            onClick={onToggleCollapsed}
          />
        )}
      </div>

      {collapsed ? (
        <IconButton
          variant="primary"
          label={t('nav.newTask')}
          icon={<Plus size={18} />}
          onClick={tasks?.onNewTask}
        />
      ) : (
        <Button variant="primary" block icon={<Plus size={18} />} onClick={tasks?.onNewTask}>
          {t('nav.newTask')}
        </Button>
      )}

      <nav className={styles.nav}>
        <NavItem icon={<Sparkles size={18} />} label={t('nav.skills')} />
        <NavItem icon={<Stethoscope size={18} />} label={t('nav.experts')} />
        <NavItem icon={<Timer size={18} />} label={t('nav.automations')} />
      </nav>

      {collapsed ? <div className={styles.spacer} /> : <TaskSection tasks={tasks} />}

      <div className={styles.footer}>
        <NavItem icon={<Settings size={18} />} label={t('nav.settings')} />
        {account && (
          <div className={styles.account}>
            {!collapsed && (
              <span className={styles.accountName} title={account.name}>
                {account.name}
              </span>
            )}
            <IconButton
              label={t('auth.logout')}
              icon={<LogOut size={18} />}
              onClick={account.onLogout}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

function TaskSection({ tasks }: { tasks: SidebarTasks | undefined }) {
  const { t } = useTranslation();
  const archived = tasks?.view === 'archived';
  const list = tasks?.list ?? { status: 'ready', tasks: [] };
  const groups = groupTasks(list.tasks, tasks?.clients ?? null);

  return (
    <section className={styles.section} aria-labelledby="hb-tasks-title">
      <div className={styles.sectionHeader}>
        {archived && (
          <IconButton
            size="small"
            label={t('nav.backToTasks')}
            icon={<ArrowLeft size={16} />}
            onClick={() => tasks?.onViewChange('active')}
          />
        )}
        <h2 id="hb-tasks-title" className={styles.sectionTitle}>
          {archived ? t('nav.archived') : t('nav.tasks')}
        </h2>
      </div>

      <div className={styles.taskScroll}>
        {list.status === 'loading' && <p className={styles.empty}>{t('nav.loadingTasks')}</p>}
        {list.status === 'error' && (
          <div className={styles.empty} role="alert">
            {t('nav.loadFailed')}{' '}
            <button type="button" className={styles.linkButton} onClick={tasks?.onRetry}>
              {t('nav.retry')}
            </button>
          </div>
        )}
        {list.status === 'ready' && groups.length === 0 && (
          <p className={styles.empty}>{archived ? t('nav.noArchived') : t('nav.noTasks')}</p>
        )}
        {list.status === 'ready' &&
          groups.map((group) => <TaskGroupList key={group.key} group={group} tasks={tasks} />)}
      </div>

      {!archived && tasks && (
        <button
          type="button"
          className={styles.navItem}
          onClick={() => tasks.onViewChange('archived')}
        >
          <Archive size={18} />
          <span className={styles.label}>{t('nav.archived')}</span>
        </button>
      )}
    </section>
  );
}

function TaskGroupList({ group, tasks }: { group: TaskGroup; tasks: SidebarTasks | undefined }) {
  const { t } = useTranslation();
  const label =
    group.kind === 'client'
      ? (group.clientName ?? '…')
      : group.kind === 'unlinked'
        ? t('nav.groups.unlinked')
        : t('nav.groups.detached');
  const headingId = `hb-task-group-${group.key.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <div className={styles.group} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.groupTitle} title={label}>
        {label}
      </h3>
      <ul className={styles.taskList}>
        {group.tasks.map((task) => {
          const readOnly = isReadOnlyTask(task);
          const title = task.title || t('chat.untitled');
          return (
            <li key={task.id} className={styles.taskRow}>
              <button
                type="button"
                className={styles.task}
                aria-current={tasks?.activeTaskId === task.id ? 'true' : undefined}
                onClick={() => tasks?.onSelect(task)}
                title={title}
              >
                <span className={styles.taskTitle}>{title}</span>
                {readOnly && (
                  <span className={styles.badge} title={t('nav.readOnlyHint')}>
                    <Lock size={12} aria-hidden />
                    {t('nav.readOnly')}
                  </span>
                )}
              </button>
              {/* 只读任务不能取消归档（后端返回 409），所以不提供入口 */}
              {!(task.archived && readOnly) && (
                <IconButton
                  size="small"
                  className={styles.taskAction}
                  label={
                    task.archived ? t('nav.unarchive', { title }) : t('nav.archive', { title })
                  }
                  icon={task.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  onClick={() => tasks?.onArchive(task, !task.archived)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NavItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button type="button" className={styles.navItem} title={label}>
      {icon}
      <span className={styles.label}>{label}</span>
    </button>
  );
}
