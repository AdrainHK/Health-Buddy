import type { ArtifactDetailResponse, ClientRecord } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArtifactView } from '../artifacts/ArtifactView';
import { EXERCISE, RECIPE, RELAX_TEMPLATE, STEPS_TEMPLATE, careIds } from '../test/careFixtures';
import { CLIENTS, NOW, ids, json, makeArtifactDetail, mockApi } from '../test/mockApi';
import { followUpList, makeFollowUp, tzQuery } from '../test/twinFixtures';
import { addDays, localToday } from './dates';

/** M5 第 4 步（4b）：产物里的结构化内容编辑器和审核栏的新提示。全部是合成数据 */

const ART = `/artifacts/${ids.artifact}`;

const PLAN_STRUCTURED = {
  sections: [
    { section: 'diet', professional: '合成', clientFacing: '合成', goals: [] },
    {
      section: 'exercise',
      professional: '合成',
      clientFacing: '合成',
      goals: [{ templateId: careIds.stepsGoal, params: { steps: 6000 } }],
    },
  ],
  recipes: [{ day: 1, meal: 'breakfast', recipeId: careIds.recipe }],
  exercises: [{ exerciseId: careIds.exercise, frequencyPerWeek: 3, minutes: 20 }],
};

function detail(
  skillId: string,
  structured: unknown,
  overrides: Partial<ArtifactDetailResponse['artifact']> = {},
): ArtifactDetailResponse {
  return makeArtifactDetail({
    skillId,
    structured,
    clientFacing: skillId === 'care-plan',
    content:
      skillId === 'care-plan'
        ? { professional: '## 合成方案', clientFacing: '合成通俗版\n\n仅供参考，非医疗诊断' }
        : { professional: '## 合成专业版', clientFacing: '' },
    ...overrides,
  });
}

function record(allergy: string | null): ClientRecord {
  return {
    client: CLIENTS[0]!,
    riskTier: null,
    healthHistory: allergy
      ? [
          {
            id: 'b1000000-0000-4000-8000-000000000001',
            category: 'allergy',
            content: allergy,
            recordedOn: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ]
      : [],
    reports: [],
    indicators: [],
    monitoring: [],
    artifacts: [],
    readOnly: false,
  };
}

function renderView(d: ArtifactDetailResponse, onDetail = vi.fn()) {
  const view = render(
    <ArtifactView
      detail={d}
      readOnly={false}
      onDetail={onDetail}
      onReload={() => {}}
      onOpen={() => {}}
      onChanged={() => {}}
      onReadOnly={() => {}}
      onBack={() => {}}
    />,
  );
  return { ...view, onDetail };
}

const reviewBar = () => screen.getByRole('region', { name: '审核' });

afterEach(() => vi.unstubAllGlobals());

const libraryRoutes = {
  'GET /plan-library/recipes': () => json(200, { items: [RECIPE] }),
  'GET /plan-library/exercises': () => json(200, { items: [EXERCISE] }),
  'GET /plan-library/goal-templates': () => json(200, { items: [STEPS_TEMPLATE, RELAX_TEMPLATE] }),
};

describe('方案草稿：替换条目、改参数、过敏原核对（M5 规格 2.3，Q16）', () => {
  it('参数超出模板范围时前端拦截；改回范围内保存时带上结构化内容', async () => {
    const d = detail('care-plan', PLAN_STRUCTURED);
    const api = mockApi({
      ...libraryRoutes,
      [`GET /clients/${ids.clientA}/record`]: () => json(200, { record: record(null) }),
      [`PATCH ${ART}`]: () => json(200, d),
    });
    const user = userEvent.setup();
    renderView(d);
    await user.click(screen.getByRole('tab', { name: '食谱、动作和目标' }));
    const editor = await screen.findByTestId('care-plan-editor');
    expect(within(editor).getByRole('combobox', { name: '第 1 天 · 早餐' })).toHaveDisplayValue(
      '合成燕麦粥',
    );
    const steps = within(editor).getByRole('spinbutton', { name: /steps（4000–10000 步）/ });
    await user.clear(steps);
    await user.type(steps, '20000');
    expect(within(editor).getByRole('alert')).toHaveTextContent('参数超出了模板允许的范围');
    expect(within(reviewBar()).getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(within(reviewBar()).getByRole('button', { name: '确认' })).toBeDisabled();
    expect(screen.getByTestId('structured-problems')).toHaveTextContent(
      '有目标参数超出了模板允许的范围',
    );

    await user.clear(steps);
    await user.type(steps, '8000');
    await user.click(within(reviewBar()).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.callsTo('PATCH', ART)).toHaveLength(1));
    const body = api.callsTo('PATCH', ART)[0]!.body as { structured: typeof PLAN_STRUCTURED };
    expect(body.structured.sections[1]!.goals[0]!.params).toEqual({ steps: 8000 });
    expect(body.structured.recipes).toEqual(PLAN_STRUCTURED.recipes);
  });

  it('删除示例食谱、加一项动作都只从库里选', async () => {
    const d = detail('care-plan', PLAN_STRUCTURED);
    const api = mockApi({
      ...libraryRoutes,
      [`GET /clients/${ids.clientA}/record`]: () => json(200, { record: record(null) }),
      [`PATCH ${ART}`]: () => json(200, d),
    });
    const user = userEvent.setup();
    renderView(d);
    await user.click(screen.getByRole('tab', { name: '食谱、动作和目标' }));
    const editor = await screen.findByTestId('care-plan-editor');
    await user.click(within(editor).getByRole('button', { name: '删除第 1 天 · 早餐' }));
    expect(within(editor).getByText('没有示例食谱')).toBeInTheDocument();
    await user.selectOptions(
      within(editor).getByRole('combobox', { name: '加一项动作' }),
      '合成快走',
    );
    await user.click(within(reviewBar()).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.callsTo('PATCH', ART)).toHaveLength(1));
    const body = api.callsTo('PATCH', ART)[0]!.body as { structured: typeof PLAN_STRUCTURED };
    expect(body.structured.recipes).toEqual([]);
    expect(body.structured.exercises).toHaveLength(2);
  });

  it('用到的食谱和过敏史有匹配：醒目提示，勾选“已核对过敏原”后才能确认', async () => {
    const d = detail('care-plan', PLAN_STRUCTURED);
    const api = mockApi({
      ...libraryRoutes,
      [`GET /clients/${ids.clientA}/record`]: () => json(200, { record: record('对乳制品过敏') }),
      [`POST ${ART}/approve`]: () =>
        json(200, { ...d, artifact: { ...d.artifact, status: 'approved' } }),
    });
    const user = userEvent.setup();
    renderView(d);
    const panel = await screen.findByTestId('allergen-panel');
    expect(panel).toHaveTextContent('合成燕麦粥：含乳制品');
    const approve = within(reviewBar()).getByRole('button', { name: '确认' });
    expect(approve).toBeDisabled();
    expect(reviewBar()).toHaveTextContent('请先勾选“已核对过敏原”');
    await user.click(within(panel).getByRole('checkbox', { name: '已核对过敏原' }));
    await user.click(approve);
    await waitFor(() => expect(api.callsTo('POST', `${ART}/approve`)).toHaveLength(1));
    expect(api.callsTo('POST', `${ART}/approve`)[0]!.body).toMatchObject({
      acknowledgedAllergens: true,
    });
  });

  it('没有过敏史匹配时不显示过敏原提示，可以直接确认', async () => {
    const d = detail('care-plan', PLAN_STRUCTURED);
    mockApi({
      ...libraryRoutes,
      [`GET /clients/${ids.clientA}/record`]: () => json(200, { record: record('无过敏史') }),
    });
    renderView(d);
    await waitFor(() =>
      expect(within(reviewBar()).getByRole('button', { name: '确认' })).toBeEnabled(),
    );
    expect(screen.queryByTestId('allergen-panel')).toBeNull();
  });
});

describe('随访计划草稿：可编辑的日程表（M5 规格 2.7）', () => {
  const schedule = () => ({
    rows: [
      { dueDate: addDays(localToday(), 7), method: 'phone', purpose: 'routine', focus: '合成重点' },
      { dueDate: addDays(localToday(), 30), method: 'wechat', purpose: 'plan_review', focus: null },
    ],
  });

  it('审核栏说明将写入几次随访；日期重复时不能保存；改好后保存带上日程', async () => {
    const d = detail('visit-schedule', schedule());
    const api = mockApi({ [`PATCH ${ART}`]: () => json(200, d) });
    const user = userEvent.setup();
    renderView(d);
    expect(reviewBar()).toHaveTextContent('确认后将写入 2 次随访');
    // 只有专业版：没有通俗版标签
    expect(screen.queryByRole('tab', { name: '通俗版' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: '随访日程表' }));
    const editor = screen.getByTestId('schedule-editor');
    const second = within(editor).getByLabelText('第 2 次 · 日期');
    await user.clear(second);
    await user.type(second, addDays(localToday(), 7));
    expect(screen.getByTestId('structured-problems')).toHaveTextContent('有两次随访在同一天');
    expect(within(reviewBar()).getByRole('button', { name: '保存修改' })).toBeDisabled();
    await user.clear(second);
    await user.type(second, addDays(localToday(), 14));
    await user.click(within(editor).getByRole('button', { name: '加一行' }));
    expect(screen.getByTestId('structured-problems')).toHaveTextContent('有随访日期为空');
    await user.type(within(editor).getByLabelText('第 3 次 · 日期'), addDays(localToday(), 60));
    await user.click(within(reviewBar()).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.callsTo('PATCH', ART)).toHaveLength(1));
    const body = api.callsTo('PATCH', ART)[0]!.body as { structured: { rows: unknown[] } };
    expect(body.structured.rows).toEqual([
      schedule().rows[0],
      { ...schedule().rows[1], dueDate: addDays(localToday(), 14) },
      { dueDate: addDays(localToday(), 60), method: 'phone', purpose: 'routine', focus: null },
    ]);
  });
});

describe('随访记录草稿：补填日期和方式、一并处理跟进项（M5 规格 2.9，Q26）', () => {
  const recordStructured = (over: Record<string, unknown> = {}) => ({
    visitDate: null,
    method: null,
    summary: '合成摘要',
    feedback: [],
    planProgress: [],
    agreements: [],
    attentionPoints: [],
    historySuggestions: [],
    openQuestions: [],
    ...over,
  });

  it('没有日期和方式时不能确认；补填后保存', async () => {
    const d = detail('visit-record', recordStructured());
    const api = mockApi({
      [`PATCH ${ART}`]: () => json(200, d),
      [`GET /follow-ups${tzQuery({ clientId: ids.clientA })}`]: () => json(200, followUpList([])),
    });
    const user = userEvent.setup();
    renderView(d);
    expect(within(reviewBar()).getByRole('button', { name: '确认' })).toBeDisabled();
    expect(screen.getByTestId('structured-problems')).toHaveTextContent('请填写随访日期和方式');
    await user.click(screen.getByRole('tab', { name: '日期和方式' }));
    const editor = screen.getByTestId('record-editor');
    await user.type(within(editor).getByLabelText('随访日期'), addDays(localToday(), -1));
    await user.selectOptions(within(editor).getByRole('combobox', { name: '方式' }), '电话');
    await user.click(within(reviewBar()).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.callsTo('PATCH', ART)).toHaveLength(1));
    expect(api.callsTo('PATCH', ART)[0]!.body).toMatchObject({
      structured: { visitDate: addDays(localToday(), -1), method: 'phone' },
    });
  });

  it('确认时可以勾选这位客户未处理的跟进项一并标为已处理', async () => {
    const d = detail(
      'visit-record',
      recordStructured({ visitDate: localToday(), method: 'phone' }),
    );
    const item = makeFollowUp();
    const api = mockApi({
      [`GET /follow-ups${tzQuery({ clientId: ids.clientA })}`]: () =>
        json(200, followUpList([item])),
      [`POST ${ART}/approve`]: () =>
        json(200, { ...d, artifact: { ...d.artifact, status: 'approved' } }),
    });
    const user = userEvent.setup();
    renderView(d);
    const panel = await screen.findByTestId('follow-up-resolve');
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(reviewBar()).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(api.callsTo('POST', `${ART}/approve`)).toHaveLength(1));
    expect(api.callsTo('POST', `${ART}/approve`)[0]!.body).toMatchObject({
      resolveFollowUpItemIds: [item.id],
    });
  });
});
