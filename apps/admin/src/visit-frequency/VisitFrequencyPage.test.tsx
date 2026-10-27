import {
  DEFAULT_VISIT_FREQUENCY_RULES,
  type CurrentUser,
  type VisitFrequencyRuleEvent,
} from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, NOW, USERS } from '../test/mockApi';

const rulesResponse = (version = 1, rules = DEFAULT_VISIT_FREQUENCY_RULES) => ({
  version,
  updatedAt: NOW,
  rules,
});

const events: VisitFrequencyRuleEvent[] = [
  {
    id: '1',
    target: 'high',
    actorName: '合成平台管理员',
    rulesVersion: 2,
    before: { intervalDays: 14, defaultMethod: 'phone' },
    after: { intervalDays: 10, defaultMethod: 'in_person' },
    createdAt: NOW,
  },
];

function renderAs(user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#visit-frequency';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /visit-frequency-rules': () => json(200, rulesResponse()),
    'GET /admin/visit-frequency-rules/events': () => json(200, { events }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('随访频次规则', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('列出四个风险分层的间隔和默认方式、首次随访规则；顶部有固定说明和版本号', async () => {
    renderAs(USERS.platform_admin);
    expect(await screen.findByRole('heading', { name: '随访频次规则' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      '默认频次是通用的初步做法，请由医学顾问审定。',
    );
    expect(await screen.findByText('规则版本 1')).toBeInTheDocument();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      '高每 14 天电话',
      '中每 30 天电话',
      '低每 90 天微信',
      '未分层每 30 天电话',
    ]);
    expect(
      screen.getByText('有 1、2 级未处理跟进项时，第一次随访不晚于 3 天后'),
    ).toBeInTheDocument();
    expect(await screen.findByText('高：每 14 天 · 电话 → 每 10 天 · 面谈')).toBeInTheDocument();
  });

  it('平台管理员整套修改：超出范围在提交前拦下；保存后版本号更新并刷新修改记录', async () => {
    const changed = {
      ...DEFAULT_VISIT_FREQUENCY_RULES,
      tiers: {
        ...DEFAULT_VISIT_FREQUENCY_RULES.tiers,
        high: { intervalDays: 10, defaultMethod: 'in_person' as const },
      },
    };
    const { api, user } = renderAs(USERS.platform_admin, {
      'PATCH /admin/visit-frequency-rules': () => json(200, rulesResponse(2, changed)),
    });
    await user.click(await screen.findByRole('button', { name: '修改规则' }));
    const dialog = await screen.findByRole('dialog', { name: '修改随访频次规则' });
    const high = within(dialog).getByLabelText('高：间隔天数');
    await user.clear(high);
    await user.type(high, '5');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写范围内的整数');
    expect(api.writes()).toEqual([]);

    await user.clear(high);
    await user.type(high, '10');
    await user.selectOptions(within(dialog).getByLabelText('高：默认方式'), '面谈');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await screen.findByText('规则版本 2')).toBeInTheDocument();
    expect(api.callsTo('PATCH', '/admin/visit-frequency-rules')[0]?.body).toEqual(changed);
    expect(api.callsTo('GET', '/admin/visit-frequency-rules/events')).toHaveLength(2);
  });

  it.each([
    ['协会管理员', USERS.operator_admin],
    ['机构管理员', USERS.org_admin],
  ])('%s只读：没有修改按钮，不请求修改记录', async (_l, account) => {
    const { api } = renderAs(account);
    expect(await screen.findByText('规则版本 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '修改规则' })).not.toBeInTheDocument();
    expect(api.callsTo('GET', '/admin/visit-frequency-rules/events')).toEqual([]);
  });
});
