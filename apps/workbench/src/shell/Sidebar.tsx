import { Button, IconButton } from '@health-buddy/ui';
import { PRODUCT_NAME, type ClientSummary, type Task, type TwinLevel } from '@health-buddy/shared';
import {
  Archive,
  BellRing,
  BookOpen,
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
import { ExpertAvatar } from '../experts/ExpertBadges';
import { useExpertName } from '../experts/ExpertsContext';
import { LevelDot } from '../twin/levels';
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
  /** 专家中心入口（M3 规格 2.1）：点击后中间区域显示专家库 */
  experts?: { active: boolean; onOpen: () => void };
  /** 今日跟进入口（M4 规格 2.1，Q12）：带未处理数量角标，点开后中间区域显示清单 */
  followUps?: { active: boolean; count: number | null; onOpen: () => void };
  /** 方案库（M5 规格 2.1、2.4）：所有健管师可见，只读 */
  library?: { active: boolean; onOpen: () => void };
  /** 客户列表（M4 规格 2.1）：名字旁的小圆点是四个方面里最严重的状态，点客户打开孪生 */
  clientList?: SidebarClients;
}

export interface SidebarClients {
  clients: ClientSummary[] | null;
  /** 每位客户的整体状态；还没加载出来时为空 */
  levels: ReadonlyMap<string, TwinLevel>;
  /** 有未处理伴侣预警的客户（状态圆点旁单独显示红点，Q24） */
  companionAlerts?: ReadonlySet<string>;
  activeClientId: string | null;
  onSelect: (client: ClientSummary) => void;
}

export function Sidebar({
  mode,
  collapsed,
  open,
  onToggleCollapsed,
  onClose,
  account,
  tasks,
  experts,
  followUps,
  library,
  clientList,
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
        {followUps && (
          <NavItem
            icon={<BellRing size={18} />}
            label={t('nav.followUps')}
            onClick={followUps.onOpen}
            current={followUps.active}
            badge={
              followUps.count
                ? {
                    text: followUps.count > 99 ? '99+' : String(followUps.count),
                    label: t('nav.followUpsBadge', { count: followUps.count }),
                  }
                : null
            }
          />
        )}
        <NavItem icon={<Sparkles size={18} />} label={t('nav.skills')} />
        <NavItem
          icon={<Stethoscope size={18} />}
          label={t('nav.experts')}
          {...(experts ? { onClick: experts.onOpen, current: experts.active } : {})}
        />
        {library && (
          <NavItem
            icon={<BookOpen size={18} />}
            label={t('nav.library')}
            onClick={library.onOpen}
            current={library.active}
          />
        )}
        <NavItem icon={<Timer size={18} />} label={t('nav.automations')} />
      </nav>

      {!collapsed && clientList && <ClientSection list={clientList} />}
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

function ClientSection({ list }: { list: SidebarClients }) {
  const { t } = useTranslation();
  const clients = [...(list.clients ?? [])].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'zh-CN'),
  );
  return (
    <section className={styles.clientSection} aria-labelledby="hb-clients-title">
      <h2 id="hb-clients-title" className={styles.sectionTitle}>
        {t('nav.clients')}
      </h2>
      {list.clients === null && <p className={styles.empty}>{t('nav.loadingClients')}</p>}
      {list.clients !== null && clients.length === 0 && (
        <p className={styles.empty}>{t('nav.noClients')}</p>
      )}
      {clients.length > 0 && (
        <ul className={styles.clientList}>
          {clients.map((client) => {
            const level = list.levels.get(client.id) ?? null;
            const levelText = level ? t(`twin.levels.${level}`) : null;
            return (
              <li key={client.id}>
                <button
                  type="button"
                  className={styles.task}
                  aria-current={list.activeClientId === client.id ? 'true' : undefined}
                  title={client.displayName}
                  onClick={() => list.onSelect(client)}
                >
                  {level && levelText ? (
                    <LevelDot
                      level={level}
                      label={t('nav.clientLabel', { name: client.displayName, level: levelText })}
                    />
                  ) : (
                    <span className={styles.dotPlaceholder} aria-hidden />
                  )}
                  <span className={styles.taskTitle}>{client.displayName}</span>
                  {list.companionAlerts?.has(client.id) && (
                    <span
                      className={styles.companionAlert}
                      role="img"
                      aria-label={t('nav.companionAlert')}
                      title={t('nav.companionAlert')}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
  const expertName = useExpertName();
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
                {/* 专家中心发起的任务名前带专家头像（Q25） */}
                {task.expertId && <ExpertAvatar name={expertName(task.expertId)} size="small" />}
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

function NavItem({
  icon,
  label,
  onClick,
  current,
  badge,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  current?: boolean;
  /** 数字角标：text 是显示的数字，label 是读屏读出的完整说法 */
  badge?: { text: string; label: string } | null;
}) {
  return (
    <button
      type="button"
      className={styles.navItem}
      title={label}
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
    >
      {icon}
      <span className={styles.label}>{label}</span>
      {badge && (
        <span className={styles.navBadge}>
          <span aria-hidden>{badge.text}</span>
          <span className={styles.visuallyHidden}>{badge.label}</span>
        </span>
      )}
    </button>
  );
}
