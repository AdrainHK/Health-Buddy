import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENTS, SKILL, emptyDetail, ids, json, makeTask, mockApi } from '../test/mockApi';
import { AppShell } from './AppShell';

const TASKS = [
  makeTask({
    id: ids.task,
    title: '甲的小结',
    clientId: ids.clientA,
    updatedAt: '2026-10-15T09:00:00.000Z',
  }),
  makeTask({
    id: ids.task2,
    title: '随便问问',
    clientId: null,
    updatedAt: '2026-10-15T08:00:00.000Z',
  }),
];
const ARCHIVED = [
  makeTask({
    id: ids.task3,
    title: '转出客户的任务',
    clientId: null,
    archived: true,
    detachedReason: 'client_transferred',
  }),
];

function mockWorkbench() {
  return mockApi({
    'GET /tasks': () => json(200, { tasks: TASKS }),
    'GET /tasks?archived=true': () => json(200, { tasks: ARCHIVED }),
    'GET /clients': () => json(200, { clients: CLIENTS }),
    'GET /skills': () => json(200, { skills: [SKILL] }),
    [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(TASKS[0])),
    [`GET /tasks/${ids.task3}`]: () => json(200, emptyDetail(ARCHIVED[0])),
    [`PATCH /tasks/${ids.task2}`]: () => json(200, { task: { ...TASKS[1], archived: true } }),
  });
}

afterEach(() => vi.unstubAllGlobals());

function setViewport(narrow: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: narrow && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

describe('AppShell (wide screen)', () => {
  beforeEach(() => {
    setViewport(false);
    mockWorkbench();
  });

  it('shows the product name, the three columns and the greeting', () => {
    render(<AppShell />);
    expect(screen.getByRole('complementary', { name: 'Health Buddy' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '结果' })).toBeInTheDocument();
    expect(screen.getByText('今天想让我帮你做什么？')).toBeInTheDocument();
  });

  it('collapses and expands the sidebar', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('还没有任务')).not.toBeInTheDocument();
  });

  it('closes and reopens the results panel', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    // 顶栏的开关按钮带 aria-expanded；结果区自己的关闭按钮没有。
    const toggle = screen
      .getAllByRole('button', { name: '关闭结果区' })
      .find((b) => b.hasAttribute('aria-expanded'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    if (!toggle) throw new Error('results toggle not found');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: '打开结果区' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('switches result tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    const artifacts = screen.getByRole('tab', { name: '产物' });
    artifacts.focus();
    await user.keyboard('{ArrowRight}');
    const client = screen.getByRole('tab', { name: '客户' });
    expect(client).toHaveAttribute('aria-selected', 'true');
    expect(client).toHaveFocus();
    expect(within(screen.getByRole('tabpanel')).getByText('未选择客户')).toBeInTheDocument();
  });

  it('enables the composer with craft as the default mode', () => {
    render(<AppShell />);
    expect(screen.getByRole('textbox')).toBeEnabled();
    // 没有输入内容时发送按钮不可用
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '做一做' })).toHaveAttribute('aria-checked', 'true');
  });

  it('groups tasks by client, newest first, with an unlinked group', async () => {
    render(<AppShell />);
    const clientGroup = await screen.findByRole('group', { name: '合成客户甲' });
    expect(within(clientGroup).getByRole('button', { name: '甲的小结' })).toBeInTheDocument();
    const unlinked = screen.getByRole('group', { name: '未关联客户' });
    expect(within(unlinked).getByRole('button', { name: '随便问问' })).toBeInTheDocument();
    const groups = screen.getAllByRole('group');
    expect(groups.indexOf(clientGroup)).toBeLessThan(groups.indexOf(unlinked));
  });

  it('switches tasks and shows the task title', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: '甲的小结' }));
    expect(screen.getByRole('heading', { level: 1, name: '甲的小结' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '甲的小结' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    expect(screen.getByRole('heading', { level: 1, name: '新任务' })).toBeInTheDocument();
    expect(screen.getByText('今天想让我帮你做什么？')).toBeInTheDocument();
  });

  it('archives a task through PATCH', async () => {
    const api = mockWorkbench();
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: '归档“随便问问”' }));
    expect(api.callsTo('PATCH', `/tasks/${ids.task2}`)[0]?.body).toEqual({ archived: true });
  });

  it('lists archived tasks with a read-only marker and a disabled composer', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: '已归档' }));
    const detached = await screen.findByRole('group', { name: '已转出或删除的客户' });
    const task = within(detached).getByRole('button', { name: /转出客户的任务/ });
    expect(within(task).getByText('只读')).toBeInTheDocument();
    // 只读任务不能取消归档
    expect(screen.queryByRole('button', { name: /取消归档/ })).not.toBeInTheDocument();

    await user.click(task);
    expect(await screen.findByPlaceholderText('客户已转出或删除，此任务只读')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '返回任务列表' }));
    expect(await screen.findByRole('group', { name: '未关联客户' })).toBeInTheDocument();
  });
});

describe('AppShell (narrow screen)', () => {
  beforeEach(() => {
    setViewport(true);
    mockWorkbench();
  });

  it('starts with both overlays closed and opens the menu as a drawer', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(screen.getByRole('complementary', { name: 'Health Buddy' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();
  });

  it('closes the menu when the results sheet opens, so only one overlay shows', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    await user.click(screen.getByRole('button', { name: '打开结果区', hidden: true }));
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '结果' })).toBeInTheDocument();
  });
});
