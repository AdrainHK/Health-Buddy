import { carePlanSummarySchema, visitRecordSummarySchema } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../shell/AppShell';
import {
  ADHERENCE,
  EXERCISE,
  RECIPE,
  RECORD,
  RELAX_TEMPLATE,
  STEPS_TEMPLATE,
  careIds,
  makeCarePlan,
  makeVisit,
  todayVisits,
} from '../test/careFixtures';
import { CLIENTS, SKILL, ids, json, mockApi, setWideViewport } from '../test/mockApi';
import { followUpList, makeFollowUp, tzQuery } from '../test/twinFixtures';
import { CareView } from './CareView';
import { addDays, localToday } from './dates';

/** M5 第 4 步：方案与随访视图、今日随访分组、方案库入口。全部是合成数据 */

const CLIENT = CLIENTS[0]!;

function careRoutes(overrides: Record<string, () => Response> = {}) {
  return {
    [`GET /clients/${ids.clientA}/care-plans`]: () =>
      json(200, {
        current: carePlanSummarySchema.parse(makeCarePlan()),
        history: [
          carePlanSummarySchema.parse(
            makeCarePlan({
              id: careIds.oldPlan,
              status: 'superseded',
              startDate: '2026-08-01',
              reviewDate: '2026-09-26',
              endedAt: '2026-10-01T00:00:00.000Z',
            }),
          ),
        ],
      }),
    [`GET /care-plans/${careIds.plan}`]: () => json(200, { plan: makeCarePlan() }),
    [`GET /clients/${ids.clientA}/care-plans/current/adherence${tzQuery()}`]: () =>
      json(200, { adherence: ADHERENCE }),
    [`GET /visits?clientId=${ids.clientA}`]: () =>
      json(200, {
        visits: [
          makeVisit(),
          makeVisit({
            id: careIds.visit2,
            dueDate: '2026-11-26',
            purpose: 'plan_review',
            status: 'pending_plan',
            focus: null,
          }),
          makeVisit({ id: 'a3000000-0000-4000-8000-000000000009', status: 'done' }),
        ],
      }),
    [`GET /clients/${ids.clientA}/visit-records`]: () =>
      json(200, {
        records: [visitRecordSummarySchema.parse(RECORD)],
      }),
    [`GET /visit-records/${careIds.record}`]: () => json(200, { record: RECORD }),
    'GET /plan-library/goal-templates': () =>
      json(200, { items: [STEPS_TEMPLATE, RELAX_TEMPLATE] }),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('客户 · 方案与随访（M5 规格 2.6）', () => {
  it('显示提示条、当前方案和行为目标、执行情况、随访日程、随访记录和历史方案', async () => {
    mockApi(careRoutes());
    render(<CareView client={CLIENT} />);
    const plan = await screen.findByTestId('current-plan');
    expect(screen.getByRole('note')).toHaveTextContent('仅供参考，非医疗诊断');
    expect(plan).toHaveTextContent('生效日期 2026-10-01 · 周期 8 周 · 复评日期 2026-11-26');
    expect(plan).toHaveTextContent('包含：运动、心理');
    // 行为目标由模板和参数渲染
    expect(plan).toHaveTextContent('每天步行 7000 步');
    expect(plan).toHaveTextContent('每天做 10 分钟放松练习');

    const adherence = screen.getByTestId('adherence');
    expect(adherence).toHaveTextContent('每天步数：目标 7000 步');
    expect(adherence).toHaveTextContent('近 7 天：平均 6543.2 步，达到目标 3 天（有数据 6 天）');
    expect(adherence).toHaveTextContent('近 14 天：没有监测数据');
    // 没有关联监测指标的目标
    expect(screen.getByText('需在随访时了解')).toBeInTheDocument();

    const visits = screen.getByRole('list', { name: '随访日程' });
    const items = within(visits).getAllByRole('listitem');
    // 已完成的随访不在日程里；待方案生效的复评标出状态
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('2026-10-20 · 常规随访 · 电话');
    expect(items[0]).toHaveTextContent('了解合成客户的散步情况');
    expect(items[1]).toHaveTextContent('方案复评');
    expect(items[1]).toHaveTextContent('待方案生效');

    const records = screen.getByRole('list', { name: '随访记录' });
    expect(records).toHaveTextContent('2026-10-10 · 微信');
    expect(records).toHaveTextContent('合成客户说最近晚饭后散步');

    const history = screen.getByRole('list', { name: '历史方案' });
    expect(history).toHaveTextContent('2026-08-01 至 2026-10-01 · 运动、心理 · 已被替代');
  });

  it('没有生效方案时显示“还没有生效的方案”，不请求执行情况', async () => {
    const api = mockApi(
      careRoutes({
        [`GET /clients/${ids.clientA}/care-plans`]: () => json(200, { current: null, history: [] }),
      }),
    );
    render(<CareView client={CLIENT} />);
    expect(await screen.findByText('还没有生效的方案')).toBeInTheDocument();
    expect(screen.getByText('没有历史方案')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.includes('adherence'))).toBe(false);
  });

  it('别人的客户（404）：显示找不到，不显示任何方案内容', async () => {
    mockApi({});
    render(<CareView client={CLIENT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到这位客户的方案与随访');
  });

  it('结束方案必须选原因，确认后重新加载并通知左侧栏', async () => {
    const onChanged = vi.fn();
    const api = mockApi(
      careRoutes({
        [`POST /care-plans/${careIds.plan}/end`]: () =>
          json(200, {
            plan: carePlanSummarySchema.parse(
              makeCarePlan({ status: 'ended', endReason: 'client_paused' }),
            ),
          }),
      }),
    );
    const user = userEvent.setup();
    render(<CareView client={CLIENT} onChanged={onChanged} />);
    const plan = await screen.findByTestId('current-plan');
    await user.click(within(plan).getByRole('button', { name: '结束方案' }));
    await user.click(within(plan).getByRole('button', { name: '确认结束' }));
    expect(within(plan).getByRole('alert')).toHaveTextContent('请选择结束原因');
    expect(api.callsTo('POST', `/care-plans/${careIds.plan}/end`)).toHaveLength(0);
    await user.selectOptions(
      within(plan).getByRole('combobox', { name: '结束原因' }),
      '客户要求暂停',
    );
    await user.click(within(plan).getByRole('button', { name: '确认结束' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.callsTo('POST', `/care-plans/${careIds.plan}/end`)[0]!.body).toEqual({
      reason: 'client_paused',
    });
  });

  it('查看全文：显示确认时的专业版和通俗版快照', async () => {
    mockApi(careRoutes());
    const user = userEvent.setup();
    render(<CareView client={CLIENT} />);
    const plan = await screen.findByTestId('current-plan');
    await user.click(within(plan).getByRole('button', { name: '查看全文' }));
    const dialog = await screen.findByRole('dialog', { name: '方案全文' });
    expect(await within(dialog).findByText('合成要点')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('合成方案通俗版');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('加一次随访：选日期、方式、目的，重点可以空', async () => {
    const api = mockApi(
      careRoutes({
        [`POST /clients/${ids.clientA}/visits${tzQuery()}`]: () =>
          json(201, { visit: makeVisit({ origin: 'manual', purpose: 'adhoc' }) }),
      }),
    );
    const user = userEvent.setup();
    render(<CareView client={CLIENT} />);
    await user.click(await screen.findByRole('button', { name: '加一次随访' }));
    const form = screen.getByRole('form', { name: '加一次随访' });
    await user.selectOptions(within(form).getByRole('combobox', { name: '方式' }), '微信');
    await user.type(within(form).getByRole('textbox'), '  问问周末的安排 ');
    await user.click(within(form).getByRole('button', { name: '加入日程' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/clients/${ids.clientA}/visits${tzQuery()}`)).toHaveLength(1),
    );
    expect(api.callsTo('POST', `/clients/${ids.clientA}/visits${tzQuery()}`)[0]!.body).toEqual({
      dueDate: localToday(),
      method: 'wechat',
      purpose: 'adhoc',
      focus: '问问周末的安排',
    });
    await waitFor(() => expect(screen.queryByRole('form', { name: '加一次随访' })).toBeNull());
  });

  it('随访记录：点开看全文，补充说明只追加', async () => {
    const api = mockApi(
      careRoutes({
        [`POST /visit-records/${careIds.record}/addenda`]: () =>
          json(201, {
            record: {
              ...RECORD,
              addenda: [
                { id: careIds.addendum, text: '合成补充', createdAt: '2026-10-16T08:00:00.000Z' },
              ],
            },
          }),
      }),
    );
    const user = userEvent.setup();
    render(<CareView client={CLIENT} />);
    const records = await screen.findByRole('list', { name: '随访记录' });
    await user.click(within(records).getByRole('button', { name: '查看全文' }));
    expect(await within(records).findByText('合成客户说晚饭后散步 20 分钟')).toBeInTheDocument();
    expect(records).toHaveTextContent('生活习惯：每周散步约 4 次');
    expect(records).toHaveTextContent('需要健管师关注的点没有提到');
    await user.click(within(records).getByRole('button', { name: '写补充说明' }));
    await user.type(within(records).getByRole('textbox'), '合成补充');
    await user.click(within(records).getByRole('button', { name: '追加' }));
    expect(await within(records).findByText('合成补充')).toBeInTheDocument();
    expect(api.callsTo('POST', `/visit-records/${careIds.record}/addenda`)[0]!.body).toEqual({
      text: '合成补充',
    });
  });

  it('处理随访：完成时不关联记录必须写备注；未联系上默认顺延 2 天', async () => {
    const api = mockApi(
      careRoutes({
        [`PATCH /visits/${careIds.visit1}${tzQuery()}`]: () =>
          json(200, { visit: makeVisit({ status: 'missed' }) }),
      }),
    );
    const user = userEvent.setup();
    render(<CareView client={CLIENT} />);
    const visits = await screen.findByRole('list', { name: '随访日程' });
    const first = within(visits).getAllByRole('listitem')[0]!;
    await user.click(within(first).getByRole('button', { name: /处理/ }));
    // 记录列表加载后可以选
    expect(
      await within(first).findByRole('option', { name: '2026-10-10 · 微信' }),
    ).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: '确定' }));
    expect(within(first).getByRole('alert')).toHaveTextContent('不关联随访记录时，请写一句备注');
    expect(api.callsTo('PATCH', `/visits/${careIds.visit1}${tzQuery()}`)).toHaveLength(0);

    await user.click(within(first).getByRole('radio', { name: '未联系上' }));
    expect(within(first).getByLabelText('顺延到')).toHaveValue(addDays(localToday(), 2));
    await user.click(within(first).getByRole('button', { name: '确定' }));
    await waitFor(() =>
      expect(api.callsTo('PATCH', `/visits/${careIds.visit1}${tzQuery()}`)).toHaveLength(1),
    );
    expect(api.callsTo('PATCH', `/visits/${careIds.visit1}${tzQuery()}`)[0]!.body).toEqual({
      action: 'missed',
      newDate: addDays(localToday(), 2),
    });
  });

  it('等方案生效的复评只能取消，取消必须选原因', async () => {
    const api = mockApi(
      careRoutes({
        [`PATCH /visits/${careIds.visit2}${tzQuery()}`]: () =>
          json(200, { visit: makeVisit({ id: careIds.visit2, status: 'cancelled' }) }),
      }),
    );
    const user = userEvent.setup();
    render(<CareView client={CLIENT} />);
    const visits = await screen.findByRole('list', { name: '随访日程' });
    const review = within(visits).getAllByRole('listitem')[1]!;
    await user.click(within(review).getByRole('button', { name: /处理/ }));
    expect(within(review).getAllByRole('radio')).toHaveLength(1);
    await user.click(within(review).getByRole('button', { name: '确定' }));
    expect(within(review).getByRole('alert')).toHaveTextContent('请选择取消原因');
    await user.selectOptions(within(review).getByRole('combobox', { name: '取消原因' }), '重复');
    await user.click(within(review).getByRole('button', { name: '确定' }));
    await waitFor(() =>
      expect(api.callsTo('PATCH', `/visits/${careIds.visit2}${tzQuery()}`)[0]?.body).toEqual({
        action: 'cancel',
        cancelReason: 'duplicate',
      }),
    );
  });

  it('处理时随访已被处理过（409）：提示并刷新', async () => {
    const api = mockApi(
      careRoutes({
        [`PATCH /visits/${careIds.visit1}${tzQuery()}`]: () => json(409, { error: 'conflict' }),
      }),
    );
    const user = userEvent.setup();
    render(<CareView client={CLIENT} />);
    const visits = await screen.findByRole('list', { name: '随访日程' });
    const first = within(visits).getAllByRole('listitem')[0]!;
    await user.click(within(first).getByRole('button', { name: /处理/ }));
    await user.click(within(first).getByRole('radio', { name: '未联系上' }));
    await user.click(within(first).getByRole('button', { name: '确定' }));
    await waitFor(() =>
      expect(api.callsTo('GET', `/visits?clientId=${ids.clientA}`).length).toBeGreaterThan(1),
    );
  });
});

function mockShell(extra: Record<string, () => Response> = {}) {
  return mockApi({
    'GET /tasks': () => json(200, { tasks: [] }),
    'GET /clients': () => json(200, { clients: CLIENTS }),
    'GET /skills': () => json(200, { skills: [SKILL] }),
    [`GET /follow-ups${tzQuery()}`]: () => json(200, followUpList([makeFollowUp()])),
    [`GET /visits/today${tzQuery()}`]: () =>
      json(
        200,
        todayVisits([
          {
            ...makeVisit({ dueDate: '2026-10-12', status: 'missed' }),
            clientName: CLIENTS[0]!.displayName,
            overdueDays: 3,
          },
          {
            ...makeVisit({
              id: careIds.visit2,
              clientId: ids.clientB,
              purpose: 'plan_review',
              dueDate: '2026-10-15',
            }),
            clientName: CLIENTS[1]!.displayName,
            overdueDays: 0,
          },
        ]),
      ),
    'GET /twin/levels': () => json(200, { clients: [] }),
    ...extra,
  });
}

describe('今日跟进：异常跟进和今日随访两组（M5 规格 2.7，Q19）', () => {
  beforeEach(() => setWideViewport());

  it('角标是两组未处理数量之和；今日随访按后端顺序显示逾期天数、目的、方式和重点', async () => {
    mockShell();
    const user = userEvent.setup();
    render(<AppShell />);
    const entry = await screen.findByRole('button', { name: /今日跟进.*3 项未处理/ });
    await user.click(entry);
    expect(await screen.findByRole('heading', { name: /异常跟进\s*1 项/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /今日随访\s*2 项/ })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: '今日随访' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('合成客户甲 · 2026-10-12 · 常规随访 · 电话');
    expect(items[0]).toHaveTextContent('已逾期 3 天');
    expect(items[0]).toHaveTextContent('未联系上');
    expect(items[1]).toHaveTextContent('合成客户乙 · 2026-10-15 · 方案复评 · 电话');
    expect(items[1]).toHaveTextContent('今天到期');
    // 打开客户：结果区切到客户标签
    await user.click(within(items[1]!).getByRole('button', { name: '打开合成客户乙' }));
    expect(screen.getByRole('tab', { name: '客户' })).toHaveAttribute('aria-selected', 'true');
  });

  it('跟进项上“加一次随访”：关联这条跟进项，目的是跟进项回访，加完刷新今日随访', async () => {
    const item = makeFollowUp();
    const api = mockShell({
      [`POST /clients/${item.clientId}/visits${tzQuery()}`]: () =>
        json(201, { visit: makeVisit({ origin: 'manual', purpose: 'follow_up' }) }),
    });
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: /今日跟进.*3 项未处理/ }));
    const alerts = await screen.findByRole('list', { name: '异常跟进' });
    await user.click(within(alerts).getByRole('button', { name: /加一次随访/ }));
    const form = within(alerts).getByRole('form', { name: '加一次随访' });
    // 目的固定为跟进项回访，不显示目的选择
    expect(within(form).queryByRole('combobox', { name: '目的' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: '加入日程' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/clients/${item.clientId}/visits${tzQuery()}`)).toHaveLength(1),
    );
    expect(api.callsTo('POST', `/clients/${item.clientId}/visits${tzQuery()}`)[0]!.body).toEqual({
      dueDate: localToday(),
      method: 'phone',
      purpose: 'follow_up',
      followUpItemId: item.id,
    });
    await waitFor(() =>
      expect(api.callsTo('GET', `/visits/today${tzQuery()}`).length).toBeGreaterThan(1),
    );
  });

  it('今日随访读不到时只影响这一组，异常跟进照常显示', async () => {
    mockShell({ [`GET /visits/today${tzQuery()}`]: () => json(500, { error: 'internal_error' }) });
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: /今日跟进.*1 项未处理/ }));
    expect(await screen.findByText('今日随访加载失败')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '异常跟进' })).toBeInTheDocument();
  });

  it('客户标签有“孪生 / 方案与随访 / 档案”三个子视图', async () => {
    mockShell({
      ...careRoutes(),
      [`GET /clients/${ids.clientA}/twin`]: () => json(404, { error: 'not_found' }),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
    });
    const user = userEvent.setup();
    render(<AppShell />);
    const clients = await screen.findByRole('region', { name: '客户' });
    await user.click(await within(clients).findByRole('button', { name: /合成客户甲/ }));
    const panel = screen.getByRole('tabpanel');
    const views = within(panel).getByRole('group', { name: '客户视图' });
    expect(
      within(views)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['孪生', '方案与随访', '档案']);
    await user.click(within(views).getByRole('button', { name: '方案与随访' }));
    expect(await within(panel).findByTestId('current-plan')).toHaveTextContent('每天步行 7000 步');
  });
});

describe('方案库（M5 规格 2.4）', () => {
  beforeEach(() => setWideViewport());

  it('左侧栏进入方案库：按餐次和特点筛选食谱，点开看食材、过敏原；没有编辑入口', async () => {
    const api = mockShell({
      'GET /plan-library/recipes': () => json(200, { items: [RECIPE] }),
      'GET /plan-library/recipes?meal=breakfast': () => json(200, { items: [RECIPE] }),
      'GET /plan-library/recipes?meal=breakfast&tags=high_fiber': () =>
        json(200, { items: [RECIPE] }),
    });
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: '方案库' }));
    expect(await screen.findByRole('heading', { level: 1, name: '方案库' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: '方案库' });
    expect(list).toHaveTextContent('合成燕麦粥');
    await user.selectOptions(screen.getByRole('combobox', { name: '餐次' }), '早餐');
    await user.selectOptions(screen.getByRole('combobox', { name: '特点' }), '高纤维');
    await waitFor(() =>
      expect(
        api.callsTo('GET', '/plan-library/recipes?meal=breakfast&tags=high_fiber'),
      ).toHaveLength(1),
    );
    await user.click(screen.getByRole('button', { name: /合成燕麦粥/ }));
    expect(screen.getByRole('heading', { level: 2, name: '合成燕麦粥' })).toHaveFocus();
    expect(screen.getByText('第 2 版')).toBeInTheDocument();
    expect(screen.getByText('乳制品、麸质')).toBeInTheDocument();
    expect(screen.getByText(/半碗/)).toHaveTextContent('燕麦 半碗 约 40 克');
    expect(screen.queryByRole('button', { name: /编辑|修改|保存/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(screen.getByRole('list', { name: '方案库' })).toBeInTheDocument();
  });

  it('运动条目显示给健管师看的注意事项；目标模板显示参数范围', async () => {
    mockShell({
      'GET /plan-library/recipes': () => json(200, { items: [] }),
      'GET /plan-library/exercises': () => json(200, { items: [EXERCISE] }),
      'GET /plan-library/goal-templates': () => json(200, { items: [STEPS_TEMPLATE] }),
    });
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(await screen.findByRole('button', { name: '方案库' }));
    expect(await screen.findByText('没有符合条件的条目')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '运动和放松练习' }));
    await user.click(await screen.findByRole('button', { name: /合成快走/ }));
    expect(screen.getByText('合成注意事项：有胸闷时先问医生')).toBeInTheDocument();
    expect(screen.getByText('器材：无器材')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '目标模板' }));
    const goal = await screen.findByRole('button', { name: /每天步行 \[4000–10000\] 步/ });
    await user.click(goal);
    expect(screen.getByText('steps：4000–10000 步，默认 6000 步')).toBeInTheDocument();
    expect(screen.getByText('执行情况对照：每天步数')).toBeInTheDocument();
  });
});
