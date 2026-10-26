import type { ClientRecord as RecordData, RiskTierRecord } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CLIENTS,
  NOW,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeArtifactSummary,
  makeTask,
  mockApi,
  setWideViewport,
} from '../test/mockApi';
import { AppShell } from '../shell/AppShell';
import { ClientRecord } from './ClientRecord';

/** 合成档案。全部是虚构数据 */
const REPORT_ID = '90000000-0000-4000-8000-000000000001';
const HISTORY_ID = '90000000-0000-4000-8000-000000000002';
const TIER_ID = '90000000-0000-4000-8000-000000000003';
const NEW_CLIENT_ID = '20000000-0000-4000-8000-00000000000c';

const TIER: RiskTierRecord = {
  id: TIER_ID,
  tier: 'medium',
  reason: '合成理由：血脂偏高',
  setBy: ids.manager,
  setByName: '合成健管师',
  setAt: NOW,
  source: 'manual',
  sourceArtifactId: null,
};

function makeRecord(overrides: Partial<RecordData> = {}): RecordData {
  return {
    client: CLIENTS[0]!,
    riskTier: TIER,
    healthHistory: [
      {
        id: HISTORY_ID,
        category: 'allergy',
        content: '合成记录：青霉素过敏',
        recordedOn: '2020-05-01',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    reports: [
      {
        id: REPORT_ID,
        reportDate: '2026-09-12',
        source: 'synthetic',
        institution: null,
        indicatorCount: 2,
        abnormalCount: 0,
      },
    ],
    indicators: [
      {
        code: 'fpg',
        points: [
          {
            reportId: REPORT_ID,
            reportDate: '2026-09-12',
            source: 'synthetic',
            value: 5.6,
            unit: 'mmol/L',
            originalValue: null,
            originalUnit: null,
            refText: null,
            abnormal: 'no_reference',
          },
        ],
      },
    ],
    monitoring: [
      {
        metric: 'sbp',
        unit: 'mmHg',
        count: 12,
        latest: { value: 128, measuredAt: NOW, source: 'synthetic' },
      },
    ],
    artifacts: [makeArtifactSummary({ status: 'approved' })],
    readOnly: false,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

type Routes = Parameters<typeof mockApi>[0];

function renderRecord(record = makeRecord(), routes: Routes = {}) {
  const api = mockApi({
    [`GET /clients/${ids.clientA}/record`]: () => json(200, { record }),
    ...routes,
  });
  const onClientSaved = vi.fn();
  render(<ClientRecord client={CLIENTS[0]!} onClientSaved={onClientSaved} />);
  return { api, onClientSaved };
}

const section = (name: string) => screen.getByRole('region', { name });

describe('ClientRecord', () => {
  it('shows every block of the record with source and date next to each value', async () => {
    renderRecord();
    expect(screen.getByRole('heading', { name: /合成客户甲/ })).toBeInTheDocument();
    expect(await screen.findByText('合成记录：青霉素过敏')).toBeInTheDocument();

    expect(within(section('基本信息')).getByText('女')).toBeInTheDocument();
    const tier = section('风险分层');
    expect(within(tier).getByText('中')).toBeInTheDocument();
    expect(within(tier).getByText(/合成健管师 · \d{4}-\d{2}-\d{2} 设定/)).toBeInTheDocument();
    expect(within(tier).getByText('理由：合成理由：血脂偏高')).toBeInTheDocument();

    const history = section('健康史');
    for (const category of ['既往病史', '家族史', '正在使用的药物', '过敏史', '生活习惯']) {
      expect(within(history).getByRole('heading', { name: category })).toBeInTheDocument();
    }
    expect(within(history).getByText(/记录日期 2020-05-01 · 健管师录入/)).toBeInTheDocument();

    const reports = section('体检报告');
    expect(within(reports).getByText('报告 · 2026-09-12')).toBeInTheDocument();
    expect(within(reports).getByText('2 项指标 · 测试数据')).toBeInTheDocument();

    const indicators = section('指标趋势');
    expect(within(indicators).getByRole('heading', { name: '空腹血糖' })).toBeInTheDocument();
    expect(within(indicators).getByText('5.6 mmol/L')).toBeInTheDocument();
    expect(within(indicators).getByText('2026-09-12 · 测试数据')).toBeInTheDocument();

    const monitoring = section('日常监测');
    expect(within(monitoring).getByText('最新 128 mmHg')).toBeInTheDocument();
    expect(within(monitoring).getByText(/· 测试数据 · 近 30 天 12 条/)).toBeInTheDocument();

    expect(within(section('产物')).getByText('已审核')).toBeInTheDocument();
    // 和产物标签同一个命名规则：称呼 + 内容概括 + 日期 + 第几版
    expect(
      within(section('产物')).getByText('合成客户甲 近况小结 2026-10-15 第1版'),
    ).toBeInTheDocument();
  });

  it('has no “新建客户” button once a client is selected (owner feedback)', async () => {
    renderRecord();
    expect(await screen.findByText('合成记录：青霉素过敏')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建客户' })).not.toBeInTheDocument();
  });

  it('marks reports whose current values hit a critical threshold', async () => {
    const base = makeRecord();
    renderRecord(makeRecord({ reports: base.reports.map((r) => ({ ...r, hasCritical: true })) }));
    expect(
      await within(await screen.findByRole('region', { name: '体检报告' })).findByText(
        '含危急指标',
      ),
    ).toBeVisible();
  });

  it('shows empty states when nothing has been recorded yet', async () => {
    renderRecord(
      makeRecord({
        riskTier: null,
        healthHistory: [],
        reports: [],
        indicators: [],
        monitoring: [],
        artifacts: [],
      }),
    );
    expect(await screen.findByText('还没有已核对的报告')).toBeInTheDocument();
    expect(within(section('风险分层')).getByText('未分层')).toBeInTheDocument();
    expect(within(section('健康史')).getAllByText('暂无记录')).toHaveLength(5);
    expect(screen.getByText('最近 30 天没有监测数据')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设定分层' })).toBeInTheDocument();
  });

  it('read-only records (org admins) have no edit entry points and no artifacts', async () => {
    renderRecord(makeRecord({ readOnly: true, artifacts: [] }));
    expect(await screen.findByText('合成记录：青霉素过敏')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑基本信息' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '调整分层' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^添加/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '产物' })).not.toBeInTheDocument();
  });

  it('edits the basic info and reports the saved client', async () => {
    const user = userEvent.setup();
    const saved = { ...CLIENTS[0]!, displayName: '合成客户甲改', birthYear: 1961 };
    const { api, onClientSaved } = renderRecord(makeRecord(), {
      [`PATCH /clients/${ids.clientA}`]: () => json(200, { client: saved }),
    });
    await user.click(await screen.findByRole('button', { name: '编辑基本信息' }));
    const name = screen.getByRole('textbox', { name: '称呼（必填）' });
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('请填写称呼')).toBeInTheDocument();

    await user.type(name, '合成客户甲改');
    const year = screen.getByRole('textbox', { name: '出生年份' });
    await user.clear(year);
    await user.type(year, '1800');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText(/1900 年到今年之间/)).toBeInTheDocument();

    await user.clear(year);
    await user.type(year, '1961');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClientSaved).toHaveBeenCalledWith(saved));
    const patch = api.calls.find((c) => c.method === 'PATCH');
    expect(patch).toMatchObject({
      path: `/clients/${ids.clientA}`,
      body: { displayName: '合成客户甲改', gender: 'female', birthYear: 1961 },
    });
  });

  it('adds a health history entry to the chosen category', async () => {
    const user = userEvent.setup();
    const { api } = renderRecord(makeRecord({ healthHistory: [] }), {
      [`POST /clients/${ids.clientA}/health-history`]: () =>
        json(201, {
          item: {
            id: HISTORY_ID,
            category: 'family_history',
            content: '合成记录：父亲高血压',
            recordedOn: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
    });
    await user.click(await screen.findByRole('button', { name: '添加家族史' }));
    const form = screen.getByRole('form', { name: '添加家族史' });
    await user.click(within(form).getByRole('button', { name: '保存' }));
    expect(within(form).getByText('请填写内容')).toBeInTheDocument();

    await user.type(within(form).getByRole('textbox', { name: '内容' }), '合成记录：父亲高血压');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')).toMatchObject({
        path: `/clients/${ids.clientA}/health-history`,
        body: { category: 'family_history', content: '合成记录：父亲高血压', recordedOn: null },
      }),
    );
    // 保存后重新加载档案
    await waitFor(() =>
      expect(api.callsTo('GET', `/clients/${ids.clientA}/record`)).toHaveLength(2),
    );
  });

  it('deletes a history entry only after confirming', async () => {
    const user = userEvent.setup();
    const { api } = renderRecord(makeRecord(), {
      [`DELETE /clients/${ids.clientA}/health-history/${HISTORY_ID}`]: () =>
        new Response(null, { status: 204 }),
    });
    await user.click(await screen.findByRole('button', { name: '删除这条过敏史' }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: '确定删除' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'DELETE')?.path).toBe(
        `/clients/${ids.clientA}/health-history/${HISTORY_ID}`,
      ),
    );
  });

  it('requires a reason when the manager changes the risk tier, and shows the history', async () => {
    const user = userEvent.setup();
    const { api } = renderRecord(makeRecord(), {
      [`POST /clients/${ids.clientA}/risk-tiers`]: () =>
        json(201, { tier: { ...TIER, tier: 'high', reason: '合成理由二' } }),
      [`GET /clients/${ids.clientA}/risk-tiers`]: () =>
        json(200, {
          tiers: [
            TIER,
            {
              ...TIER,
              id: REPORT_ID,
              setByName: null,
              source: 'artifact',
              sourceArtifactId: null,
            },
          ],
        }),
    });
    await user.click(await screen.findByRole('button', { name: '调整分层' }));
    const form = screen.getByRole('form', { name: '设定风险分层' });
    await user.click(within(form).getByRole('radio', { name: '高' }));
    await user.click(within(form).getByRole('button', { name: '保存' }));
    expect(within(form).getByText('请填写理由')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(form).getByRole('textbox', { name: '理由（必填）' }), '合成理由二');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')).toMatchObject({
        path: `/clients/${ids.clientA}/risk-tiers`,
        body: { tier: 'high', reason: '合成理由二' },
      }),
    );

    await user.click(await screen.findByRole('button', { name: '查看历史' }));
    const list = await screen.findByRole('list', { name: '查看历史' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText(/其他健管师 ·/)).toBeInTheDocument();
    // 审核 /体检解读 时采用的建议分层，历史里写明来源（规格 2.7）
    expect(within(list).getByText(/其他健管师 ·.*采用建议分层/)).toBeInTheDocument();
  });

  it('keeps the basic info visible when the record cannot be loaded', async () => {
    mockApi({});
    render(<ClientRecord client={CLIENTS[0]!} onClientSaved={vi.fn()} />);
    expect(await screen.findByText('客户不存在或已不可见')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /合成客户甲/ })).toBeInTheDocument();
  });
});

describe('creating a client from the record tab', () => {
  beforeEach(() => setWideViewport());

  it('creates a client, adds it to the list and shows its record', async () => {
    const user = userEvent.setup();
    const created = {
      id: NEW_CLIENT_ID,
      displayName: '合成客户丙',
      gender: null,
      birthYear: 1985,
      managerId: ids.manager,
      isSynthetic: false,
    };
    const api = mockApi({
      'GET /tasks': () => json(200, { tasks: [] }),
      'GET /clients': () => json(200, { clients: CLIENTS }),
      'GET /skills': () => json(200, { skills: [SKILL] }),
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(makeTask())),
      'POST /clients': () => json(201, { client: created }),
      [`GET /clients/${NEW_CLIENT_ID}/record`]: () =>
        json(200, {
          record: makeRecord({
            client: created,
            riskTier: null,
            healthHistory: [],
            reports: [],
            indicators: [],
            monitoring: [],
            artifacts: [],
          }),
        }),
    });
    render(<AppShell />);
    await user.click(screen.getByRole('tab', { name: '客户' }));
    await user.click(screen.getByRole('button', { name: '新建客户' }));
    await user.type(screen.getByRole('textbox', { name: '称呼（必填）' }), '合成客户丙');
    await user.type(screen.getByRole('textbox', { name: '出生年份' }), '1985');
    await user.click(screen.getByRole('button', { name: '新建' }));

    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByRole('heading', { name: '合成客户丙' })).toBeInTheDocument();
    // 空状态里有“新建客户”；选中客户后档案右上角不再有
    expect(within(panel).queryByRole('button', { name: '新建客户' })).not.toBeInTheDocument();
    // 客户标签默认是孪生，档案在第二个子视图（M4 规格 2.1）
    await user.click(within(panel).getByRole('button', { name: '档案' }));
    expect(await within(panel).findByText('还没有已核对的报告')).toBeInTheDocument();
    expect(api.callsTo('POST', '/clients')[0]?.body).toEqual({
      displayName: '合成客户丙',
      gender: null,
      birthYear: 1985,
    });
    // 新客户马上可以 @
    await user.type(screen.getByRole('textbox', { name: /描述你的需求/ }), '@丙');
    expect(await screen.findByRole('option', { name: /合成客户丙/ })).toBeInTheDocument();
  });
});
