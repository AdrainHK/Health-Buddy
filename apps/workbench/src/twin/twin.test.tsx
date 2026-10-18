import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FollowUpItem, TwinResponse, TwinTimelineResponse } from '@health-buddy/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIENTS, ids, json, mockApi } from '../test/mockApi';
import {
  CRITICAL_FOLLOW_UP,
  EMPTY_TIMELINE,
  followUpList,
  makeDomain,
  makeFollowUp,
  makeForecast,
  makeForecastDetail,
  makeStatusRecord,
  makeThreshold,
  makeTwin,
  twinIds,
  tzQuery,
} from '../test/twinFixtures';
import { FollowUpCenter } from './FollowUpCenter';
import {
  ForecastCard,
  ForecastDialog,
  forecastCriticalCrossing,
  forecastCrossing,
} from './ForecastChart';
import { StatusCard } from './StatusCard';
import { TWIN_POLL_MS, TwinView } from './TwinView';

/** 孪生视图、状态卡片、预测图、跟进清单（M4 规格 2.2–2.6）。全部是合成数据 */

const A = ids.clientA;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockTwin(
  twin: TwinResponse | (() => TwinResponse) = makeTwin(),
  extra: Parameters<typeof mockApi>[0] = {},
  options: { followUps?: FollowUpItem[]; timeline?: TwinTimelineResponse } = {},
) {
  return mockApi({
    [`GET /clients/${A}/twin`]: () => json(200, typeof twin === 'function' ? twin() : twin),
    [`GET /clients/${A}/twin/forecasts/sbp`]: () => json(200, makeForecastDetail()),
    [`GET /follow-ups${tzQuery({ clientId: A })}`]: () =>
      json(200, followUpList(options.followUps ?? [])),
    [`GET /clients/${A}/twin/timeline`]: () => json(200, options.timeline ?? EMPTY_TIMELINE),
    'GET /critical-thresholds': () => json(200, { thresholds: [makeThreshold()] }),
    ...extra,
  });
}

function renderTwin(props: Partial<Parameters<typeof TwinView>[0]> = {}) {
  const onOpenRecord = vi.fn();
  const onTwinChanged = vi.fn();
  const utils = render(
    <TwinView
      client={CLIENTS[0]!}
      onOpenRecord={onOpenRecord}
      onTwinChanged={onTwinChanged}
      {...props}
    />,
  );
  return { ...utils, onOpenRecord, onTwinChanged };
}

describe('孪生视图（规格 2.2）', () => {
  it('从上到下：固定提示条、画像（人体轮廓 + 四张状态卡片）、趋势预测、待跟进、时间轴', async () => {
    mockTwin(makeTwin(), {}, { followUps: [makeFollowUp()] });
    const { container } = renderTwin();
    expect(await screen.findByRole('heading', { name: '画像' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('仅供参考，非医疗诊断');
    expect(screen.getByRole('group', { name: '人体轮廓：点一个区域查看对应方面' })).toBeVisible();
    for (const name of ['代谢', '心血管', '睡眠', '体重'])
      expect(screen.getByRole('article', { name })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 5 }).map((h) => h.textContent);
    expect(headings.indexOf('画像')).toBeLessThan(headings.indexOf('趋势预测'));
    expect(headings.indexOf('趋势预测')).toBeLessThan(headings.indexOf('待跟进'));
    expect(headings.indexOf('待跟进')).toBeLessThan(headings.indexOf('时间轴'));
    // 这位客户的跟进项，不显示“打开客户”
    expect(await screen.findByText(/代谢由绿变黄/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /打开 .* 的孪生/ })).not.toBeInTheDocument();
    // 第 4 步的按钮还没有
    expect(screen.queryByRole('button', { name: /生成孪生小结|请专家看看/ })).toBeNull();
    expect(container.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'wide');
    // 默认规则尚待医学审核
    expect(screen.getByTestId('twin-rules-note')).toHaveTextContent(
      '红黄绿的默认规则是初步做法，不是医学标准，还在等待医学审核。',
    );
  });

  it('有未处理的危急指标：提示条变为醒目样式“有危急指标，请先电话联系客户”', async () => {
    mockTwin(makeTwin({ hasOpenCritical: true }));
    renderTwin();
    const banner = await screen.findByRole('note');
    await waitFor(() => expect(banner).toHaveAttribute('data-variant', 'critical'));
    expect(banner).toHaveTextContent('有危急指标，请先电话联系客户');
    expect(banner).toHaveTextContent('仅供参考，非医疗诊断');
  });

  it('没有任何数据：空状态，四个方面都是“数据不足”', async () => {
    mockTwin(
      makeTwin({
        hasData: false,
        forecasts: [],
        domains: (['metabolic', 'cardiovascular', 'sleep', 'weight'] as const).map((d) =>
          makeDomain(d, 'unknown'),
        ),
      }),
    );
    renderTwin();
    expect(await screen.findByText('还没有可用的数据：请上传并核对体检报告')).toBeInTheDocument();
    expect(screen.getAllByText('数据不足')).toHaveLength(4);
    expect(screen.queryByRole('heading', { name: '趋势预测' })).not.toBeInTheDocument();
  });

  it('正在更新：显示上一次的结果和“正在更新”，算完后自动刷新', async () => {
    let computing = true;
    const api = mockTwin(() => makeTwin({ computing }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTwin();
    expect(await screen.findByTestId('twin-computing')).toHaveTextContent('正在更新');
    expect(screen.getByRole('article', { name: '代谢' })).toBeInTheDocument();
    computing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TWIN_POLL_MS + 10);
    });
    await waitFor(() => expect(screen.queryByTestId('twin-computing')).not.toBeInTheDocument());
    expect(api.callsTo('GET', `/clients/${A}/twin`).length).toBeGreaterThanOrEqual(2);
  });

  it('手机宽度：data-layout="narrow"（人体轮廓缩小放在顶部，四个方面单列）', async () => {
    mockTwin();
    const { container } = renderTwin({ narrow: true });
    await screen.findByRole('heading', { name: '画像' });
    expect(container.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'narrow');
  });

  it('点人体轮廓的区域等同点对应的状态卡片：焦点移到卡片', async () => {
    mockTwin();
    const user = userEvent.setup();
    renderTwin();
    const region = await screen.findByRole('button', { name: '心血管：平稳，查看状态卡片' });
    await user.click(region);
    expect(screen.getByRole('article', { name: '心血管' })).toHaveFocus();
    // 键盘也能用
    screen.getByRole('button', { name: '代谢：需要留意，查看状态卡片' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('article', { name: '代谢' })).toHaveFocus();
  });

  it('依据可以点开跳到档案；风险分层只读显示', async () => {
    mockTwin(
      makeTwin({
        riskTier: {
          id: twinIds.record2,
          tier: 'medium',
          reason: '合成理由',
          setBy: ids.manager,
          setByName: '合成健管师',
          setAt: '2026-10-01T00:00:00.000Z',
          source: 'manual',
          sourceArtifactId: null,
        },
      }),
    );
    const user = userEvent.setup();
    const { onOpenRecord } = renderTwin();
    expect(await screen.findByText(/风险分层（只读）：中/)).toBeInTheDocument();
    const card = screen.getByRole('article', { name: '代谢' });
    await user.click(within(card).getByRole('button', { name: '在档案中查看' }));
    expect(onOpenRecord).toHaveBeenCalled();
  });

  it('客户不存在或已不可见：提示并可以重试', async () => {
    mockApi({});
    renderTwin();
    expect(await screen.findByRole('alert')).toHaveTextContent('客户不存在或已不可见');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});

describe('状态卡片（规格 2.3）', () => {
  const MARKERS = { red: '!', yellow: '△', green: '✓', unknown: '?' } as const;
  const TEXT = { red: '需要尽快关注', yellow: '需要留意', green: '平稳', unknown: '数据不足' };

  for (const level of ['red', 'yellow', 'green', 'unknown'] as const) {
    it(`${level}：文字和图形标记同时出现，颜色不是唯一的表达`, () => {
      render(
        <StatusCard
          clientId={A}
          view={makeDomain('cardiovascular', level)}
          onChanged={() => {}}
          onOpenRecord={() => {}}
        />,
      );
      const card = screen.getByRole('article', { name: '心血管' });
      expect(card).toHaveAttribute('data-level', level);
      const badge = within(card).getByText(TEXT[level]);
      expect(badge).toHaveAttribute('data-level', level);
      expect(badge).toHaveTextContent(`${MARKERS[level]}${TEXT[level]}`);
    });
  }

  it('依据写明数值、日期、报告参考范围；来源标记写明规则版本；和上次相比', () => {
    render(
      <StatusCard
        clientId={A}
        view={makeDomain('metabolic', 'yellow', {
          previousLevel: 'green',
          changedAt: '2026-10-02T03:00:00.000Z',
        })}
        onChanged={() => {}}
        onOpenRecord={() => {}}
      />,
    );
    expect(
      screen.getByText(/空腹血糖 6\.5 mmol\/L（2026-09-12 报告）；高于报告上的参考范围 3\.9–6\.1/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/系统按规则计算（规则版本 v3，\d{4}-\d{2}-\d{2} 更新）/),
    ).toBeInTheDocument();
    expect(screen.getByText('由绿变黄（2026-10-02）')).toBeInTheDocument();
  });

  it('监测依据、危急阈值和报告未提供参考范围', () => {
    const record = makeStatusRecord({
      domain: 'cardiovascular',
      level: 'red',
      basis: [
        {
          source: 'monitoring',
          metric: 'sbp',
          value: 181.5,
          unit: 'mmHg',
          observedOn: '2026-10-17',
          outcome: 'red',
          hits: [
            {
              ruleId: 'r2',
              method: 'critical',
              level: 'red',
              snapshot: {
                comparator: 'gte',
                value: 180,
                unit: 'mmHg',
                windowDays: null,
                criticalLevel: 'urgent',
              },
            },
          ],
          windowDays: 7,
          count: 9,
          from: '2026-10-11',
          latestValue: 186,
          latestReadingId: '12',
        },
        {
          source: 'report',
          metric: 'dbp',
          value: 82,
          unit: 'mmHg',
          observedOn: '2026-09-12',
          outcome: 'green',
          hits: [],
          reportId: twinIds.report,
          indicatorId: 'i-2',
          refLow: null,
          refHigh: null,
          noReference: true,
        },
      ],
    });
    render(
      <StatusCard
        clientId={A}
        view={makeDomain('cardiovascular', 'red', { computed: record })}
        onChanged={() => {}}
        onOpenRecord={() => {}}
      />,
    );
    expect(
      screen.getByText(
        /收缩压 近 7 天平均 181\.5 mmHg（9 条，2026-10-11 至 2026-10-17 监测）；达到危急阈值 ≥ 180 mmHg/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/舒张压 82 mmHg（2026-09-12 报告）；报告未提供参考范围/),
    ).toBeInTheDocument();
  });

  it('系统计算和手动调整同时显示，带调整人和理由；可以取消调整', async () => {
    const api = mockApi({
      [`DELETE /clients/${A}/twin/status/metabolic`]: () =>
        json(200, { domain: makeDomain('metabolic', 'yellow') }),
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <StatusCard
        clientId={A}
        view={makeDomain('metabolic', 'green', {
          computed: makeStatusRecord(),
          manual: makeStatusRecord({
            id: twinIds.record2,
            level: 'green',
            origin: 'manual',
            reason: '客户已复查，结果正常',
            manualExpires: 'next_data',
            trigger: 'manual',
            setBy: ids.manager,
            setByName: '合成健管师',
          }),
        })}
        onChanged={onChanged}
        onOpenRecord={() => {}}
      />,
    );
    expect(
      screen.getByText('系统计算：黄（需要留意）；健管师调整为：绿（平稳）'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('健管师 合成健管师 手动调整：客户已复查，结果正常'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /取消调整/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.callsTo('DELETE', `/clients/${A}/twin/status/metabolic`)).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('已恢复系统计算');
  });

  it('手动调整的失效提示：新数据进来后已恢复系统计算', () => {
    render(
      <StatusCard
        clientId={A}
        view={makeDomain('metabolic', 'yellow', { manualExpiredByNewData: true })}
        onChanged={() => {}}
        onOpenRecord={() => {}}
      />,
    );
    expect(screen.getByText('新数据进来后已恢复系统计算')).toBeInTheDocument();
  });

  it('调整状态：理由少于 5 个字不能提交（前端拦下，不发请求）；填够后提交', async () => {
    const api = mockApi({
      [`POST /clients/${A}/twin/status`]: () =>
        json(200, {
          domain: makeDomain('metabolic', 'yellow', {
            level: 'red',
            manual: makeStatusRecord({
              level: 'red',
              origin: 'manual',
              reason: '客户电话反映头晕',
            }),
          }),
        }),
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <StatusCard
        clientId={A}
        view={makeDomain('metabolic', 'yellow')}
        onChanged={onChanged}
        onOpenRecord={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /调整状态/ }));
    // 只能调成红黄绿，不能调成“数据不足”
    expect(screen.queryByRole('radio', { name: /数据不足/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /需要尽快关注/ }));
    await user.type(screen.getByRole('textbox', { name: /理由/ }), '  头晕  ');
    await user.click(screen.getByRole('button', { name: '保存调整' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请填写理由，不少于 5 个字');
    expect(screen.getByRole('textbox', { name: /理由/ })).toHaveAttribute('aria-invalid', 'true');
    expect(api.callsTo('POST', `/clients/${A}/twin/status`)).toHaveLength(0);

    await user.clear(screen.getByRole('textbox', { name: /理由/ }));
    await user.type(screen.getByRole('textbox', { name: /理由/ }), '客户电话反映头晕');
    await user.click(screen.getByRole('button', { name: '保存调整' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.callsTo('POST', `/clients/${A}/twin/status`)[0]?.body).toEqual({
      domain: 'metabolic',
      level: 'red',
      reason: '客户电话反映头晕',
      expires: 'next_data',
    });
  });

  it('后端拒绝（400）时提示，不关闭表单', async () => {
    mockApi({ [`POST /clients/${A}/twin/status`]: () => json(400, { error: 'bad_request' }) });
    const user = userEvent.setup();
    render(
      <StatusCard
        clientId={A}
        view={makeDomain('metabolic', 'yellow')}
        onChanged={() => {}}
        onOpenRecord={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /调整状态/ }));
    await user.type(screen.getByRole('textbox', { name: /理由/ }), '客户电话反映头晕');
    await user.click(screen.getByRole('button', { name: '保存调整' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('填写的内容不符合要求');
    expect(screen.getByRole('button', { name: '保存调整' })).toBeInTheDocument();
  });
});

describe('趋势预测（规格 2.4）', () => {
  it('小图：实线是实际数值，虚线是中间值，阴影是 80% 区间，浅色横带是参考范围', () => {
    render(
      <ul>
        <ForecastCard
          forecast={makeForecast()}
          detail={makeForecastDetail()}
          detailState="ready"
          onOpen={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTestId('actual-line')).toBeInTheDocument();
    expect(screen.getByTestId('forecast-median')).not.toHaveAttribute('data-uncertainty', 'high');
    expect(screen.getByTestId('forecast-band')).toBeInTheDocument();
    expect(screen.getByTestId('reference-band')).toBeInTheDocument();
    expect(screen.getByText('不确定性：一般')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /收缩压趋势图/ })).toBeInTheDocument();
  });

  it('数据不足：只画实际数值，不画虚线，写明还需要几次数据', () => {
    render(
      <ul>
        <ForecastCard
          forecast={makeForecast({
            source: 'report',
            status: 'insufficient_data',
            insufficientReason: 'too_few_points',
            pointsNeeded: 2,
            uncertainty: null,
            horizonMonths: null,
            basis: null,
            points: [],
          })}
          detail={makeForecastDetail({
            actual: [
              { at: '2026-03-01T00:00:00.000Z', value: 130, source: 'report', manual: false },
            ],
          })}
          detailState="ready"
          onOpen={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTestId('forecast-insufficient')).toHaveTextContent(
      '数据不足，暂不预测：还需要 2 次已核对报告的数值',
    );
    expect(screen.queryByTestId('forecast-median')).not.toBeInTheDocument();
    expect(screen.queryByTestId('forecast-band')).not.toBeInTheDocument();
  });

  it('监测数据不足：还需要几个有效周', () => {
    render(
      <ul>
        <ForecastCard
          forecast={makeForecast({
            status: 'insufficient_data',
            insufficientReason: 'too_few_points',
            pointsNeeded: 5,
            uncertainty: null,
            basis: null,
            points: [],
          })}
          detail={null}
          detailState="loading"
          onOpen={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTestId('forecast-insufficient')).toHaveTextContent('还需要 5 个有效周');
  });

  it('不确定性高：虚线改为更浅的样式，并标“不确定性：高”', () => {
    render(
      <ul>
        <ForecastCard
          forecast={makeForecast({ uncertainty: 'high' })}
          detail={makeForecastDetail()}
          detailState="ready"
          onOpen={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTestId('forecast-median')).toHaveAttribute('data-uncertainty', 'high');
    expect(screen.getByText('不确定性：高')).toBeInTheDocument();
  });

  it('预测越过参考范围：图上和文字标出，只是提醒', () => {
    render(
      <ul>
        <ForecastCard
          forecast={makeForecast()}
          detail={makeForecastDetail()}
          detailState="ready"
          onOpen={() => {}}
        />
      </ul>,
    );
    // 6 个月后的中间值 142 高于参考范围上限 140
    const marker = screen.getByTestId('forecast-crossing');
    expect(marker).toHaveAttribute('data-kind', 'reference');
    // 图形是箭头，不和红色状态的“!”混淆；<title> 里写明提醒
    expect(marker).toHaveTextContent('↗');
    expect(marker).not.toHaveTextContent('!');
    expect(marker.querySelector('title')).toHaveTextContent(
      '按当前走势，约 6 个月后可能高于报告参考范围上限。',
    );
    // 小卡片上也有简短说明：只是提醒
    expect(screen.getByTestId('forecast-crossing-text')).toHaveTextContent(
      '按当前走势，约 6 个月后可能高于报告参考范围上限。仅作提醒，不生成跟进项',
    );
    expect(forecastCrossing(makeForecast(), { low: null, high: 160 })).toBeNull();
    expect(forecastCrossing(makeForecast(), { low: 140, high: null })).toEqual({
      side: 'low',
      months: 3,
    });
  });

  it('预测达到危急阈值：图上和文字标出，只是提醒；停用的阈值和别的指标不算', () => {
    const forecast = makeForecast();
    const rule = makeThreshold({ value: 140 });
    expect(forecastCriticalCrossing(forecast, [rule])).toEqual({
      side: 'high',
      months: 6,
      comparator: 'gte',
      value: 140,
    });
    expect(forecastCriticalCrossing(forecast, [{ ...rule, enabled: false }])).toBeNull();
    expect(forecastCriticalCrossing(forecast, [{ ...rule, metric: 'dbp' }])).toBeNull();
    expect(forecastCriticalCrossing(forecast, [makeThreshold()])).toBeNull();
    expect(forecastCriticalCrossing(forecast, null)).toBeNull();
    expect(
      forecastCriticalCrossing(forecast, [makeThreshold({ comparator: 'lt', value: 137 })]),
    ).toEqual({ side: 'low', months: 3, comparator: 'lt', value: 137 });
    expect(
      forecastCriticalCrossing(makeForecast({ status: 'insufficient_data', points: [] }), [rule]),
    ).toBeNull();

    render(
      <ul>
        <ForecastCard
          forecast={forecast}
          detail={makeForecastDetail({ reference: null })}
          detailState="ready"
          thresholds={[rule]}
          onOpen={() => {}}
        />
      </ul>,
    );
    const marker = screen.getByTestId('forecast-crossing');
    expect(marker).toHaveAttribute('data-kind', 'critical');
    expect(marker).toHaveTextContent('↗');
    expect(marker.querySelector('title')).toHaveTextContent(
      '按当前走势，约 6 个月后可能达到危急阈值 ≥ 140 mmHg。',
    );
    expect(screen.getByTestId('forecast-crossing-text')).toHaveTextContent(
      '按当前走势，约 6 个月后可能达到危急阈值 ≥ 140 mmHg。仅作提醒，不生成跟进项',
    );
  });

  it('区间水平按预测结果显示，不写死 80%', () => {
    render(
      <ForecastDialog
        forecast={makeForecast({ intervalLevel: 0.9 })}
        detail={makeForecastDetail()}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('阴影为 90% 区间');
    expect(dialog).toHaveTextContent('大约 10 次里有 9 次会落在这个范围内');
    expect(dialog).toHaveTextContent('90% 区间 128–144 mmHg');
    expect(dialog).not.toHaveTextContent('80%');
    expect(screen.getByRole('img', { name: /阴影是 90% 区间/ })).toBeInTheDocument();
  });

  it('大图：下方固定写明依据、方法、80% 区间的含义、局限和不确定性等级', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ForecastDialog
        forecast={makeForecast({ uncertainty: 'high' })}
        detail={makeForecastDetail()}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '收缩压 · 日常监测' });
    expect(dialog).toHaveTextContent(
      '依据：根据 2026-04-20 至 2026-10-12 共 20 个有效周的监测周平均推算',
    );
    expect(dialog).toHaveTextContent('方法：按过去的变化速度直线外推（方法版本 ols-linear-v1）');
    expect(dialog).toHaveTextContent('阴影为 80% 区间');
    expect(dialog).toHaveTextContent('大约 10 次里有 8 次会落在这个范围内');
    expect(dialog).toHaveTextContent('不是对任何疾病的预测');
    expect(dialog).toHaveTextContent('不确定性等级：高');
    expect(dialog).toHaveTextContent(
      '3 个月后（2027-01-15）：中间值 136 mmHg，80% 区间 128–144 mmHg',
    );
    expect(dialog).toHaveTextContent('参考范围取自最近一份报告：90–140 mmHg');
    // 规格 5.4 第 5 条：每张预测大图下方标注
    expect(within(dialog).getByTestId('forecast-disclaimer')).toHaveTextContent(
      '仅供参考，非医疗诊断',
    );
    expect(dialog).toHaveTextContent(
      '按当前走势，约 6 个月后可能高于报告参考范围上限。只是给健管师的提醒',
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('在孪生里点小图打开大图（危急阈值从平台阈值读取）', async () => {
    const api = mockTwin(makeTwin(), {
      'GET /critical-thresholds': () =>
        json(200, { thresholds: [makeThreshold({ value: 140, level: 'attention' })] }),
    });
    const user = userEvent.setup();
    renderTwin();
    await user.click(
      await screen.findByRole('button', { name: '查看收缩压（日常监测）的大图和依据' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('局限：只根据过去的数值推算');
    await waitFor(() =>
      expect(dialog).toHaveTextContent('约 6 个月后可能达到危急阈值 ≥ 140 mmHg。'),
    );
    expect(dialog).toHaveTextContent('仅供参考，非医疗诊断');
    // 只读阈值，不生成跟进项、不改状态
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('今日跟进清单（规格 2.6）', () => {
  function renderCenter(items: FollowUpItem[]) {
    const onChanged = vi.fn();
    const onOpenClient = vi.fn();
    render(
      <FollowUpCenter
        narrow={false}
        onOpenMenu={() => {}}
        state={{ status: 'ready', data: followUpList(items) }}
        onRetry={() => {}}
        onOpenClient={onOpenClient}
        onChanged={onChanged}
      />,
    );
    return { onChanged, onOpenClient };
  }

  it('按严重程度排序，同级按触发时间从新到旧；显示“已延续 x 天”和一句依据', () => {
    const older = makeFollowUp({
      id: twinIds.follow3,
      lastTriggeredAt: '2026-10-10T00:00:00.000Z',
      carriedDays: 8,
    });
    renderCenter([older, makeFollowUp(), CRITICAL_FOLLOW_UP]);
    const items = within(screen.getByRole('list', { name: '跟进项' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('1 级');
    expect(items[0]).toHaveTextContent('合成客户乙 · 危急指标 · 心血管');
    expect(items[0]).toHaveTextContent('收缩压 182 mmHg（2026-10-17 监测）达到危急阈值 ≥ 180');
    expect(items[0]).toHaveTextContent('今天新增');
    expect(items[1]).toHaveTextContent('已延续 3 天');
    expect(items[2]).toHaveTextContent('已延续 8 天');
    expect(items[1]).toHaveTextContent('代谢由绿变黄：空腹血糖 6.5 mmol/L（2026-09-12 报告）');
  });

  it('预测偏离：区间水平跟着数据走，旧数据没有时按固定的 80%', () => {
    const basis = {
      source: 'monitoring',
      metric: 'sbp',
      value: 150,
      unit: 'mmHg',
      observedOn: '2026-10-16',
      expected: { low: 128, high: 144 },
      side: 'above',
      direction: 'worse',
    };
    renderCenter([
      makeFollowUp({ kind: 'forecast_deviation', basis }),
      makeFollowUp({
        id: twinIds.follow3,
        kind: 'forecast_deviation',
        basis: { ...basis, intervalLevel: 0.9 },
      }),
    ]);
    const items = within(screen.getByRole('list', { name: '跟进项' })).getAllByRole('listitem');
    const texts = items.map((i) => i.textContent ?? '');
    expect(texts.some((t) => t.includes('高于之前预测的 80% 区间 128–144（偏向变差）'))).toBe(true);
    expect(texts.some((t) => t.includes('高于之前预测的 90% 区间 128–144'))).toBe(true);
  });

  it('打开客户', async () => {
    const user = userEvent.setup();
    const { onOpenClient } = renderCenter([makeFollowUp()]);
    await user.click(screen.getByRole('button', { name: '打开 合成客户甲 的孪生' }));
    expect(onOpenClient).toHaveBeenCalledWith(ids.clientA);
  });

  it('已处理：可选方式类别和备注，带浏览器时区', async () => {
    const api = mockApi({
      [`PATCH /follow-ups/${twinIds.follow1}${tzQuery()}`]: () =>
        json(200, { item: makeFollowUp({ status: 'done' }) }),
    });
    const user = userEvent.setup();
    const { onChanged } = renderCenter([makeFollowUp()]);
    await user.click(screen.getByRole('button', { name: /处理 合成客户甲/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: /处理方式类别/ }), '已电话联系');
    await user.type(screen.getByRole('textbox', { name: /备注/ }), '已约下周复查');
    await user.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      action: 'done',
      resolution: 'called',
      note: '已约下周复查',
    });
  });

  it('暂缓：明天、3 天后、7 天后', async () => {
    const api = mockApi({
      [`PATCH /follow-ups/${twinIds.follow1}${tzQuery()}`]: () =>
        json(200, { item: makeFollowUp({ status: 'snoozed' }) }),
    });
    const user = userEvent.setup();
    const { onChanged } = renderCenter([makeFollowUp()]);
    await user.click(screen.getByRole('button', { name: /处理 合成客户甲/ }));
    await user.click(screen.getByRole('radio', { name: '暂缓' }));
    for (const name of ['明天', '3 天后', '7 天后'])
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '3 天后' }));
    await user.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      action: 'snooze',
      snoozeDays: 3,
    });
  });

  it('忽略：必须选原因（前端拦下，不发请求）', async () => {
    const api = mockApi({
      [`PATCH /follow-ups/${twinIds.follow1}${tzQuery()}`]: () =>
        json(200, { item: makeFollowUp({ status: 'dismissed' }) }),
    });
    const user = userEvent.setup();
    const { onChanged } = renderCenter([makeFollowUp()]);
    await user.click(screen.getByRole('button', { name: /处理 合成客户甲/ }));
    await user.click(screen.getByRole('radio', { name: '忽略' }));
    await user.click(screen.getByRole('button', { name: '确定' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请选择忽略原因');
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    await user.selectOptions(screen.getByRole('combobox', { name: /忽略原因/ }), '数据误差');
    await user.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      action: 'dismiss',
      dismissReason: 'data_error',
    });
  });

  it('危急指标类不能忽略：不提供“忽略”，只能已处理或暂缓', async () => {
    const user = userEvent.setup();
    renderCenter([CRITICAL_FOLLOW_UP]);
    await user.click(screen.getByRole('button', { name: /处理 合成客户乙/ }));
    expect(screen.getByRole('radio', { name: '已处理' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '暂缓' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '忽略' })).not.toBeInTheDocument();
    expect(
      screen.getByText('危急指标类的项目不能忽略，只能标为已处理或暂缓。'),
    ).toBeInTheDocument();
  });

  it('后端拒绝忽略危急类（400）：提示不能忽略，表单保留', async () => {
    // 前端拿到的清单可能已过期：后端仍按项目类型拒绝
    const stale = makeFollowUp({ kind: 'status_red', severity: 2 });
    mockApi({
      [`PATCH /follow-ups/${twinIds.follow1}${tzQuery()}`]: () =>
        json(400, { error: 'bad_request' }),
    });
    const user = userEvent.setup();
    const { onChanged } = renderCenter([stale]);
    await user.click(screen.getByRole('button', { name: /处理 合成客户甲/ }));
    await user.click(screen.getByRole('radio', { name: '忽略' }));
    await user.selectOptions(screen.getByRole('combobox', { name: /忽略原因/ }), '已知情况');
    await user.click(screen.getByRole('button', { name: '确定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('危急指标类的项目不能忽略');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });

  it('清单为空和加载失败', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <FollowUpCenter
        narrow={false}
        onOpenMenu={() => {}}
        state={{ status: 'ready', data: followUpList([]) }}
        onRetry={onRetry}
        onOpenClient={() => {}}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText('今天没有需要跟进的项目')).toBeInTheDocument();
    rerender(
      <FollowUpCenter
        narrow
        onOpenMenu={() => {}}
        state={{ status: 'error', data: null }}
        onRetry={onRetry}
        onOpenClient={() => {}}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('跟进清单加载失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('时间轴（规格 2.5）', () => {
  const page1: TwinTimelineResponse = {
    events: [
      {
        type: 'status_change',
        id: 'status:1',
        at: '2026-10-18T02:00:00.000Z',
        domain: 'metabolic',
        from: 'green',
        to: 'yellow',
        origin: 'computed',
        trigger: 'report_verified',
      },
      {
        type: 'follow_up',
        id: 'follow:1',
        at: '2026-10-05T02:00:00.000Z',
        itemId: twinIds.follow1,
        kind: 'status_worsened',
        action: 'dismissed',
        resolution: null,
        dismissReason: 'known',
      },
      {
        type: 'report',
        id: 'report:1',
        at: '2026-09-12T02:00:00.000Z',
        reportId: twinIds.report,
        reportDate: '2026-09-12',
        abnormalCount: 2,
        hasCritical: true,
      },
    ],
    nextBefore: '2026-09-12T02:00:00.000Z',
  };
  const page2: TwinTimelineResponse = {
    events: [
      {
        type: 'correction',
        id: 'correction:1',
        at: '2026-08-01T02:00:00.000Z',
        reportId: twinIds.report,
        metric: 'fpg',
        actorName: null,
      },
    ],
    nextBefore: null,
  };

  it('倒序、按月分组、按类型筛选、加载更早的', async () => {
    const api = mockApi({
      [`GET /clients/${A}/twin`]: () => json(200, makeTwin({ forecasts: [] })),
      [`GET /follow-ups${tzQuery({ clientId: A })}`]: () => json(200, followUpList([])),
      [`GET /clients/${A}/twin/timeline`]: () => json(200, page1),
      [`GET /clients/${A}/twin/timeline?before=${encodeURIComponent(page1.nextBefore!)}`]: () =>
        json(200, page2),
      [`GET /clients/${A}/twin/timeline?types=report`]: () =>
        json(200, { events: [page1.events[2]], nextBefore: null }),
    });
    const user = userEvent.setup();
    renderTwin();
    const oct = await screen.findByRole('region', { name: '2026 年 10 月' });
    expect(within(oct).getByText('代谢：平稳 → 需要留意（系统计算）')).toBeInTheDocument();
    expect(within(oct).getByText('跟进项 · 状态变差：忽略 · 已知情况')).toBeInTheDocument();
    const sep = screen.getByRole('region', { name: '2026 年 9 月' });
    expect(
      within(sep).getByText('体检报告（2026-09-12）：2 项超出参考范围 · 含危急指标'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '加载更早的' }));
    const aug = await screen.findByRole('region', { name: '2026 年 8 月' });
    // 更正不显示数值
    expect(within(aug).getByText('报告更正：空腹血糖（其他健管师）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更早的' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: '按类型筛选' }), '体检报告');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '2026 年 10 月' })).not.toBeInTheDocument(),
    );
    expect(api.callsTo('GET', `/clients/${A}/twin/timeline?types=report`)).toHaveLength(1);
  });
});

describe('手动录入监测数据（Q29）', () => {
  const reading = {
    id: '42',
    clientId: A,
    metric: 'sbp',
    value: 132,
    unit: 'mmHg',
    measuredAt: '2026-10-17T01:00:00.000Z',
    source: 'manual' as const,
    deletable: true,
  };

  async function openForm(extra: Parameters<typeof mockApi>[0] = {}) {
    const api = mockTwin(makeTwin(), {
      [`GET /clients/${A}/manual-readings`]: () => json(200, { readings: [reading] }),
      ...extra,
    });
    const user = userEvent.setup();
    const utils = renderTwin();
    await user.click(await screen.findByRole('button', { name: '录入监测数据' }));
    return { api, user, ...utils };
  }

  it('数值超出合理范围、时间晚于现在：前端拦下，不发请求', async () => {
    const { api, user } = await openForm();
    await user.type(screen.getByRole('spinbutton', { name: /数值（mmHg）/ }), '900');
    const time = screen.getByLabelText('测量时间');
    await user.clear(time);
    await user.type(time, '2099-01-01T08:00');
    await user.click(screen.getByRole('button', { name: '录入' }));
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.some((a) => a?.includes('之间的数值'))).toBe(true);
    expect(alerts).toContain('测量时间不能晚于现在');
    expect(api.callsTo('POST', `/clients/${A}/monitoring-readings`)).toHaveLength(0);
  });

  it('录入：指标从目录里选、单位跟目录；成功后孪生重新加载；可以删除自己录入的', async () => {
    const { api, user, onTwinChanged } = await openForm({
      [`POST /clients/${A}/monitoring-readings`]: () => json(201, { reading }),
      'DELETE /monitoring-readings/42': () => new Response(null, { status: 204 }),
    });
    expect(await screen.findByText('收缩压 132 mmHg')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: '指标' }), '体重');
    expect(screen.getByRole('spinbutton', { name: '数值（kg）' })).toBeInTheDocument();
    await user.type(screen.getByRole('spinbutton', { name: '数值（kg）' }), '64.5');
    await user.click(screen.getByRole('button', { name: '录入' }));
    await waitFor(() => expect(onTwinChanged).toHaveBeenCalled());
    const body = api.callsTo('POST', `/clients/${A}/monitoring-readings`)[0]?.body as {
      metric: string;
      value: number;
      measuredAt: string;
    };
    expect(body.metric).toBe('weight');
    expect(body.value).toBe(64.5);
    expect(Date.parse(body.measuredAt)).toBeLessThanOrEqual(Date.now());
    expect(screen.getByText('已录入，孪生正在更新')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /删除 .* 的收缩压读数/ }));
    await waitFor(() => expect(api.callsTo('DELETE', '/monitoring-readings/42')).toHaveLength(1));
  });

  it('录入太频繁（429）：提示每分钟最多 60 条', async () => {
    const { user } = await openForm({
      [`POST /clients/${A}/monitoring-readings`]: () =>
        json(429, { error: 'too_many_requests', reasons: ['manual_readings'] }),
    });
    await user.type(screen.getByRole('spinbutton', { name: /数值（mmHg）/ }), '128');
    await user.click(screen.getByRole('button', { name: '录入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('每分钟最多 60 条');
  });
});

describe('设计令牌（验收标准 31）', () => {
  it('红黄绿灰和对应的背景、文字色在浅色和深色模式各有一套', () => {
    const css = readFileSync(
      join(__dirname, '../../../../packages/ui/src/styles/tokens.css'),
      'utf8',
    );
    const names = ['red', 'yellow', 'green', 'unknown'].flatMap((l) => [
      `--hb-twin-${l}`,
      `--hb-twin-${l}-bg`,
      `--hb-twin-${l}-text`,
    ]);
    const blocks = [
      css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')),
      css.slice(
        css.indexOf('@media (prefers-color-scheme: dark)'),
        css.indexOf(":root[data-theme='dark']"),
      ),
      css.slice(css.indexOf(":root[data-theme='dark']")),
    ];
    for (const block of blocks)
      for (const name of names)
        expect(block, name).toMatch(new RegExp(`${name}:\\s*#[0-9a-f]{6};`));
  });

  it('孪生的样式里不写死颜色，只用令牌', () => {
    const css = readFileSync(join(__dirname, 'Twin.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
