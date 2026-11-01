import type { CompanionAlert, HomeResponse, SkillSummary } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../shell/AppShell';
import { makeVisit, todayVisits } from '../test/careFixtures';
import {
  CLIENTS,
  NOW,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeTask,
  mockApi,
  setWideViewport,
} from '../test/mockApi';
import { followUpList, makeFollowUp, tzQuery } from '../test/twinFixtures';

/** M8 第 1 步：工作台首页（规格 2.4，验收 9、10、11）。全部是合成数据 */

const ALERT: CompanionAlert = {
  id: '00000000-0000-4000-8000-0000000000a1',
  clientId: ids.clientA,
  clientName: '合成客户甲',
  category: 'crisis',
  trigger: 'keyword',
  said: '合成：活着没意思',
  companionSaid: '请马上联系家人，或拨打 120。',
  status: 'open',
  resolution: null,
  note: null,
  handledAt: null,
  createdAt: NOW,
};

const CARE_SKILL: SkillSummary = { ...SKILL, id: 'care-plan' };
const VISIT_SKILL: SkillSummary = { ...SKILL, id: 'visit-script' };
const DRAFT_TASK = makeTask({ id: ids.task2, title: '合成任务二', clientId: ids.clientA });

function homeBody(overrides: Partial<HomeResponse> = {}): HomeResponse {
  return {
    drafts: {
      total: 2,
      items: [
        {
          artifactId: ids.artifact,
          taskId: ids.task2,
          taskTitle: '合成任务二',
          clientId: ids.clientA,
          skillId: 'client-recent-summary',
          version: 1,
          status: 'draft',
          hasCriticalFlags: true,
          createdAt: '2026-10-10T08:00:00.000Z',
        },
        {
          artifactId: ids.artifact2,
          taskId: ids.task2,
          taskTitle: '合成任务二',
          clientId: ids.clientA,
          skillId: 'client-recent-summary',
          version: 2,
          status: 'draft',
          hasCriticalFlags: false,
          createdAt: '2026-10-12T08:00:00.000Z',
        },
      ],
    },
    usage: { skills: ['visit-script'], experts: [] },
    ...overrides,
  };
}

function routes(overrides: Record<string, () => Response> = {}) {
  return {
    'GET /tasks': () => json(200, { tasks: [DRAFT_TASK] }),
    'GET /clients': () => json(200, { clients: CLIENTS }),
    'GET /skills': () => json(200, { skills: [SKILL, CARE_SKILL, VISIT_SKILL] }),
    'GET /experts': () => json(200, { experts: [] }),
    'GET /twin/levels': () => json(200, { levels: [] }),
    'GET /companion/inbox': () =>
      json(200, { alerts: [ALERT], handoffs: [], pendingReadings: [], offlineDevices: [] }),
    [`GET /follow-ups${tzQuery()}`]: () => json(200, followUpList([makeFollowUp()])),
    [`GET /visits/today${tzQuery()}`]: () =>
      json(200, todayVisits([{ ...makeVisit(), clientName: '合成客户甲', overdueDays: 0 }])),
    'GET /home': () => json(200, homeBody()),
    [`GET /tasks/${ids.task2}`]: () => json(200, emptyDetail(DRAFT_TASK)),
    ...overrides,
  };
}

const headings = () =>
  within(screen.getByTestId('home'))
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent ?? '');

beforeEach(() => setWideViewport());
afterEach(() => vi.unstubAllGlobals());

describe('工作台首页', () => {
  it('验收 9：登录后默认是首页，分区依次是伴侣预警、今日优先跟进、今日随访、待审核草稿、快捷入口', async () => {
    mockApi(routes());
    render(<AppShell />);
    expect(await screen.findByText('今天想让我帮你做什么？')).toBeInTheDocument();
    await screen.findByRole('list', { name: '待审核草稿' });
    const order = headings().map((h) => h.replace(/\d+ 项$/, '').trim());
    expect(order).toEqual(['伴侣预警和转交', '今日优先跟进', '今日随访', '待审核草稿', '快捷入口']);
    expect(screen.getByRole('button', { name: '首页' })).toHaveAttribute('aria-current', 'page');
    // 草稿按生成时间从早到晚；有危急指标的标出来
    const drafts = within(screen.getByRole('list', { name: '待审核草稿' })).getAllByRole('button');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toHaveTextContent('第1版');
    expect(drafts[0]).toHaveTextContent('含危急指标');
    expect(drafts[1]).toHaveTextContent('第2版');
    // 快捷入口：用过的技能排在最前，其余按默认顺序
    const skills = within(screen.getByRole('list', { name: '常用技能' })).getAllByRole('button');
    expect(skills.map((b) => b.textContent)).toEqual(['/随访话术', '/方案生成', '/客户近况小结']);
  });

  it('点待审核草稿：打开任务，结果区打开这份产物', async () => {
    const api = mockApi(
      routes({
        [`GET /tasks/${ids.task2}`]: () =>
          json(200, {
            ...emptyDetail(DRAFT_TASK),
            artifacts: [
              {
                id: ids.artifact2,
                taskId: ids.task2,
                skillId: 'client-recent-summary',
                version: 2,
                status: 'draft',
                hasCriticalFlags: false,
                createdAt: '2026-10-12T08:00:00.000Z',
                sourceReportDate: null,
                sourceFileName: null,
              },
            ],
          }),
      }),
    );
    const user = userEvent.setup();
    render(<AppShell />);
    const list = await screen.findByRole('list', { name: '待审核草稿' });
    await user.click(within(list).getAllByRole('button')[1]!);
    await waitFor(() =>
      expect(api.callsTo('GET', `/artifacts/${ids.artifact2}`).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('list', { name: '待审核草稿' })).not.toBeInTheDocument();
  });

  it('验收 10：其他分区出错时，伴侣预警照常显示且排在最上面', async () => {
    mockApi(
      routes({
        [`GET /follow-ups${tzQuery()}`]: () => json(500, { error: 'internal' }),
        [`GET /visits/today${tzQuery()}`]: () => json(500, { error: 'internal' }),
        'GET /home': () => json(500, { error: 'internal' }),
      }),
    );
    render(<AppShell />);
    expect(await screen.findByText('待审核草稿加载失败')).toBeInTheDocument();
    expect(await screen.findByText('今日随访加载失败')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '伴侣预警' })).toHaveTextContent('合成客户甲');
    expect(headings()[0]).toContain('伴侣预警和转交');
  });

  it('验收 11：套餐关闭“方案与随访”后不显示今日随访和相关快捷入口，伴侣预警照常显示', async () => {
    mockApi(
      routes({
        'GET /me/plan': () =>
          json(200, {
            plan: {
              code: 'basic',
              name: '基础版',
              features: { experts: true, twin: true, care: false, companion: false, content: true },
              monthlyQuotas: {
                llm_calls: null,
                expert_calls: null,
                report_pages: null,
                companion_devices: null,
              },
              contractEnd: null,
              usage: { llm_calls: 0, expert_calls: 0, report_pages: 0, companion_devices: 0 },
            },
          }),
      }),
    );
    render(<AppShell account={{ name: '合成健管师', onLogout: () => {} }} />);
    await screen.findByRole('list', { name: '待审核草稿' });
    await waitFor(() => expect(headings().join()).not.toContain('今日随访'));
    expect(headings()[0]).toContain('伴侣预警和转交');
    const skills = within(screen.getByRole('list', { name: '常用技能' })).getAllByRole('button');
    expect(skills.map((b) => b.textContent)).toEqual(['/客户近况小结']);
  });

  it('快捷入口点技能：输入框选好这个技能，不新建任务', async () => {
    const api = mockApi(routes());
    const user = userEvent.setup();
    render(<AppShell />);
    const skills = await screen.findByRole('list', { name: '常用技能' });
    await user.click(within(skills).getByRole('button', { name: '/方案生成' }));
    expect(await screen.findByRole('button', { name: '移除技能 方案生成' })).toBeInTheDocument();
    expect(api.callsTo('POST', '/tasks')).toHaveLength(0);
  });

  it('伴侣预警和转交、草稿都为空时显示空状态', async () => {
    mockApi(
      routes({
        'GET /companion/inbox': () =>
          json(200, { alerts: [], handoffs: [], pendingReadings: [], offlineDevices: [] }),
        'GET /home': () => json(200, homeBody({ drafts: { total: 0, items: [] } })),
      }),
    );
    render(<AppShell />);
    expect(await screen.findByText('没有待处理的伴侣预警和转交')).toBeInTheDocument();
    expect(await screen.findByText('没有待审核的草稿')).toBeInTheDocument();
  });
});
