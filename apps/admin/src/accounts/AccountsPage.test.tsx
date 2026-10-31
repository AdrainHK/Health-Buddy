import type {
  CurrentUser,
  OperatorAccount,
  OperatorSummary,
  OrganizationSummary,
} from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { ids, json, makeThresholds, mockApi, USERS } from '../test/mockApi';

const TOKEN = 'B'.repeat(43);
const M1 = '44444444-4444-4444-8444-444444444441';
const M2 = '44444444-4444-4444-8444-444444444442';

const OPERATOR: OperatorSummary = {
  id: ids.operator,
  name: '合成协会',
  slug: 'assoc',
  region: [],
  status: 'active',
  suspendedReason: null,
  seatLimit: 10,
  seatsUsed: 2,
  contractStart: null,
  contractEnd: null,
  expiringSoon: false,
  expired: false,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const ORG: OrganizationSummary = {
  id: ids.org,
  name: '合成一号机构',
  managerCount: 2,
  clientCount: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function account(over: Partial<OperatorAccount>): OperatorAccount {
  return {
    id: M1,
    displayName: '合成健管师甲',
    email: 'm1@test.example',
    role: 'manager',
    status: 'active',
    orgId: ids.org,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastLoginAt: '2026-10-30T02:00:00.000Z',
    clientCount: 3,
    ...over,
  };
}

const ACCOUNTS = [
  account({}),
  account({ id: M2, displayName: '合成健管师乙', email: 'm2@test.example', clientCount: 0 }),
];

function renderPage(
  routes: Parameters<typeof mockApi>[1] = {},
  user: CurrentUser = USERS.operator_admin,
) {
  window.location.hash = '#accounts';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/my-operator': () => json(200, { operator: OPERATOR }),
    'GET /admin/organizations': () => json(200, { organizations: [ORG] }),
    'GET /admin/accounts': () => json(200, { accounts: ACCOUNTS }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('协会账号页（M7 规格 2.4）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('页头显示席位；名下有客户的健管师不能停用、不能重发邀请，没有客户的可以', async () => {
    renderPage();
    expect(await screen.findByTestId('seats')).toHaveTextContent('已用 2 / 10');
    const busy = screen.getByRole('rowheader', { name: '合成健管师甲' }).closest('tr')!;
    expect(within(busy).getByRole('button', { name: '给合成健管师甲重发邀请' })).toBeDisabled();
    expect(within(busy).getByRole('button', { name: '停用合成健管师甲' })).toBeDisabled();
    expect(busy).toHaveTextContent('能看到 3 位客户');
    expect(busy).toHaveTextContent('合成一号机构');
    const free = screen.getByRole('rowheader', { name: '合成健管师乙' }).closest('tr')!;
    expect(within(free).getByRole('button', { name: '给合成健管师乙重发邀请' })).toBeEnabled();
    expect(within(free).getByRole('button', { name: '停用合成健管师乙' })).toBeEnabled();
  });

  it('单个开通：机构管理员必须选机构；席位用完时提示联系平台；成功后显示邀请链接', async () => {
    let full = true;
    const { api, user } = renderPage({
      'POST /admin/accounts': () =>
        full
          ? json(409, { error: 'seat_limit_reached', seatsLeft: 0, needed: 1 })
          : json(201, {
              account: account({ id: M2, status: 'pending', clientCount: 0 }),
              invitePath: `/#/invite/${TOKEN}`,
              expiresAt: '2026-11-03T00:00:00.000Z',
            }),
    });
    await user.click(await screen.findByRole('button', { name: '开通账号' }));
    const dialog = screen.getByRole('dialog', { name: '开通账号' });
    await user.type(within(dialog).getByLabelText('姓名'), '合成新人');
    await user.type(within(dialog).getByLabelText('邮箱'), 'new@test.example');
    await user.selectOptions(within(dialog).getByLabelText('角色'), 'org_admin');
    await user.click(within(dialog).getByRole('button', { name: '生成邀请链接' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('机构管理员必须选择机构');
    expect(api.callsTo('POST', '/admin/accounts')).toHaveLength(0);

    await user.selectOptions(within(dialog).getByLabelText('角色'), 'manager');
    await user.click(within(dialog).getByRole('button', { name: '生成邀请链接' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('席位已用完');
    full = false;
    await user.selectOptions(within(dialog).getByLabelText('所属机构'), ids.org);
    await user.click(within(dialog).getByRole('button', { name: '生成邀请链接' }));
    expect(api.callsTo('POST', '/admin/accounts')[1]?.body).toEqual({
      displayName: '合成新人',
      email: 'new@test.example',
      role: 'manager',
      orgId: ids.org,
    });
    const link = await screen.findByTestId('invite-link');
    expect(within(link).getByRole('textbox')).toHaveValue(
      `${window.location.origin}/#/invite/${TOKEN}`,
    );
  });

  it('批量导入：逐行显示错误和席位不足；改正后列出每人的链接', async () => {
    let reject = true;
    const { api, user } = renderPage({
      'POST /admin/accounts/import': () =>
        reject
          ? json(400, {
              error: 'bad_request',
              rowErrors: [
                { row: 3, code: 'email_taken' },
                { row: 4, code: 'org_not_found' },
              ],
              seatsLeft: 1,
              needed: 3,
            })
          : json(201, {
              invites: [
                {
                  row: 2,
                  account: account({ id: M2, displayName: '合成导入甲', status: 'pending' }),
                  invitePath: `/#/invite/${TOKEN}`,
                  expiresAt: '2026-11-03T00:00:00.000Z',
                },
              ],
            }),
    });
    await user.click(await screen.findByRole('button', { name: '批量导入' }));
    const dialog = screen.getByRole('dialog', { name: '批量导入' });
    const csv =
      '姓名,邮箱,角色,机构名称\n合成导入甲,a@test.example,健管师,\n合成导入乙,b@test.example,健管师,\n合成导入丙,c@test.example,健管师,不存在的机构\n';
    await user.upload(
      within(dialog).getByLabelText('CSV 文件'),
      new File([csv], 'accounts.csv', { type: 'text/csv' }),
    );
    await user.click(within(dialog).getByRole('button', { name: '上传并导入' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('需要 3 个席位，只剩 1 个');
    expect(alert).toHaveTextContent('第 3 行：该邮箱不可用');
    expect(alert).toHaveTextContent('第 4 行：本协会没有这个机构');
    expect(api.callsTo('POST', '/admin/accounts/import')[0]?.body).toEqual({
      rows: [
        {
          row: 2,
          displayName: '合成导入甲',
          email: 'a@test.example',
          role: 'manager',
          orgName: '',
        },
        {
          row: 3,
          displayName: '合成导入乙',
          email: 'b@test.example',
          role: 'manager',
          orgName: '',
        },
        {
          row: 4,
          displayName: '合成导入丙',
          email: 'c@test.example',
          role: 'manager',
          orgName: '不存在的机构',
        },
      ],
    });
    reject = false;
    await user.click(within(dialog).getByRole('button', { name: '上传并导入' }));
    const links = await within(dialog).findByTestId('import-links');
    expect(within(links).getByRole('textbox', { name: '合成导入甲 的邀请链接' })).toHaveValue(
      `${window.location.origin}/#/invite/${TOKEN}`,
    );
  });

  it('表头不对的文件不上传', async () => {
    const { api, user } = renderPage();
    await user.click(await screen.findByRole('button', { name: '批量导入' }));
    const dialog = screen.getByRole('dialog', { name: '批量导入' });
    await user.upload(
      within(dialog).getByLabelText('CSV 文件'),
      new File(['name,email\nx,y\n'], 'x.csv', { type: 'text/csv' }),
    );
    await user.click(within(dialog).getByRole('button', { name: '上传并导入' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('表头和模板不一致');
    expect(api.callsTo('POST', '/admin/accounts/import')).toHaveLength(0);
  });

  it('机构管理员只读：没有开通、导入和操作按钮，不请求协会和机构接口', async () => {
    const { api } = renderPage({}, USERS.org_admin);
    expect(await screen.findByRole('rowheader', { name: '合成健管师甲' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('只能查看');
    expect(screen.queryByRole('button', { name: '开通账号' })).toBeNull();
    expect(screen.queryByRole('button', { name: '批量导入' })).toBeNull();
    expect(screen.queryByRole('button', { name: /停用/ })).toBeNull();
    expect(api.callsTo('GET', '/admin/organizations')).toHaveLength(0);
    expect(api.callsTo('GET', '/admin/my-operator')).toHaveLength(0);
  });
});
