import type { CriticalThreshold, CurrentUser } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { ids, json, makeThresholds, mockApi, NOW, USERS, type RecordedCall } from '../test/mockApi';

const DISCLAIMER = '默认值参照国际通用标准，仅供参考，请由医学顾问审定。';

function renderAs(user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

const rowOf = async (metric: string, direction: string) => {
  await screen.findByRole('table');
  const row = screen
    .getAllByRole('row')
    .find(
      (r) =>
        within(r).queryByRole('rowheader', { name: metric }) && within(r).queryByText(direction),
    );
  if (!row) throw new Error(`row not found: ${metric} ${direction}`);
  return row;
};

/** 把请求体当成修改内容，返回修改后的规则 */
function patched(base: CriticalThreshold) {
  return ({ body }: RecordedCall) =>
    json(200, {
      threshold: {
        ...base,
        ...(body as object),
        updatedBy: ids.platformAdmin,
        updatedAt: NOW,
      },
    });
}

const sbpHigh = makeThresholds().find((x) => x.id === ids.sbpHigh)!;

describe('危急指标设置', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('列表显示指标、方向、阈值、单位、级别、启用状态、最后修改人，顶部有固定说明', async () => {
    renderAs(USERS.platform_admin);
    expect(await screen.findByRole('note')).toHaveTextContent(DISCLAIMER);

    const rows = (await screen.findAllByRole('row')).slice(1);
    // 按指标目录顺序：收缩压、空腹血糖、血尿酸
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      '收缩压',
      '空腹血糖',
      '血尿酸',
    ]);

    const sbp = await rowOf('收缩压', '高于或等于');
    expect(sbp).toHaveTextContent('≥ 180');
    expect(sbp).toHaveTextContent('mmHg');
    expect(within(sbp).getByText('需尽快就医')).toBeInTheDocument();
    expect(sbp).toHaveTextContent('启用');
    expect(sbp).toHaveTextContent('平台管理员');

    const fpg = await rowOf('空腹血糖', '低于');
    expect(fpg).toHaveTextContent('< 3');
    expect(fpg).toHaveTextContent('已停用');
    expect(fpg).toHaveTextContent('我');

    const uric = await rowOf('血尿酸', '高于或等于');
    expect(uric).toHaveTextContent('μmol/L');
    expect(within(uric).getByText('建议就医评估')).toBeInTheDocument();
    expect(uric).toHaveTextContent('系统默认');
  });

  it('平台管理员可以新增规则，指标从目录选，单位跟目录走', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      'POST /critical-thresholds': ({ body }) =>
        json(200, {
          threshold: {
            ...(body as object),
            id: ids.created,
            updatedBy: ids.platformAdmin,
            updatedAt: NOW,
          },
        }),
    });

    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.selectOptions(within(dialog).getByLabelText('指标'), 'heart_rate');
    expect(within(dialog).getByText('次/分')).toBeInTheDocument();
    expect(within(dialog).getByText('合理范围 20–250 次/分')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('方向'), 'gt');
    await user.type(within(dialog).getByLabelText('阈值'), '130');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(api.callsTo('POST', '/critical-thresholds')[0]?.body).toEqual({
      metric: 'heart_rate',
      comparator: 'gt',
      value: 130,
      level: 'urgent',
      enabled: true,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const row = await rowOf('静息心率', '高于');
    expect(row).toHaveTextContent('> 130');
    expect(screen.getByRole('status')).toHaveTextContent('已保存');
  });

  it('平台管理员可以修改阈值和级别，修改时不能换指标', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      [`PATCH /critical-thresholds/${ids.sbpHigh}`]: patched(sbpHigh),
    });

    await user.click(await screen.findByRole('button', { name: '修改收缩压（高于或等于）' }));
    const dialog = screen.getByRole('dialog', { name: '修改规则' });
    expect(within(dialog).getByLabelText('指标')).toBeDisabled();
    const value = within(dialog).getByLabelText('阈值');
    await user.clear(value);
    await user.type(value, '185');
    await user.selectOptions(within(dialog).getByLabelText('级别'), 'attention');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(api.callsTo('PATCH', `/critical-thresholds/${ids.sbpHigh}`)[0]?.body).toEqual({
      comparator: 'gte',
      value: 185,
      level: 'attention',
      enabled: true,
    });
    const row = await rowOf('收缩压', '高于或等于');
    expect(row).toHaveTextContent('≥ 185');
    expect(within(row).getByText('建议就医评估')).toBeInTheDocument();
  });

  it('平台管理员可以停用规则', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      [`PATCH /critical-thresholds/${ids.sbpHigh}`]: patched(sbpHigh),
    });
    await user.click(await screen.findByRole('button', { name: '停用收缩压（高于或等于）' }));
    expect(api.callsTo('PATCH', `/critical-thresholds/${ids.sbpHigh}`)[0]?.body).toEqual({
      enabled: false,
    });
    const row = await rowOf('收缩压', '高于或等于');
    expect(row).toHaveTextContent('已停用');
    expect(
      within(row).getByRole('button', { name: '启用收缩压（高于或等于）' }),
    ).toBeInTheDocument();
  });

  it('阈值超出合理范围（400）时提示范围，弹窗保留', async () => {
    const { user } = renderAs(USERS.platform_admin, {
      'POST /critical-thresholds': () => json(400, { error: 'bad_request' }),
    });
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.type(within(dialog).getByLabelText('阈值'), '1000');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '阈值超出该指标的合理范围（50–300 mmHg）',
    );
    expect(screen.getByRole('dialog', { name: '新增规则' })).toBeInTheDocument();
  });

  it('同一指标同一方向重复（409）时提示修改已有规则', async () => {
    const { user } = renderAs(USERS.platform_admin, {
      'POST /critical-thresholds': () => json(409, { error: 'conflict' }),
    });
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.type(within(dialog).getByLabelText('阈值'), '200');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '这个指标在这个方向上已有规则',
    );
  });

  it('没填数字时不发请求', async () => {
    const { api, user } = renderAs(USERS.platform_admin);
    await user.click(await screen.findByRole('button', { name: '新增规则' }));
    const dialog = screen.getByRole('dialog', { name: '新增规则' });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写数字阈值');
    expect(api.writes()).toHaveLength(0);
  });

  it('恢复为默认值需要二次确认，取消时不发请求', async () => {
    const defaults: CriticalThreshold[] = [{ ...sbpHigh, updatedBy: ids.platformAdmin }];
    const { api, user } = renderAs(USERS.platform_admin, {
      'POST /critical-thresholds/reset': () => json(200, { thresholds: defaults }),
    });

    await user.click(await screen.findByRole('button', { name: '恢复为默认值' }));
    let dialog = screen.getByRole('dialog', { name: '恢复为默认值？' });
    expect(api.writes()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '恢复为默认值' }));
    dialog = screen.getByRole('dialog', { name: '恢复为默认值？' });
    await user.click(within(dialog).getByRole('button', { name: '确定恢复' }));
    expect(api.callsTo('POST', '/critical-thresholds/reset')).toHaveLength(1);
    expect(await screen.findByText('已恢复为默认值')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it.each([
    ['协会管理员', USERS.operator_admin],
    ['机构管理员', USERS.org_admin],
  ])('%s只能查看，没有任何修改入口', async (_label, account) => {
    const { api } = renderAs(account);
    expect(await screen.findByRole('note')).toHaveTextContent(DISCLAIMER);
    await rowOf('收缩压', '高于或等于');
    expect(screen.getByText(/你可以查看，不能修改/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增规则' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '恢复为默认值' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^修改/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(停用|启用)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '操作' })).not.toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);
  });

  it('加载失败时可以重试', async () => {
    let fail = true;
    const { user } = renderAs(USERS.operator_admin, {
      'GET /critical-thresholds': () =>
        fail ? json(500, { error: 'internal_error' }) : json(200, { thresholds: makeThresholds() }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('阈值加载失败');
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await rowOf('收缩压', '高于或等于');
  });
});
