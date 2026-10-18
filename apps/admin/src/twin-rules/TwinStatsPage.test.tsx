import type { CurrentUser } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { ids, json, makeThresholds, makeTwinStats, mockApi, USERS } from '../test/mockApi';

function renderAt(user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#twin-stats';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /twin-stats': () => json(200, makeTwinStats(user.role === 'platform_admin')),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('孪生使用统计', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('协会管理员看到本协会合计和按日明细，没有协会列和筛选', async () => {
    renderAt(USERS.operator_admin);
    expect(await screen.findByRole('heading', { name: '孪生使用统计' })).toBeInTheDocument();
    expect(screen.getByText(/不含健管师和客户信息/)).toBeInTheDocument();
    const totals = await screen.findByRole('table', { name: '合计' });
    const row = within(totals).getAllByRole('row')[1]!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['12', '5', '3', '1', '1', '0', '2']);
    const daily = screen.getByRole('table', { name: '按日明细' });
    expect(within(daily).getByRole('rowheader', { name: '2026-10-14' })).toBeInTheDocument();
    expect(within(daily).queryByRole('columnheader', { name: '协会' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('协会')).not.toBeInTheDocument();
  });

  it('平台管理员可以按协会和日期筛选', async () => {
    const { api, user } = renderAt(USERS.platform_admin, {
      [`GET /twin-stats?from=2026-10-01&to=2026-10-15&operatorId=${ids.operator}`]: () =>
        json(200, makeTwinStats(true)),
    });
    const daily = await screen.findByRole('table', { name: '按日明细' });
    expect(within(daily).getByRole('cell', { name: '合成协会' })).toBeInTheDocument();
    const from = screen.getByLabelText('开始日期');
    await user.clear(from);
    await user.type(from, '2026-10-01');
    await user.selectOptions(screen.getByLabelText('协会'), ids.operator);
    await user.click(screen.getByRole('button', { name: '查询' }));
    expect(
      api.calls.some(
        (c) => c.path === `/twin-stats?from=2026-10-01&to=2026-10-15&operatorId=${ids.operator}`,
      ),
    ).toBe(true);
  });

  it('日期范围不对（400）时提示，不显示重试', async () => {
    renderAt(USERS.operator_admin, {
      'GET /twin-stats': () => json(400, { error: 'bad_request' }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('日期范围不正确');
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });
});
