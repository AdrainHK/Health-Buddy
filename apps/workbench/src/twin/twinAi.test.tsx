import type { TaskStreamEvent } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ExpertsContext } from '../experts/ExpertsContext';
import { AppShell } from '../shell/AppShell';
import { ChatPane, type ChatPaneProps, type ComposerPrefill } from '../shell/ChatPane';
import { EXPERTS } from '../test/expertFixtures';
import {
  CLIENTS,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeTask,
  mockApi,
  setWideViewport,
  sseResponse,
} from '../test/mockApi';
import {
  EMPTY_TIMELINE,
  followUpList,
  makeFollowUp,
  makeTwin,
  twinIds,
  tzQuery,
} from '../test/twinFixtures';
import { TwinActionsContext, type TwinActions } from './TwinActions';
import { TwinView } from './TwinView';

/** 孪生和 AI 的连接（M4 第 4 步：@孪生项、请专家看看、/孪生小结）。全部是合成数据 */

const A = ids.clientA;
const TASK = makeTask({ clientId: A });
const MSG_PATH = `/tasks/${ids.task}/messages`;
const done: TaskStreamEvent = { type: 'done', messageId: ids.assistantMsg, reason: 'complete' };

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => setWideViewport());

function chatRoutes(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(TASK)),
    [`GET /clients/${A}/reports`]: () => json(200, { reports: [] }),
    [`GET /clients/${A}/report-uploads`]: () => json(200, { uploads: [] }),
    [`GET /clients/${A}/twin`]: () => json(200, makeTwin()),
    [`POST ${MSG_PATH}`]: () => sseResponse([done]),
    ...extra,
  });
}

function renderPane(props: Partial<ChatPaneProps> = {}) {
  const all: ChatPaneProps = {
    narrow: false,
    onOpenMenu: () => {},
    resultsOpen: true,
    onToggleResults: () => {},
    task: TASK,
    skills: [SKILL],
    clients: CLIENTS,
    ...props,
  };
  return render(
    <ExpertsContext.Provider value={EXPERTS}>
      <ChatPane {...all} />
    </ExpertsContext.Provider>,
  );
}

describe('@孪生项（规格 2.8）', () => {
  it('@ 列表有“孪生项”组：当前客户的四个方面和有预测的指标；问一问发送时带 twinRefs', async () => {
    const api = chatRoutes();
    const user = userEvent.setup();
    renderPane();
    const box = await screen.findByRole('textbox');
    await waitFor(() => expect(api.callsTo('GET', `/clients/${A}/twin`).length).toBe(1));
    await user.click(screen.getByRole('radio', { name: '问一问' }));
    await user.type(box, '@孪生');
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('孪生项')).toBeInTheDocument();
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual([
      '孪生 · 代谢',
      '孪生 · 心血管',
      '孪生 · 睡眠',
      '孪生 · 体重',
      '孪生 · 收缩压趋势',
    ]);
    await user.click(within(list).getByRole('option', { name: '孪生 · 心血管' }));
    expect(screen.getByRole('button', { name: '移除孪生项 孪生 · 心血管' })).toBeInTheDocument();
    await user.type(box, '心血管为什么是黄色');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toMatchObject({
      mode: 'ask',
      content: '心血管为什么是黄色',
      twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
    });
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).not.toHaveProperty('twinConsult');
  });

  it('最多 3 个孪生项，第 4 个不能选；不在问一问模式时提示切换', async () => {
    chatRoutes();
    const user = userEvent.setup();
    renderPane();
    const box = await screen.findByRole('textbox');
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
    for (const name of ['孪生 · 代谢', '孪生 · 心血管', '孪生 · 睡眠']) {
      await user.type(box, '@孪生');
      await user.click(await screen.findByRole('option', { name }));
    }
    await user.type(box, '@孪生');
    const full = screen.getByRole('option', { name: /孪生 · 体重/ });
    expect(full).toHaveAttribute('aria-disabled', 'true');
    expect(full).toHaveTextContent('一条消息最多引用 3 个孪生项');
    await user.keyboard('{Escape}');
    // 默认模式不是问一问：提示并可以一键切换
    expect(screen.getByRole('alert')).toHaveTextContent('@孪生项 需要在问一问模式下使用');
  });
});

describe('请专家看看：预先填好的输入框（规格 2.6 之二）', () => {
  it('显示要请专家看的孪生项，可以空着发送，带 twinConsult 和跟进项 id', async () => {
    const api = chatRoutes();
    const user = userEvent.setup();
    const prefill: ComposerPrefill = {
      key: 1,
      taskId: ids.task,
      mode: 'ask',
      twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
      twinConsult: true,
      followUpItemId: twinIds.follow1,
    };
    renderPane({ prefill });
    expect(await screen.findByText(/将请专家看看：孪生 · 心血管/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '问一问' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toMatchObject({
      mode: 'ask',
      content: '',
      twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
      twinConsult: true,
      followUpItemId: twinIds.follow1,
    });
  });

  it('点“不请专家”后变回普通的 @孪生项提问，不带跟进项', async () => {
    const api = chatRoutes();
    const user = userEvent.setup();
    renderPane({
      prefill: {
        key: 2,
        taskId: ids.task,
        mode: 'ask',
        twinRefs: [{ kind: 'metric', code: 'sbp' }],
        twinConsult: true,
        followUpItemId: twinIds.follow1,
      },
    });
    await user.click(await screen.findByRole('button', { name: '不请专家' }));
    expect(screen.queryByText(/将请专家看看/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await user.type(screen.getByRole('textbox'), '趋势可靠吗');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    const body = api.callsTo('POST', MSG_PATH)[0]?.body;
    expect(body).toMatchObject({ twinRefs: [{ kind: 'metric', code: 'sbp' }] });
    expect(body).not.toHaveProperty('twinConsult');
    expect(body).not.toHaveProperty('followUpItemId');
  });
});

describe('孪生视图里的按钮', () => {
  function mockTwinView() {
    return mockApi({
      [`GET /clients/${A}/twin`]: () => json(200, makeTwin()),
      [`GET /follow-ups${tzQuery({ clientId: A })}`]: () =>
        json(200, followUpList([makeFollowUp({ clientId: A })])),
      [`GET /clients/${A}/twin/timeline`]: () => json(200, EMPTY_TIMELINE),
    });
  }
  function renderView(actions: TwinActions, experts = EXPERTS) {
    const wrap = (node: ReactNode) => (
      <ExpertsContext.Provider value={experts}>
        <TwinActionsContext.Provider value={actions}>{node}</TwinActionsContext.Provider>
      </ExpertsContext.Provider>
    );
    return render(
      wrap(<TwinView client={CLIENTS[0]!} onOpenRecord={() => {}} onTwinChanged={() => {}} />),
    );
  }

  it('专家预览没开（没有可用专家）时不显示“请专家看看”', async () => {
    mockTwinView();
    renderView({ askExpert: vi.fn(), summarize: vi.fn() }, []);
    expect(await screen.findByRole('heading', { name: '画像' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /请专家看看/ })).not.toBeInTheDocument();
    // 孪生小结不依赖专家
    expect(screen.getByRole('button', { name: /生成孪生小结/ })).toBeInTheDocument();
  });

  it('状态卡片和跟进项上的“请专家看看”带上孪生项和跟进项 id；生成孪生小结交给外壳', async () => {
    mockTwinView();
    const askExpert = vi.fn();
    const summarize = vi.fn();
    const user = userEvent.setup();
    renderView({ askExpert, summarize });
    await user.click(await screen.findByRole('button', { name: '请专家看看 心血管' }));
    expect(askExpert).toHaveBeenLastCalledWith({
      client: CLIENTS[0],
      ref: { kind: 'domain', code: 'cardiovascular' },
    });
    const followUps = await screen.findAllByRole('button', { name: /^请专家看看 / });
    const fromFollowUp = followUps.at(-1)!;
    await user.click(fromFollowUp);
    expect(askExpert).toHaveBeenLastCalledWith(
      expect.objectContaining({ followUpItemId: twinIds.follow1 }),
    );
    await user.click(screen.getByRole('button', { name: /生成孪生小结/ }));
    expect(summarize).toHaveBeenCalledWith(CLIENTS[0]);
  });
});

describe('外壳：从孪生回到对话区', () => {
  it('客户没有可用任务时新建“孪生 · 心血管（日期）”任务，输入框预先填好请专家看看', async () => {
    const created = makeTask({
      id: ids.task2,
      clientId: ids.clientB,
      title: '孪生 · 心血管',
    });
    let tasks = [TASK];
    const B = ids.clientB;
    const api = mockApi({
      'GET /tasks': () => json(200, { tasks }),
      'GET /clients': () => json(200, { clients: CLIENTS }),
      'GET /skills': () => json(200, { skills: [SKILL] }),
      'GET /experts': () => json(200, { experts: EXPERTS }),
      'GET /follow-ups': () => json(200, followUpList([])),
      [`GET /follow-ups${tzQuery()}`]: () => json(200, followUpList([])),
      'GET /twin/levels': () => json(200, { clients: [] }),
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(TASK)),
      [`GET /tasks/${ids.task2}`]: () => json(200, emptyDetail(created)),
      [`GET /clients/${B}/twin`]: () => json(200, makeTwin({ client: CLIENTS[1]! })),
      [`GET /clients/${B}/twin/timeline`]: () => json(200, EMPTY_TIMELINE),
      [`GET /follow-ups${tzQuery({ clientId: B })}`]: () => json(200, followUpList([])),
      [`GET /clients/${B}/report-uploads`]: () => json(200, { uploads: [] }),
      [`GET /clients/${B}/reports`]: () => json(200, { reports: [] }),
      'POST /tasks': () => {
        tasks = [created, TASK];
        return json(200, { task: created });
      },
    });
    const user = userEvent.setup();
    render(<AppShell />);
    const clients = await screen.findByRole('region', { name: '客户' });
    await user.click(await within(clients).findByRole('button', { name: /合成客户乙/ }));
    const panel = await screen.findByRole('tabpanel');
    await user.click(await within(panel).findByRole('button', { name: '请专家看看 心血管' }));
    await waitFor(() => expect(api.callsTo('POST', '/tasks')).toHaveLength(1));
    expect(api.callsTo('POST', '/tasks')[0]?.body).toEqual({
      clientId: B,
      title: expect.stringMatching(/^孪生 · 心血管（\d{4}-\d{2}-\d{2}）$/),
    });
    expect(await screen.findByText(/将请专家看看：孪生 · 心血管/)).toBeInTheDocument();
  });
});
