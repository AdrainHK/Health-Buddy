import type { Checkin, CheckinPlan } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOW, ids, json, mockApi } from '../test/mockApi';
import { CheckinSection } from './CheckinPlans';

/** “伴侣”视图的打卡（M6 规格 2.3、2.8）。全部是合成数据 */

const PLANS = `/clients/${ids.clientA}/checkin-plans`;
const CHECKINS = `/clients/${ids.clientA}/checkins`;
const GOALS = '/plan-library/goal-templates?section=exercise';
const PLAN_ID = '00000000-0000-4000-8000-0000000000c1';
const GOAL_ID = '00000000-0000-4000-8000-0000000000a1';

const bpPlan: CheckinPlan = {
  id: PLAN_ID,
  kind: 'measurement',
  metric: 'bp',
  slots: [
    { slot: 'morning', time: '08:30' },
    { slot: 'bedtime', time: '21:00' },
  ],
  goalTemplateId: null,
  note: '合成备注',
  active: true,
  createdAt: NOW,
};
const history: Checkin[] = [
  {
    id: '00000000-0000-4000-8000-0000000000d1',
    planId: PLAN_ID,
    kind: 'measurement',
    metric: 'bp',
    dueOn: '2026-10-28',
    slot: 'morning',
    status: 'done',
    values: [132, 86],
    answeredAt: NOW,
  },
  {
    id: '00000000-0000-4000-8000-0000000000d2',
    planId: PLAN_ID,
    kind: 'measurement',
    metric: 'bp',
    dueOn: '2026-10-27',
    slot: 'morning',
    status: 'no_response',
    values: [],
    answeredAt: null,
  },
];
const goal = {
  id: GOAL_ID,
  version: 1,
  code: 'walk-daily',
  section: 'exercise',
  text: '每天快走 {minutes} 分钟',
  params: [],
  metric: null,
  metricParam: null,
  sourceNote: '合成来源',
};

afterEach(() => vi.unstubAllGlobals());

describe('伴侣视图 · 打卡', () => {
  it('列出计划和近 30 天打卡：测量类显示客户报的数，不评价', async () => {
    mockApi({
      [`GET ${PLANS}`]: () => json(200, { plans: [bpPlan] }),
      [`GET ${CHECKINS}`]: () => json(200, { checkins: history }),
      [`GET ${GOALS}`]: () => json(200, { items: [goal] }),
    });
    render(<CheckinSection clientId={ids.clientA} />);
    expect(await screen.findByRole('listitem')).toHaveTextContent('测量 · 血压');
    expect(screen.getByText('早 08:30、睡前 21:00')).toBeInTheDocument();
    expect(screen.getByText('备注：合成备注')).toBeInTheDocument();
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('2026-10-28测量 · 血压早完成 客户报：132 / 86');
    expect(rows[2]).toHaveTextContent('未应答');
    expect(table).not.toHaveTextContent(/偏高|正常|异常/);
  });

  it('新增服药计划：不填药名，时间要在时间段内；运动计划可以选方案里的行为目标', async () => {
    const api = mockApi({
      [`GET ${PLANS}`]: () => json(200, { plans: [] }),
      [`GET ${CHECKINS}`]: () => json(200, { checkins: [] }),
      [`GET ${GOALS}`]: () => json(200, { items: [goal] }),
      [`POST ${PLANS}`]: () => json(201, { plan: { ...bpPlan, kind: 'medication', metric: null } }),
    });
    const user = userEvent.setup();
    render(<CheckinSection clientId={ids.clientA} />);
    await user.click(await screen.findByRole('button', { name: '新增打卡计划' }));
    const form = screen.getByRole('form', { name: '新增打卡计划' });
    expect(within(form).getByText(/不说药名和剂量/)).toBeInTheDocument();
    const morning = within(form).getByLabelText('早的提醒时间');
    await user.clear(morning);
    await user.type(morning, '12:00');
    expect(within(form).getByRole('alert')).toHaveTextContent('提醒时间要在所选时间段内');
    expect(within(form).getByRole('button', { name: '保存' })).toBeDisabled();
    await user.clear(morning);
    await user.type(morning, '07:30');
    await user.click(within(form).getByRole('checkbox', { name: /睡前/ }));
    await user.type(within(form).getByRole('textbox'), '早饭后');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.callsTo('POST', PLANS)).toHaveLength(1));
    expect(api.callsTo('POST', PLANS)[0]!.body).toEqual({
      kind: 'medication',
      metric: null,
      slots: [
        { slot: 'morning', time: '07:30' },
        { slot: 'bedtime', time: '21:00' },
      ],
      goalTemplateId: null,
      note: '早饭后',
    });
    // 运动计划：可以选行为目标（参数在方案里，这里只显示模板）
    await user.click(await screen.findByRole('button', { name: '新增打卡计划' }));
    const exercise = screen.getByRole('form', { name: '新增打卡计划' });
    await user.selectOptions(within(exercise).getByLabelText('类别'), 'exercise');
    await user.selectOptions(within(exercise).getByLabelText(/行为目标/), '每天快走 … 分钟');
    await user.click(within(exercise).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.callsTo('POST', PLANS)).toHaveLength(2));
    expect(api.callsTo('POST', PLANS)[1]!.body).toMatchObject({
      kind: 'exercise',
      goalTemplateId: GOAL_ID,
    });
  });

  it('停用计划', async () => {
    const api = mockApi({
      [`GET ${PLANS}`]: () => json(200, { plans: [bpPlan] }),
      [`GET ${CHECKINS}`]: () => json(200, { checkins: [] }),
      [`GET ${GOALS}`]: () => json(200, { items: [] }),
      [`PATCH ${PLANS}/${PLAN_ID}`]: () => json(200, { plan: { ...bpPlan, active: false } }),
    });
    const user = userEvent.setup();
    render(<CheckinSection clientId={ids.clientA} />);
    await user.click(await screen.findByRole('button', { name: '停用' }));
    await waitFor(() => expect(api.callsTo('PATCH', `${PLANS}/${PLAN_ID}`)).toHaveLength(1));
    expect(api.callsTo('PATCH', `${PLANS}/${PLAN_ID}`)[0]!.body).toEqual({ active: false });
  });

  it('读取失败时提示，可以重试', async () => {
    mockApi({
      [`GET ${PLANS}`]: () => json(404, { error: { code: 'not_found' } }),
      [`GET ${CHECKINS}`]: () => json(404, { error: { code: 'not_found' } }),
      [`GET ${GOALS}`]: () => json(200, { items: [] }),
    });
    render(<CheckinSection clientId={ids.clientA} />);
    expect(await screen.findByText('打卡读取失败，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
