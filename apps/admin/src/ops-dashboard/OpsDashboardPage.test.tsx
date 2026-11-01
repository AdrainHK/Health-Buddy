import { emptyMetrics, type OpsDashboardResponse } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { ids, json, makeThresholds, mockApi, USERS } from '../test/mockApi';

const ORG = '66666666-6666-4666-8666-666666666661';
const OP_B = '66666666-6666-4666-8666-666666666662';

function board(over: Partial<OpsDashboardResponse> = {}): OpsDashboardResponse {
  return {
    from: '2026-10-03',
    to: '2026-11-01',
    totals: { metrics: { ...emptyMetrics(), managers_opened: 12, llm_calls: 340 }, costUsd: null },
    groups: [
      {
        kind: 'org',
        orgId: ORG,
        name: '合成一号机构',
        hidden: false,
        metrics: { ...emptyMetrics(), managers_opened: 8, llm_calls: 300 },
        costUsd: null,
      },
      {
        kind: 'other',
        orgId: null,
        name: null,
        hidden: true,
        metrics: emptyMetrics(),
        costUsd: null,
      },
    ],
    skills: [{ skillId: 'client-recent-summary', title: '近况小结', n: 7 }],
    twinOpens: 21,
    seats: { used: 12, limit: 20 },
    operators: null,
    ...over,
  };
}

describe('运营看板（M7 规格 2.6）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('协会管理员：卡片、按机构表格（不足 5 人的“其他”不显示数字）、技能使用；切换时间范围；不显示成本', async () => {
    window.location.hash = '#ops';
    const api = mockApi(USERS.operator_admin, {
      'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
      'GET /admin/ops-dashboard?days=30': () => json(200, { ...board() }),
      'GET /admin/ops-dashboard?days=7': () => json(200, board({ from: '2026-10-26' })),
    });
    const user = userEvent.setup();
    render(<App />);
    const cards = await screen.findByTestId('ops-cards');
    expect(cards).toHaveTextContent('AI 调用340');
    expect(cards).toHaveTextContent('席位12 / 20');
    expect(cards).not.toHaveTextContent('估算成本');
    const other = screen.getByRole('rowheader', { name: '其他' }).closest('tr')!;
    expect(other).toHaveTextContent('人数太少，不显示数字');
    expect(screen.getByRole('rowheader', { name: '合成一号机构' }).closest('tr')).toHaveTextContent(
      '300',
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('近况小结');
    await user.click(screen.getByRole('button', { name: '最近 7 天' }));
    expect(await screen.findByText('2026-10-26 至 2026-11-01')).toBeInTheDocument();
    expect(api.callsTo('GET', '/admin/ops-dashboard?days=7')).toHaveLength(1);
  });

  it('平台：各协会一行，带到期提醒和估算成本，可按协会筛选', async () => {
    window.location.hash = '#ops';
    const ops = [
      {
        operatorId: ids.operator,
        name: '合成协会',
        contractEnd: '2026-11-15',
        expiringSoon: true,
        expired: false,
        seatLimit: 20,
        metrics: { ...emptyMetrics(), llm_calls: 340 },
        costUsd: 12.5,
      },
      {
        operatorId: OP_B,
        name: '合成协会二',
        contractEnd: null,
        expiringSoon: false,
        expired: false,
        seatLimit: 5,
        metrics: emptyMetrics(),
        costUsd: 0,
      },
    ];
    const api = mockApi(USERS.platform_admin, {
      'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
      'GET /admin/ops-dashboard?days=30': () =>
        json(
          200,
          board({
            groups: [],
            seats: null,
            operators: ops,
            totals: { metrics: emptyMetrics(), costUsd: 12.5 },
          }),
        ),
      [`GET /admin/ops-dashboard?days=30&operatorId=${OP_B}`]: () =>
        json(200, board({ operators: null, totals: { metrics: emptyMetrics(), costUsd: 0 } })),
    });
    const user = userEvent.setup();
    render(<App />);
    const row = (await screen.findByRole('rowheader', { name: '合成协会' })).closest('tr')!;
    expect(row).toHaveTextContent('2026-11-15 （30 天内到期）');
    expect(row).toHaveTextContent('$12.50');
    expect(screen.getByTestId('ops-cards')).toHaveTextContent('估算成本$12.50');
    await user.selectOptions(screen.getByLabelText('协会'), OP_B);
    expect(await screen.findByRole('rowheader', { name: '合成一号机构' })).toBeInTheDocument();
    expect(api.callsTo('GET', `/admin/ops-dashboard?days=30&operatorId=${OP_B}`)).toHaveLength(1);
    expect(within(screen.getByLabelText('协会')).getAllByRole('option')).toHaveLength(3);
  });
});
