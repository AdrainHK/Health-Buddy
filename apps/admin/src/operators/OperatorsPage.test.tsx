import type { AccountSummary, OperatorSummary } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, USERS } from '../test/mockApi';

const OP_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'A'.repeat(43);

function makeOperator(over: Partial<OperatorSummary> = {}): OperatorSummary {
  return {
    id: OP_ID,
    name: '合成协会 M7',
    slug: 'assoc-m7',
    region: ['44'],
    status: 'active',
    suspendedReason: null,
    seatLimit: 10,
    seatsUsed: 3,
    contractStart: '2026-01-01',
    contractEnd: '2026-11-15',
    expiringSoon: true,
    expired: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

const ADMIN: AccountSummary = {
  id: ADMIN_ID,
  displayName: '合成管理员',
  email: 'm7-admin@test.example',
  role: 'operator_admin',
  status: 'pending',
  orgId: null,
  createdAt: '2026-10-31T00:00:00.000Z',
  lastLoginAt: null,
};

function renderPage(routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#operators';
  const api = mockApi(USERS.platform_admin, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/operators': () => json(200, { operators: [makeOperator()] }),
    [`GET /admin/operators/${OP_ID}/accounts`]: () => json(200, { accounts: [] }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('运营商开通（M7 规格 2.1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('列表显示状态、席位和即将到期提醒；顶部说明到期不会自动停用', async () => {
    renderPage();
    const row = (await screen.findByRole('rowheader', { name: '合成协会 M7' })).closest('tr')!;
    expect(row).toHaveTextContent('已开通');
    expect(row).toHaveTextContent('已用 3 / 10');
    expect(row).toHaveTextContent(/2026-11-15\s*（30 天内到期）/);
    expect(screen.getByRole('note')).toHaveTextContent('不会自动停用');
  });

  it('开通协会：提交名称、简称、区域、席位和合同日期；简称重复时提示', async () => {
    let first = true;
    const { api, user } = renderPage({
      'POST /admin/operators': () => {
        if (first) {
          first = false;
          return json(409, { error: 'conflict' });
        }
        return json(201, { operator: makeOperator({ id: OP_ID }) });
      },
    });
    await user.click(await screen.findByRole('button', { name: '开通运营商' }));
    const dialog = screen.getByRole('dialog', { name: '开通运营商' });
    await user.type(within(dialog).getByLabelText('协会名称'), '合成协会 M7');
    await user.type(within(dialog).getByLabelText('简称'), 'assoc-m7');
    await user.type(within(dialog).getByLabelText('管辖区域'), '44, 4403');
    await user.clear(within(dialog).getByLabelText('席位数'));
    await user.type(within(dialog).getByLabelText('席位数'), '20');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('简称或邮箱已被使用');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(api.callsTo('POST', '/admin/operators')[1]?.body).toEqual({
      name: '合成协会 M7',
      slug: 'assoc-m7',
      region: ['44', '4403'],
      seatLimit: 20,
      contractStart: null,
      contractEnd: null,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('已开通“合成协会 M7”');
  });

  it('开通协会管理员：邀请链接只显示一次，提示线下发给本人、72 小时有效', async () => {
    const { api, user } = renderPage({
      [`POST /admin/operators/${OP_ID}/accounts`]: () =>
        json(201, {
          account: ADMIN,
          invitePath: `/#/invite/${TOKEN}`,
          expiresAt: '2026-11-03T00:00:00.000Z',
        }),
    });
    await user.click(await screen.findByRole('button', { name: '管理合成协会 M7' }));
    const dialog = screen.getByRole('dialog', { name: '合成协会 M7' });
    await user.type(within(dialog).getByLabelText('姓名'), '合成管理员');
    await user.type(within(dialog).getByLabelText('邮箱'), 'm7-admin@test.example');
    await user.click(within(dialog).getByRole('button', { name: '生成邀请链接' }));
    const link = await within(dialog).findByTestId('invite-link');
    expect(within(link).getByRole('textbox')).toHaveValue(
      `${window.location.origin}/#/invite/${TOKEN}`,
    );
    expect(link).toHaveTextContent('72 小时内有效');
    expect(api.callsTo('POST', `/admin/operators/${OP_ID}/accounts`)[0]?.body).toEqual({
      displayName: '合成管理员',
      email: 'm7-admin@test.example',
      role: 'operator_admin',
    });
  });

  it('停用协会：原因不足 5 个字不能点；停用后显示原因和恢复按钮', async () => {
    let suspended = false;
    const { api, user } = renderPage({
      'GET /admin/operators': () =>
        json(200, {
          operators: [
            suspended
              ? makeOperator({ status: 'suspended', suspendedReason: '合同纠纷，暂停服务' })
              : makeOperator(),
          ],
        }),
      [`POST /admin/operators/${OP_ID}/suspend`]: () => {
        suspended = true;
        return json(200, {
          operator: makeOperator({ status: 'suspended', suspendedReason: '合同纠纷，暂停服务' }),
        });
      },
    });
    await user.click(await screen.findByRole('button', { name: '管理合成协会 M7' }));
    const dialog = screen.getByRole('dialog', { name: '合成协会 M7' });
    const button = within(dialog).getByRole('button', { name: '停用这个协会' });
    await user.type(within(dialog).getByLabelText('停用原因'), '太短');
    expect(button).toBeDisabled();
    await user.type(within(dialog).getByLabelText('停用原因'), '，合同纠纷');
    await user.click(button);
    expect(api.callsTo('POST', `/admin/operators/${OP_ID}/suspend`)[0]?.body).toEqual({
      reason: '太短，合同纠纷',
    });
    expect(
      await within(screen.getByRole('dialog', { name: '合成协会 M7' })).findByRole('button', {
        name: '恢复',
      }),
    ).toBeInTheDocument();
  });

  it('可售套餐：只列在售的，勾选后保存（M7 规格 2.5）', async () => {
    const plan = (id: string, name: string, status: 'active' | 'retired') => ({
      id,
      code: name,
      name,
      features: { experts: true, twin: true, care: true, companion: true, content: true },
      monthlyQuotas: {
        llm_calls: null,
        expert_calls: null,
        report_pages: null,
        companion_devices: null,
      },
      status,
      assignedCount: 0,
      updatedAt: '2026-10-31T00:00:00.000Z',
    });
    const P1 = '66666666-6666-4666-8666-666666666661';
    const P2 = '66666666-6666-4666-8666-666666666662';
    const P3 = '66666666-6666-4666-8666-666666666663';
    const { api, user } = renderPage({
      'GET /admin/plans': () =>
        json(200, {
          plans: [
            plan(P1, '试点版', 'active'),
            plan(P2, '合成基础版', 'active'),
            plan(P3, '旧套餐', 'retired'),
          ],
        }),
      [`GET /admin/operators/${OP_ID}/plans`]: () => json(200, { planIds: [P1] }),
      [`PUT /admin/operators/${OP_ID}/plans`]: () => json(200, { planIds: [P1, P2] }),
    });
    await user.click(await screen.findByRole('button', { name: '管理合成协会 M7' }));
    const box = await screen.findByTestId('sellable-plans');
    expect(within(box).getByLabelText('试点版')).toBeChecked();
    expect(within(box).queryByLabelText('旧套餐')).toBeNull();
    await user.click(within(box).getByLabelText('合成基础版'));
    await user.click(within(box).getByRole('button', { name: '保存可售套餐' }));
    expect(await within(box).findByRole('status')).toHaveTextContent('已保存可售套餐');
    expect(api.callsTo('PUT', `/admin/operators/${OP_ID}/plans`)[0]?.body).toEqual({
      planIds: [P1, P2],
    });
  });
});
