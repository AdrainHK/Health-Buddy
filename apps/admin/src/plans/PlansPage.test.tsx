import type { Plan } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, USERS } from '../test/mockApi';

const PILOT: Plan = {
  id: '55555555-5555-4555-8555-555555555551',
  code: 'pilot',
  name: '试点版',
  features: { experts: true, twin: true, care: true, companion: true, content: true },
  monthlyQuotas: {
    llm_calls: null,
    expert_calls: null,
    report_pages: null,
    companion_devices: null,
  },
  status: 'active',
  assignedCount: 3,
  updatedAt: '2026-10-31T00:00:00.000Z',
};
const BASIC: Plan = {
  ...PILOT,
  id: '55555555-5555-4555-8555-555555555552',
  code: 'basic',
  name: '合成基础版',
  features: { ...PILOT.features, experts: false },
  monthlyQuotas: { ...PILOT.monthlyQuotas, llm_calls: 500 },
  assignedCount: 2,
};

function renderPage(routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#plans';
  const api = mockApi(USERS.platform_admin, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/plans': () => json(200, { plans: [PILOT, BASIC] }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('平台套餐页（M7 规格 2.5）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('列表显示功能、额度（空为不限）和使用人数；试点版不能停售', async () => {
    renderPage();
    const basic = (await screen.findByRole('rowheader', { name: /合成基础版/ })).closest('tr')!;
    expect(basic).toHaveTextContent('数字孪生');
    expect(basic).not.toHaveTextContent('专家中心');
    expect(basic).toHaveTextContent('大模型调用（次/月）：500');
    expect(basic).toHaveTextContent('专家调用（次/月）：不限');
    expect(within(basic).getByRole('button', { name: '停售合成基础版' })).toBeInTheDocument();
    const pilot = screen.getByRole('rowheader', { name: /试点版/ }).closest('tr')!;
    expect(within(pilot).queryByRole('button', { name: /停售/ })).toBeNull();
  });

  it('新建套餐：留空的额度提交为 null；修改前确认影响的人数', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, user } = renderPage({
      'POST /admin/plans': () =>
        json(201, {
          plan: { ...BASIC, id: PILOT.id.replace('1', '9'), code: 'pro', name: '合成专业版' },
        }),
      [`PATCH /admin/plans/${BASIC.id}`]: () => json(200, { plan: BASIC }),
    });
    await user.click(await screen.findByRole('button', { name: '新建套餐' }));
    let dialog = screen.getByRole('dialog', { name: '新建套餐' });
    await user.type(within(dialog).getByLabelText('代码'), 'pro');
    await user.type(within(dialog).getByLabelText('名称'), '合成专业版');
    await user.click(within(dialog).getByLabelText('AI 健康伴侣'));
    await user.type(within(dialog).getByLabelText('专家调用（次/月）'), '100');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(api.callsTo('POST', '/admin/plans')[0]?.body).toEqual({
      code: 'pro',
      name: '合成专业版',
      features: { experts: true, twin: true, care: true, companion: false, content: true },
      monthlyQuotas: {
        llm_calls: null,
        expert_calls: 100,
        report_pages: null,
        companion_devices: null,
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('已保存');

    await user.click(screen.getByRole('button', { name: '编辑合成基础版' }));
    dialog = screen.getByRole('dialog', { name: '编辑：合成基础版' });
    expect(within(dialog).getByLabelText('代码')).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 位健管师'));
    expect(api.callsTo('PATCH', `/admin/plans/${BASIC.id}`)).toHaveLength(1);
  });

  it('额度不是非负整数时不提交', async () => {
    const { api, user } = renderPage();
    await user.click(await screen.findByRole('button', { name: '新建套餐' }));
    const dialog = screen.getByRole('dialog', { name: '新建套餐' });
    await user.type(within(dialog).getByLabelText('代码'), 'x');
    await user.type(within(dialog).getByLabelText('名称'), '合成');
    await user.type(within(dialog).getByLabelText('大模型调用（次/月）'), '-5');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('非负整数');
    expect(api.callsTo('POST', '/admin/plans')).toHaveLength(0);
  });
});
