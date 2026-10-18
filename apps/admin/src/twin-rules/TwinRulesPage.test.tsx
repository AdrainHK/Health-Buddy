import type { CurrentUser, TwinStatusRuleRecord } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import {
  ids,
  json,
  makeThresholds,
  makeTwinRules,
  mockApi,
  NOW,
  USERS,
  type RecordedCall,
} from '../test/mockApi';

const NOTICE = '默认规则是通用的初步做法，不是医学标准，请由医学顾问审定。';

function renderAs(user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#twin-rules';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /twin-status-rules': () => json(200, makeTwinRules()),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

const rowsOf = async () => (await screen.findAllByRole('row')).slice(1);

const rowWith = async (...texts: string[]) => {
  const row = (await rowsOf()).find((r) => texts.every((x) => r.textContent?.includes(x)));
  if (!row) throw new Error(`row not found: ${texts.join(' ')}`);
  return row;
};

const sbpHigh = makeTwinRules().rules.find((r) => r.id === ids.ruleSbpHigh)!;

function patched(base: TwinStatusRuleRecord) {
  return ({ body }: RecordedCall) =>
    json(200, {
      rule: { ...base, ...(body as object), updatedBy: ids.platformAdmin, updatedAt: NOW },
    });
}

describe('孪生状态规则', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('列表显示方面、指标、来源、判断方式、阈值和单位、状态、启用、最后修改人；顶部有固定说明和版本号', async () => {
    renderAs(USERS.platform_admin);
    expect(await screen.findByRole('heading', { name: '孪生状态规则' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(NOTICE);
    expect(await screen.findByText('规则版本 3')).toBeInTheDocument();

    // 按方面（代谢、心血管…）、来源、指标、判断方式排列
    const rows = await rowsOf();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('代谢'),
      expect.stringContaining('命中危急阈值'),
      expect.stringContaining('平均值超出固定阈值'),
    ]);

    const critical = await rowWith('心血管', '命中危急阈值');
    expect(within(critical).getByRole('rowheader')).toHaveTextContent('收缩压');
    expect(critical).toHaveTextContent('监测');
    expect(critical).toHaveTextContent('最近 7 天');
    expect(within(critical).getByText('红')).toBeInTheDocument();
    expect(critical).toHaveTextContent('系统默认');

    const high = await rowWith('平均值超出固定阈值');
    expect(high).toHaveTextContent('> 135 mmHg');
    expect(within(high).getByText('黄')).toBeInTheDocument();
    expect(high).toHaveTextContent('平台管理员');

    const ref = await rowWith('超出报告参考范围');
    expect(ref).toHaveTextContent('空腹血糖');
    expect(ref).toHaveTextContent('报告');
    expect(ref).toHaveTextContent('已停用');
    expect(ref).toHaveTextContent('我');
  });

  it('平台管理员新增规则：指标只能从方面的目录里选，单位跟目录走，判断方式跟来源匹配', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      'POST /admin/twin-status-rules': ({ body }) =>
        json(201, {
          rule: {
            ...(body as object),
            id: ids.created,
            updatedBy: ids.platformAdmin,
            updatedAt: NOW,
          },
        }),
    });
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });

    await user.selectOptions(within(dialog).getByLabelText('方面'), 'sleep');
    const metric = within(dialog).getByLabelText('指标');
    expect(
      within(metric)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['睡眠时长']);
    // 报告来源没有“固定阈值”，监测来源没有“超出报告参考范围”
    const method = within(dialog).getByLabelText('判断方式');
    expect(
      within(method)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['命中危急阈值', '平均值超出固定阈值']);
    expect(within(dialog).getByText('小时')).toBeInTheDocument();
    expect(within(dialog).getByText('合理范围 0–24 小时')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('方向'), 'lt');
    await user.type(within(dialog).getByLabelText('阈值'), '5');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(api.callsTo('POST', '/admin/twin-status-rules')[0]?.body).toEqual({
      domain: 'sleep',
      metric: 'sleep_hours',
      source: 'monitoring',
      method: 'threshold',
      comparator: 'lt',
      value: 5,
      unit: 'h',
      windowDays: 7,
      level: 'yellow',
      enabled: true,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await rowWith('睡眠', '< 5 小时')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('后台按新规则重新计算');
    expect(screen.getByText('规则版本 4')).toBeInTheDocument();
  });

  it('选报告来源时：可选指标换成报告指标，判断方式里没有固定阈值，也没有阈值和时间窗口', async () => {
    const { user } = renderAs(USERS.platform_admin);
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.selectOptions(within(dialog).getByLabelText('方面'), 'metabolic');
    await user.selectOptions(within(dialog).getByLabelText('数据来源'), 'report');
    const method = within(dialog).getByLabelText('判断方式');
    expect(
      within(method)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['命中危急阈值', '超出报告参考范围']);
    expect(within(dialog).queryByLabelText('阈值')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('时间窗口（天）')).not.toBeInTheDocument();
  });

  it('平台管理员修改阈值和状态：方面、指标、来源、判断方式不能换', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      [`PATCH /admin/twin-status-rules/${ids.ruleSbpHigh}`]: patched(sbpHigh),
    });
    await user.click(
      await screen.findByRole('button', {
        name: '修改心血管·收缩压（监测，平均值超出固定阈值）',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: '修改规则' });
    for (const label of ['方面', '数据来源', '指标', '判断方式'])
      expect(within(dialog).getByLabelText(label)).toBeDisabled();
    const value = within(dialog).getByLabelText('阈值');
    await user.clear(value);
    await user.type(value, '140');
    await user.selectOptions(within(dialog).getByLabelText('得出的状态'), 'red');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(api.callsTo('PATCH', `/admin/twin-status-rules/${ids.ruleSbpHigh}`)[0]?.body).toEqual({
      comparator: 'gt',
      value: 140,
      windowDays: 7,
      level: 'red',
      enabled: true,
    });
    const row = await rowWith('> 140 mmHg');
    expect(within(row).getByText('红')).toBeInTheDocument();
  });

  it('平台管理员可以停用规则', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      [`PATCH /admin/twin-status-rules/${ids.ruleSbpHigh}`]: patched(sbpHigh),
    });
    await user.click(
      await screen.findByRole('button', {
        name: '停用心血管·收缩压（监测，平均值超出固定阈值）',
      }),
    );
    expect(api.callsTo('PATCH', `/admin/twin-status-rules/${ids.ruleSbpHigh}`)[0]?.body).toEqual({
      enabled: false,
    });
    expect(await rowWith('> 135 mmHg', '已停用')).toBeInTheDocument();
  });

  it('阈值超出合理范围（400）时提示范围；重复（409）时提示修改已有规则', async () => {
    let status = 400;
    const { user } = renderAs(USERS.platform_admin, {
      'POST /admin/twin-status-rules': () =>
        json(status, { error: status === 400 ? 'bad_request' : 'conflict' }),
    });
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.type(within(dialog).getByLabelText('阈值'), '1000');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '阈值超出该指标的合理范围（50–300 mmHg）',
    );

    status = 409;
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText(/已有一条相同的规则/)).toBeInTheDocument();
  });

  it('没填数字或时间窗口不对时不发请求', async () => {
    const { api, user } = renderAs(USERS.platform_admin);
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写数字阈值');
    await user.type(within(dialog).getByLabelText('阈值'), '140');
    const windowDays = within(dialog).getByLabelText('时间窗口（天）');
    await user.clear(windowDays);
    await user.type(windowDays, '120');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('时间窗口请填写 1–90 的整数');
    expect(api.writes()).toHaveLength(0);
  });

  it('恢复为默认值需要二次确认，取消时不发请求', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      'POST /admin/twin-status-rules/reset': () =>
        json(200, { ...makeTwinRules(), version: 4, rules: [sbpHigh] }),
    });
    await user.click(await screen.findByRole('button', { name: '恢复为默认值' }));
    let dialog = screen.getByRole('dialog', { name: '恢复为默认值？' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(api.writes()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '恢复为默认值' }));
    dialog = screen.getByRole('dialog', { name: '恢复为默认值？' });
    await user.click(within(dialog).getByRole('button', { name: '确定恢复' }));
    expect(api.callsTo('POST', '/admin/twin-status-rules/reset')).toHaveLength(1);
    expect(await screen.findByText(/已恢复为默认值/)).toBeInTheDocument();
    expect(screen.getByText('规则版本 4')).toBeInTheDocument();
    expect(await rowsOf()).toHaveLength(1);
  });

  it.each([
    ['协会管理员', USERS.operator_admin],
    ['机构管理员', USERS.org_admin],
  ])('%s只能查看，没有任何修改入口', async (_label, account) => {
    const { api } = renderAs(account);
    expect(await screen.findByRole('note')).toHaveTextContent(NOTICE);
    await rowWith('命中危急阈值');
    expect(screen.getByText(/你可以查看，不能修改/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增规则' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '恢复为默认值' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(修改|停用|启用)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '操作' })).not.toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);
  });

  it('加载失败时可以重试', async () => {
    let fail = true;
    const { user } = renderAs(USERS.operator_admin, {
      'GET /twin-status-rules': () =>
        fail ? json(500, { error: 'internal_error' }) : json(200, makeTwinRules()),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('规则加载失败');
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await rowWith('命中危急阈值');
  });
});
