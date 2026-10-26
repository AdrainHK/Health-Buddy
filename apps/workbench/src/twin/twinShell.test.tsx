import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../shell/AppShell';
import {
  CLIENTS,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeArtifactDetail,
  makeArtifactSummary,
  makeTask,
  mockApi,
} from '../test/mockApi';
import {
  CRITICAL_FOLLOW_UP,
  EMPTY_TIMELINE,
  followUpList,
  makeFollowUp,
  makeTwin,
  tzQuery,
} from '../test/twinFixtures';

/** 孪生在三栏布局里的入口（M4 规格 2.1、2.2，Q12、Q27）。全部是合成数据 */

const TASK_A = makeTask({
  id: ids.task,
  title: '甲的小结',
  clientId: ids.clientA,
  updatedAt: '2026-10-15T09:00:00.000Z',
});
/** 还没关联客户、有一份产物的任务 */
const TASK_FREE = makeTask({
  id: ids.task2,
  title: '随便问问',
  clientId: null,
  updatedAt: '2026-10-15T08:00:00.000Z',
});
const FREE_ARTIFACT = makeArtifactSummary({ taskId: ids.task2 });

function setViewport(narrow: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: narrow && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

function mockShell() {
  const twinRoutes = Object.fromEntries(
    CLIENTS.flatMap((c) => [
      [
        `GET /clients/${c.id}/twin`,
        () =>
          json(200, makeTwin({ client: c, forecasts: [], hasOpenCritical: c.id === ids.clientB })),
      ],
      [`GET /clients/${c.id}/twin/timeline`, () => json(200, EMPTY_TIMELINE)],
      [`GET /follow-ups${tzQuery({ clientId: c.id })}`, () => json(200, followUpList([]))],
      [`GET /clients/${c.id}/report-uploads`, () => json(200, { uploads: [] })],
    ]),
  );
  return mockApi({
    'GET /tasks': () => json(200, { tasks: [TASK_A, TASK_FREE] }),
    'GET /clients': () => json(200, { clients: CLIENTS }),
    'GET /skills': () => json(200, { skills: [SKILL] }),
    [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(TASK_A)),
    [`GET /tasks/${ids.task2}`]: () =>
      json(200, { ...emptyDetail(TASK_FREE), artifacts: [FREE_ARTIFACT] }),
    [`GET /artifacts/${ids.artifact}`]: () =>
      json(200, makeArtifactDetail({ taskId: ids.task2, clientId: null as unknown as string })),
    [`GET /follow-ups${tzQuery()}`]: () =>
      json(200, followUpList([makeFollowUp(), CRITICAL_FOLLOW_UP])),
    'GET /twin/levels': () =>
      json(200, {
        clients: [
          { clientId: ids.clientA, level: 'yellow' },
          { clientId: ids.clientB, level: 'red' },
        ],
      }),
    ...twinRoutes,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('左侧栏：今日跟进入口和客户列表', () => {
  beforeEach(() => setViewport(false));

  it('今日跟进带未处理数量角标；点开后中间区域显示所有客户的清单，危急的排在最前', async () => {
    mockShell();
    const user = userEvent.setup();
    render(<AppShell />);
    const entry = await screen.findByRole('button', { name: /今日跟进.*2 项未处理/ });
    await user.click(entry);
    expect(entry).toHaveAttribute('aria-current', 'page');
    const list = await screen.findByRole('list', { name: '跟进项' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('合成客户乙 · 危急指标');
    expect(items[1]).toHaveTextContent('合成客户甲 · 状态变差');
    // 打开客户：结果区切到“客户 · 孪生”
    await user.click(within(items[0]!).getByRole('button', { name: '打开 合成客户乙 的孪生' }));
    expect(screen.getByRole('tab', { name: '客户' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('button', { name: '孪生' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await within(panel).findByRole('heading', { name: /合成客户乙/ })).toBeInTheDocument();
    expect(within(panel).getByRole('note')).toHaveTextContent('有危急指标，请先电话联系客户');
  });

  it('客户名字旁的小圆点：最严重的状态，有图形标记和读屏文字，不只靠颜色', async () => {
    mockShell();
    render(<AppShell />);
    const dot = await screen.findByRole('img', { name: '合成客户乙，孪生状态：需要尽快关注' });
    expect(dot).toHaveAttribute('data-level', 'red');
    expect(dot).toHaveTextContent('!');
    const yellow = screen.getByRole('img', { name: '合成客户甲，孪生状态：需要留意' });
    expect(yellow).toHaveTextContent('△');
  });

  it('点客户：进入该客户的任务分组，右侧打开“客户 · 孪生”', async () => {
    const api = mockShell();
    const user = userEvent.setup();
    render(<AppShell />);
    const clients = await screen.findByRole('region', { name: '客户' });
    await user.click(await within(clients).findByRole('button', { name: /合成客户甲/ }));
    // 打开了这位客户最近的任务
    expect(await screen.findByRole('heading', { level: 1, name: '甲的小结' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '客户' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByRole('heading', { name: '画像' })).toBeInTheDocument();
    // 档案子视图（M2 原样）还在
    await user.click(within(panel).getByRole('button', { name: '档案' }));
    await waitFor(() =>
      expect(api.callsTo('GET', `/clients/${ids.clientA}/record`).length).toBeGreaterThan(0),
    );
  });
});

describe('第一次 @客户：结果区自动切到孪生，正打开产物时只显示提示点（Q27）', () => {
  beforeEach(() => setViewport(false));

  it('没有打开产物：自动切到“客户 · 孪生”', async () => {
    mockShell();
    const user = userEvent.setup();
    render(<AppShell />);
    await user.type(screen.getByRole('textbox'), '@乙');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: '客户' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('button', { name: '孪生' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await within(panel).findByRole('heading', { name: '画像' })).toBeInTheDocument();
    expect(screen.queryByTestId('client-tab-hint')).not.toBeInTheDocument();
  });

  it('正打开着产物：不抢焦点，客户标签上显示提示点；打开客户标签后提示点消失', async () => {
    mockShell();
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: '随便问问' }));
    const results = screen.getByRole('complementary', { name: '结果' });
    await user.click(await within(results).findByRole('button', { name: /合成任务|第1版/ }));
    await waitFor(() =>
      expect(within(results).getByRole('tab', { name: '产物' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    const box = screen.getByRole('textbox', { name: /描述你的需求/ });
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, '@乙');
    await user.keyboard('{Enter}');
    expect(within(results).getByRole('tab', { name: /产物/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const hint = await screen.findByTestId('client-tab-hint');
    expect(hint).toHaveAccessibleName('客户的孪生有更新，点开查看');
    await user.click(within(results).getByRole('tab', { name: /客户/ }));
    expect(screen.queryByTestId('client-tab-hint')).not.toBeInTheDocument();
    expect(
      await within(screen.getByRole('tabpanel')).findByRole('heading', { name: '画像' }),
    ).toBeInTheDocument();
  });
});

describe('手机宽度', () => {
  beforeEach(() => setViewport(true));

  it('点客户：关闭抽屉，底部面板打开孪生，单列布局（data-layout="narrow"）', async () => {
    mockShell();
    const user = userEvent.setup();
    const { container } = render(<AppShell />);
    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    const clients = await screen.findByRole('region', { name: '客户' });
    await user.click(await within(clients).findByRole('button', { name: /合成客户乙/ }));
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();
    const results = screen.getByRole('complementary', { name: '结果' });
    expect(await within(results).findByRole('heading', { name: '画像' })).toBeInTheDocument();
    expect(container.querySelector('[data-layout="narrow"] [data-layout="narrow"]')).toBeTruthy();
  });
});
