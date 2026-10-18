import type { CurrentUser } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { expertIds, json, makeStats, makeThresholds, mockApi, USERS } from '../test/mockApi';

function renderAt(user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#expert-stats';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /expert-stats': () => json(200, makeStats(user.role === 'platform_admin')),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('专家调用统计', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('协会管理员看到本协会按专家合计和按日明细，没有协会列和协会筛选', async () => {
    const { api } = renderAt(USERS.operator_admin);
    expect(await screen.findByRole('heading', { name: '专家调用统计' })).toBeInTheDocument();
    expect(screen.getByText(/本协会健管师请 AI 专家的次数/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('费用为按模型价目表计算的估算值');
    expect(screen.queryByRole('link', { name: '专家管理' })).not.toBeInTheDocument();

    const totals = await screen.findByRole('table', { name: '按专家合计' });
    const row = within(totals).getByRole('rowheader', { name: '营养专家' }).closest('tr')!;
    for (const text of ['4', '75%', '25%', '1200', '600', '0.0123', '2', '1']) {
      expect(row).toHaveTextContent(text);
    }
    const daily = screen.getByRole('table', { name: '按日明细' });
    expect(within(daily).getByRole('rowheader', { name: '2026-10-14' })).toBeInTheDocument();
    expect(within(daily).queryByRole('columnheader', { name: '协会' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('协会')).not.toBeInTheDocument();

    // 默认范围由后端给出，填进输入框
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-09-16');
    expect(screen.getByLabelText('结束日期')).toHaveValue('2026-10-15');
    expect(api.callsTo('GET', '/expert-stats')).toHaveLength(1);
  });

  it('改日期后按新范围查询', async () => {
    const { api, user } = renderAt(USERS.operator_admin, {
      'GET /expert-stats?from=2026-10-01&to=2026-10-15': () =>
        json(200, { ...makeStats(false), from: '2026-10-01', rows: [], totals: [] }),
    });
    const from = await screen.findByLabelText('开始日期');
    await screen.findByRole('table', { name: '按专家合计' });
    await user.clear(from);
    await user.type(from, '2026-10-01');
    await user.click(screen.getByRole('button', { name: '查询' }));
    expect(await screen.findByText('这段时间没有专家调用')).toBeInTheDocument();
    expect(api.callsTo('GET', '/expert-stats?from=2026-10-01&to=2026-10-15')).toHaveLength(1);
  });

  it('日期范围不对（400）时提示范围要求', async () => {
    const { user } = renderAt(USERS.operator_admin, {
      'GET /expert-stats?from=2026-10-20&to=2026-10-15': () => json(400, { error: 'bad_request' }),
    });
    const from = await screen.findByLabelText('开始日期');
    await screen.findByRole('table', { name: '按专家合计' });
    await user.clear(from);
    await user.type(from, '2026-10-20');
    await user.click(screen.getByRole('button', { name: '查询' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('开始日期不能晚于结束日期');
  });

  it('平台管理员看全平台，按日明细带协会，可以按协会筛选', async () => {
    const { api, user } = renderAt(USERS.platform_admin, {
      [`GET /expert-stats?from=2026-09-16&to=2026-10-15&operatorId=${expertIds.otherOperator}`]:
        () => json(200, { ...makeStats(true), operatorId: expertIds.otherOperator }),
    });
    expect(await screen.findByText(/全平台各协会请 AI 专家的次数/)).toBeInTheDocument();
    const daily = await screen.findByRole('table', { name: '按日明细' });
    expect(within(daily).getByRole('columnheader', { name: '协会' })).toBeInTheDocument();
    expect(daily).toHaveTextContent('合成协会');

    await user.selectOptions(screen.getByLabelText('协会'), expertIds.otherOperator);
    await user.click(screen.getByRole('button', { name: '查询' }));
    expect(
      api.callsTo(
        'GET',
        `/expert-stats?from=2026-09-16&to=2026-10-15&operatorId=${expertIds.otherOperator}`,
      ),
    ).toHaveLength(1);
  });

  it('机构管理员看不到专家统计', async () => {
    window.location.hash = '#expert-stats';
    const api = mockApi(USERS.org_admin, {
      'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: '危急指标设置' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '专家统计' })).not.toBeInTheDocument();
    expect(api.callsTo('GET', '/expert-stats')).toHaveLength(0);
  });

  it('加载失败时可以重试', async () => {
    let fail = true;
    const { user } = renderAt(USERS.operator_admin, {
      'GET /expert-stats': () =>
        fail ? json(500, { error: 'internal_error' }) : json(200, makeStats(false)),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('统计加载失败');
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('table', { name: '按专家合计' })).toBeInTheDocument();
  });
});
