import type { ExpertSummary, Task, TaskStep, TaskStreamEvent } from '@health-buddy/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ArtifactView, type ArtifactViewProps } from '../artifacts/ArtifactView';
import { AppShell } from '../shell/AppShell';
import { ChatPane, type ChatPaneProps } from '../shell/ChatPane';
import {
  ENDO,
  ENDO_DETAIL,
  EXPERTS,
  MENTAL,
  NUTRI,
  SKILL_AUTO,
  call,
  consultation,
  expertIds,
  opinion,
} from '../test/expertFixtures';
import {
  CLIENTS,
  NOW,
  SKILL,
  controlledSse,
  emptyDetail,
  ids,
  json,
  makeArtifactDetail,
  makeTask,
  mockApi,
  setWideViewport,
} from '../test/mockApi';
import { ExpertsContext } from './ExpertsContext';
import { ExpertsTab } from './ExpertsTab';
import { hasReferralSection } from './ExpertReviewNotes';

/** M3 工作台界面：专家库、专家中心提问、@专家、专家选择条、执行步骤、专家标签、审核栏。只用合成数据。 */

afterEach(() => vi.unstubAllGlobals());

const MSG_PATH = `/tasks/${ids.task}/messages`;

function step(overrides: Partial<TaskStep>): TaskStep {
  return {
    id: ids.step1,
    messageId: ids.assistantMsg,
    seq: 0,
    kind: 'consult_experts',
    labelKey: 'steps.consultExperts',
    expertIds: [],
    labelDate: null,
    status: 'running',
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

const expertCall = (
  expertId: string,
  status: Extract<TaskStreamEvent, { type: 'expert_call' }>['status'],
  failureCategory: Extract<TaskStreamEvent, { type: 'expert_call' }>['failureCategory'] = null,
): TaskStreamEvent => ({
  type: 'expert_call',
  consultationId: expertIds.consultation,
  expertId,
  status,
  failureCategory,
});

function withExperts(node: ReactNode, experts: ExpertSummary[] = EXPERTS) {
  return <ExpertsContext.Provider value={experts}>{node}</ExpertsContext.Provider>;
}

describe('专家库和专家中心提问（规格 2.2、2.3）', () => {
  beforeEach(() => setWideViewport());

  it('从左侧栏打开专家库，看详情和来源清单，向 TA 提问后新建绑定专家的问一问任务', async () => {
    let tasks: Task[] = [];
    const bound = makeTask({ title: '向内分泌与代谢专家提问', expertId: ENDO.id });
    let sse!: ReturnType<typeof controlledSse>;
    const api = mockApi({
      'GET /tasks': () => json(200, { tasks }),
      'GET /clients': () => json(200, { clients: CLIENTS }),
      'GET /skills': () => json(200, { skills: [SKILL] }),
      'GET /experts': () => json(200, { experts: EXPERTS }),
      [`GET /experts/${ENDO.id}`]: () => json(200, { expert: ENDO_DETAIL }),
      'POST /tasks': () => {
        tasks = [bound];
        return json(200, { task: bound });
      },
      [`POST ${MSG_PATH}`]: (_c, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
      [`GET /tasks/${ids.task}/expert-consultations`]: () =>
        json(200, { consultations: [consultation({ trigger: 'expert_center' })] }),
    });
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole('button', { name: '专家中心' }));
    const library = await screen.findByRole('list', { name: '专家库' });
    const card = within(library).getByRole('button', { name: '查看内分泌与代谢专家' });
    // 卡片：AI 标记、一句话擅长领域、知识来源待确认（仅供试用）
    expect(within(card).getByText('AI')).toBeInTheDocument();
    expect(within(card).getByText(ENDO.tagline)).toBeInTheDocument();
    expect(within(card).getByText('知识来源待医学顾问确认，仅供试用')).toBeInTheDocument();

    await user.click(card);
    expect(
      await screen.findByRole('heading', { level: 2, name: /内分泌与代谢专家/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText('我用过 7 次')).toBeInTheDocument();
    expect(screen.getByText('合成不负责：药物选择和剂量（转介内分泌科医生）')).toBeInTheDocument();
    expect(
      screen.getByText('由 AI 根据收录的指南生成意见，仅供健管师专业参考。'),
    ).toBeInTheDocument();
    // 来源按分组列出，列为来源文件原名、优先级、使用范围、确认状态
    const group = screen.getByRole('table', { name: '一、糖尿病' });
    expect(
      within(group)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['来源文件原名', '优先级', '使用范围', '确认状态']);
    const row = within(group).getByRole('row', { name: /合成诊疗共识（文件原名）/ });
    expect(within(row).getByText('2级 国内专家共识')).toBeInTheDocument();
    expect(within(row).getByText('只用于判断是否转介')).toBeInTheDocument();
    expect(within(row).getByText('待医学顾问核实')).toBeInTheDocument();
    // 颁布机构和版本只在已确认时显示
    expect(screen.getByText('合成学会 · 2024版')).toBeInTheDocument();
    expect(screen.getByText('一、糖尿病（2 条）')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '向 TA 提问' }));
    expect(
      await screen.findByText('向内分泌与代谢专家提问', { selector: 'p' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText('仅供健管师专业参考，非医疗诊断，请勿直接转发给客户')[0],
    ).toBeVisible();
    // 固定问一问：其他模式不能选
    expect(screen.getByRole('radio', { name: '问一问' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '做一做' })).toBeDisabled();
    // 专家中心的任务不能用技能
    await user.type(screen.getByRole('textbox'), '/');
    expect(screen.queryByRole('option', { name: SKILL.id })).not.toBeInTheDocument();
    expect(screen.getByText('没有匹配项')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox'));

    await user.type(screen.getByRole('textbox'), '合成问题：血糖偏高要关注什么');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', '/tasks')[0]?.body).toEqual({
      expertId: ENDO.id,
      title: '向内分泌与代谢专家提问',
    });
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'ask',
      content: '合成问题：血糖偏高要关注什么',
      clientRefs: [],
    });

    act(() => {
      sse.send({
        type: 'step',
        step: step({
          kind: 'consult_expert',
          labelKey: 'steps.consultExpert',
          expertIds: [ENDO.id],
        }),
      });
      sse.send(expertCall(ENDO.id, 'running'));
    });
    expect(await screen.findAllByText('正在请内分泌与代谢专家分析')).not.toHaveLength(0);
    expect(screen.getByTestId(`expert-call-${ENDO.id}`)).toHaveTextContent(
      '内分泌与代谢专家：进行中',
    );
    act(() => {
      sse.send(expertCall(ENDO.id, 'done'));
      sse.send({
        type: 'step',
        step: step({
          kind: 'consult_expert',
          labelKey: 'steps.consultExpert',
          expertIds: [ENDO.id],
          status: 'done',
          finishedAt: NOW,
        }),
      });
      sse.send({ type: 'text', messageId: ids.assistantMsg, delta: '**结论**\n合成专家回答' });
      sse.send({ type: 'consultation', consultationId: expertIds.consultation, status: 'done' });
      sse.send({ type: 'done', messageId: ids.assistantMsg, reason: 'complete' });
      sse.close();
    });
    expect(await screen.findByTestId(`expert-call-${ENDO.id}`)).toHaveTextContent(
      '内分泌与代谢专家：已回复',
    );
    expect(screen.getAllByText('已调用：内分泌与代谢专家').length).toBeGreaterThan(0);
    expect(screen.getByTestId('assistant-text')).toHaveTextContent('合成专家回答');
    // 专家的回答没有发给客户的入口（Q9）
    expect(screen.queryByRole('button', { name: /复制|导出/ })).not.toBeInTheDocument();

    // 任务列表里任务名前带专家头像（Q25），放在“未关联客户”分组
    const sidebar = screen.getByRole('complementary', { name: 'Health Buddy' });
    const unlinked = await within(sidebar).findByRole('group', { name: '未关联客户' });
    expect(
      within(unlinked).getByRole('img', { name: '专家：内分泌与代谢专家' }),
    ).toBeInTheDocument();

    // 一次调用结束后结果区出现专家标签
    await user.click(screen.getByRole('button', { name: '查看专家意见' }));
    expect(await screen.findByRole('tab', { name: '专家' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('专家预览没开（列表为空）时专家库显示空状态', async () => {
    mockApi({
      'GET /tasks': () => json(200, { tasks: [] }),
      'GET /clients': () => json(200, { clients: CLIENTS }),
      'GET /skills': () => json(200, { skills: [SKILL] }),
      'GET /experts': () => json(200, { experts: [] }),
    });
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(screen.getByRole('button', { name: '专家中心' }));
    expect(await screen.findByText('暂时没有可用的专家')).toBeInTheDocument();
  });
});

function renderPane(props: Partial<ChatPaneProps> = {}, experts: ExpertSummary[] = EXPERTS) {
  const all: ChatPaneProps = {
    narrow: false,
    onOpenMenu: () => {},
    resultsOpen: true,
    onToggleResults: () => {},
    task: makeTask({ clientId: ids.clientA }),
    skills: [SKILL, SKILL_AUTO],
    clients: CLIENTS,
    ...props,
  };
  return render(withExperts(<ChatPane {...all} />, experts));
}

async function mention(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(screen.getByRole('textbox'), `@${query}`);
  await user.click(screen.getByRole('option', { name }));
}

describe('@专家（规格 2.4、Q5、Q22）', () => {
  it('@ 列表里有专家组，最多 3 位；问一问里直接请专家，每位专家的状态单独更新，失败显示原因类别', async () => {
    let sse!: ReturnType<typeof controlledSse>;
    const api = mockApi({
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: () => json(200, { reports: [] }),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST ${MSG_PATH}`]: (_c, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
      [`GET /tasks/${ids.task}/expert-consultations`]: () =>
        json(200, {
          consultations: [
            consultation({
              status: 'partial',
              calls: [
                call(),
                call({
                  id: expertIds.callNutri,
                  expertId: NUTRI.id,
                  status: 'timeout',
                  failureCategory: 'timeout',
                  opinion: null,
                }),
              ],
            }),
          ],
        }),
    });
    const user = userEvent.setup();
    renderPane({ onOpenExperts: vi.fn() });
    await screen.findByRole('textbox');

    await user.type(screen.getByRole('textbox'), '@');
    const menu = screen.getByRole('listbox');
    expect(within(menu).getByText('专家')).toBeInTheDocument();
    expect(within(menu).getByRole('option', { name: /营养专家/ })).toHaveTextContent('AI');
    expect(within(menu).getByRole('option', { name: /营养专家/ })).toHaveTextContent(NUTRI.tagline);
    await user.clear(screen.getByRole('textbox'));

    await mention(user, '营', /营养专家/);
    await mention(user, '内分泌', /内分泌与代谢专家/);
    await mention(user, '心血管', /心血管专家/);
    expect(screen.getByRole('button', { name: '移除专家 营养专家' })).toBeInTheDocument();
    // 第 4 位不能选
    await user.type(screen.getByRole('textbox'), '@心理');
    const fourth = screen.getByRole('option', { name: /心理专家/ });
    expect(fourth).toHaveAttribute('aria-disabled', 'true');
    expect(fourth).toHaveTextContent('一条消息最多请 3 位专家');
    await user.click(fourth);
    expect(screen.queryByRole('button', { name: '移除专家 心理专家' })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: '移除专家 心血管专家' }));

    // 默认做一做、没有技能：提示切到问一问，不发送
    await user.type(screen.getByRole('textbox'), '合成问题');
    expect(
      screen.getByText('@专家 需要在问一问模式下直接提问，或配合会请专家的技能使用'),
    ).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '切换到问一问' }));
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'ask',
      content: '合成问题',
      clientRefs: [],
      expertRefs: [NUTRI.id, ENDO.id],
    });
    // 健管师消息上显示 @ 的专家
    const you = screen.getByRole('listitem', { name: '我' });
    expect(within(you).getByText('营养专家')).toBeInTheDocument();

    act(() => {
      sse.send({ type: 'step', step: step({ expertIds: [NUTRI.id, ENDO.id] }) });
      sse.send(expertCall(NUTRI.id, 'running'));
      sse.send(expertCall(ENDO.id, 'running'));
    });
    expect(await screen.findAllByText('正在请营养专家、内分泌与代谢专家分析')).not.toHaveLength(0);
    // 内分泌先回复：先显示“已回复”，营养专家仍在进行
    act(() => sse.send(expertCall(ENDO.id, 'done')));
    await waitFor(() =>
      expect(screen.getByTestId(`expert-call-${ENDO.id}`)).toHaveTextContent('已回复'),
    );
    expect(screen.getByTestId(`expert-call-${NUTRI.id}`)).toHaveTextContent('营养专家：进行中');
    act(() => sse.send(expertCall(NUTRI.id, 'timeout', 'timeout')));
    await waitFor(() =>
      expect(screen.getByTestId(`expert-call-${NUTRI.id}`)).toHaveTextContent(
        '营养专家：未能按时回复（超时）',
      ),
    );
    act(() => {
      sse.send({ type: 'consultation', consultationId: expertIds.consultation, status: 'partial' });
      sse.send({ type: 'done', messageId: ids.assistantMsg, reason: 'complete' });
      sse.close();
    });
    // 结束后取回调用详情；已回复的可以点开看原始意见
    await waitFor(() =>
      expect(api.callsTo('GET', `/tasks/${ids.task}/expert-consultations`)).toHaveLength(1),
    );
    expect(await screen.findByRole('button', { name: '查看专家意见' })).toBeInTheDocument();
  });

  it('技能不接入专家时提示“这个技能暂不调用专家”，不发送', async () => {
    const api = mockApi({
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
    });
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('textbox');
    await mention(user, '营', /营养专家/);
    await user.type(screen.getByRole('textbox'), '/');
    await user.click(screen.getByRole('option', { name: '客户近况小结' }));
    expect(screen.getByText('这个技能暂不调用专家，请移除 @ 的专家')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), '合成要求{Enter}');
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(0);
  });

  it('/体检解读 的专家选择条：一定要请、不要请只对这一条消息生效', async () => {
    let sse!: ReturnType<typeof controlledSse>;
    const api = mockApi({
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`POST ${MSG_PATH}`]: (_c, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
    });
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('textbox');
    await user.type(screen.getByRole('textbox'), '/');
    await user.click(screen.getByRole('option', { name: '体检解读' }));

    const bar = screen.getByRole('group', { name: '专家' });
    expect(within(bar).getByTestId('expert-selector-summary')).toHaveTextContent('自动选择');
    await user.click(within(bar).getByRole('button', { name: '调整' }));
    await user.click(
      within(within(bar).getByRole('group', { name: '内分泌与代谢专家 的选择' })).getByRole(
        'radio',
        { name: '一定要请' },
      ),
    );
    await user.click(
      within(within(bar).getByRole('group', { name: '营养专家 的选择' })).getByRole('radio', {
        name: '不要请',
      }),
    );
    expect(within(bar).getByTestId('expert-selector-summary')).toHaveTextContent(
      '一定要请：内分泌与代谢专家；不要请：营养专家',
    );
    // “一定要请”等同 @：输入框里出现专家标签
    expect(screen.getByRole('button', { name: '移除专家 内分泌与代谢专家' })).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), '合成要求{Enter}');
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'craft',
      content: '合成要求',
      skillId: SKILL_AUTO.id,
      clientRefs: [],
      expertRefs: [ENDO.id],
      excludedExperts: [NUTRI.id],
    });
    act(() => {
      sse.send({ type: 'done', messageId: ids.assistantMsg, reason: 'complete' });
      sse.close();
    });
    // 发送后清空：下一条消息又是自动选择
    await user.type(screen.getByRole('textbox'), '/');
    await user.click(screen.getByRole('option', { name: '体检解读' }));
    expect(screen.getByTestId('expert-selector-summary')).toHaveTextContent('自动选择');
  });

  it('刷新后从接口恢复每位专家的状态（规格 2.6）', async () => {
    mockApi({
      [`GET /tasks/${ids.task}`]: () =>
        json(200, {
          ...emptyDetail(),
          messages: [
            {
              id: ids.assistantMsg,
              role: 'assistant',
              mode: 'ask',
              content: '合成回答',
              skillId: null,
              clientRefs: [],
              reportRefs: [],
              expertRefs: [],
              excludedExperts: [],
              status: 'stopped',
              createdAt: NOW,
            },
          ],
          steps: [
            step({
              id: ids.step2,
              kind: 'route_experts',
              labelKey: 'steps.routeExperts',
              status: 'done',
            }),
            step({ seq: 1, expertIds: [ENDO.id, NUTRI.id], status: 'done' }),
          ],
        }),
      [`GET /tasks/${ids.task}/expert-consultations`]: () =>
        json(200, {
          consultations: [
            consultation({
              status: 'stopped',
              calls: [
                call(),
                call({
                  id: expertIds.callNutri,
                  expertId: NUTRI.id,
                  status: 'stopped',
                  opinion: null,
                }),
              ],
            }),
          ],
        }),
    });
    renderPane({ task: makeTask() });
    await waitFor(() =>
      expect(screen.getByTestId(`expert-call-${NUTRI.id}`)).toHaveTextContent('营养专家：已停止'),
    );
    expect(screen.getByTestId(`expert-call-${ENDO.id}`)).toHaveTextContent('已回复');
    expect(screen.getAllByText('已调用：内分泌与代谢专家、营养专家').length).toBeGreaterThan(0);
    // 选择专家步骤：已选择 2 位，展开后是原因类别和被排除的专家
    expect(screen.getByText('已选择 2 位专家')).toBeInTheDocument();
    expect(screen.getByText('内分泌与代谢专家：健管师指定')).toBeInTheDocument();
    expect(screen.getByText('营养专家：报告中空腹血糖高于参考范围')).toBeInTheDocument();
    expect(screen.getByText('按您的要求未请心血管专家')).toBeInTheDocument();
  });
});

describe('专家标签（规格 2.7、Q14、Q20）', () => {
  it('危机提示在最前面；列出汇总、分歧、原始意见和引用；“没用”只选原因类别', async () => {
    const api = mockApi({
      [`GET /experts/${ENDO.id}`]: () => json(200, { expert: ENDO_DETAIL }),
      [`GET /experts/${MENTAL.id}`]: () => json(404, { error: 'not_found' }),
      [`PUT /expert-calls/${expertIds.callEndo}/feedback`]: () =>
        new Response(null, { status: 204 }),
    });
    const c = consultation({
      trigger: 'skill_auto',
      synthesisStatus: 'done',
      synthesis: {
        consensus: [
          {
            point: '合成共识：关注饮食结构',
            experts: [ENDO.id],
            citations: [{ sourceId: 'S3', cardId: 'S3-01' }],
          },
        ],
        disagreements: [
          {
            topic: '是否需要就医评估',
            positions: [
              { expertId: ENDO.id, view: '合成观点：建议就医评估', citations: [] },
              { expertId: MENTAL.id, view: '合成观点：暂不需要', citations: [] },
            ],
            generatedByBackend: true,
          },
        ],
        referrals: [
          { expertId: ENDO.id, urgency: 'attention', to: '内分泌科医生', reason: '合成原因' },
        ],
        followUpPoints: ['合成关注点'],
        crisisSignal: true,
        emergencySignal: false,
        missingExperts: [],
      },
      calls: [
        call({
          opinion: opinion({
            referral: {
              needed: true,
              urgency: 'attention',
              to: '内分泌科医生',
              reason: '合成原因',
            },
          }),
        }),
        call({
          id: expertIds.callMental,
          expertId: MENTAL.id,
          opinion: opinion({ crisisSignal: true, findings: [], suggestions: [] }),
          removedFindings: 1,
        }),
      ],
    });
    const user = userEvent.setup();
    render(
      withExperts(
        <ExpertsTab state={{ status: 'ready', consultations: [c] }} onRetry={() => {}} />,
      ),
    );
    const card = screen.getByTestId('consultation');
    expect(card).toHaveTextContent('体检解读自动请专家');
    // 危机提示是展开内容的第一项
    const alerts = within(card).getAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('心理危机提示');
    expect(
      alerts[0]!.compareDocumentPosition(within(card).getByRole('region', { name: '汇总' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(card).getByText('合成共识：关注饮食结构（内分泌与代谢专家）'),
    ).toBeInTheDocument();
    expect(within(card).getByText('内分泌与代谢专家：建议就医评估')).toBeInTheDocument();
    const disagreements = within(card).getByRole('region', { name: '专家分歧（1 处）' });
    expect(disagreements).toHaveTextContent('有分歧不影响确认草稿');
    expect(disagreements).toHaveTextContent('心理专家：合成观点：暂不需要');
    expect(within(card).getByText('部分内容因依据无法核实已移除')).toBeInTheDocument();

    // 引用：未确认的卡片标“来源待确认”，点开看卡片要点
    const opinionCard = within(card).getByRole('article', { name: '内分泌与代谢专家' });
    await waitFor(() =>
      expect(
        within(opinionCard).getByRole('button', { name: '查看引用 S3-01' }),
      ).not.toHaveTextContent('来源待确认'),
    );
    expect(within(opinionCard).getByRole('button', { name: '查看引用 S1-01' })).toHaveTextContent(
      '来源待确认',
    );
    await user.click(within(opinionCard).getByRole('button', { name: '查看引用 S1-01' }));
    expect(within(opinionCard).getByText(/合成卡片要点：监测空腹血糖/)).toBeInTheDocument();

    // 反馈：没用 → 选原因类别 → 提交；没有自由文字输入框
    await user.click(within(opinionCard).getByRole('button', { name: '没用' }));
    expect(within(opinionCard).queryByRole('textbox')).not.toBeInTheDocument();
    const submit = within(opinionCard).getByRole('button', { name: '提交' });
    expect(submit).toBeDisabled();
    await user.click(within(opinionCard).getByRole('radio', { name: '引用不对' }));
    await user.click(submit);
    await waitFor(() =>
      expect(api.callsTo('PUT', `/expert-calls/${expertIds.callEndo}/feedback`)[0]?.body).toEqual({
        rating: 'not_useful',
        reason: 'bad_citation',
      }),
    );
    expect(await within(opinionCard).findByText('你选了“没用”（引用不对）')).toBeInTheDocument();
    // 没有任何发给客户的入口
    expect(screen.queryByRole('button', { name: /复制|导出|发送/ })).not.toBeInTheDocument();
  });

  it('失败的专家显示原因类别，没有反馈按钮', () => {
    mockApi({});
    render(
      withExperts(
        <ExpertsTab
          state={{
            status: 'ready',
            consultations: [
              consultation({
                calls: [
                  call({ status: 'failed', failureCategory: 'provider_error', opinion: null }),
                ],
              }),
            ],
          }}
          onRetry={() => {}}
        />,
      ),
    );
    expect(screen.getByText('暂时无法回复（AI 服务暂时不可用）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '有用' })).not.toBeInTheDocument();
  });
});

describe('审核栏的专家提示（规格 2.7、Q20、M3 合规审查）', () => {
  function renderView(props: Partial<ArtifactViewProps>) {
    const all: ArtifactViewProps = {
      detail: makeArtifactDetail({
        skillId: 'report-interpretation',
        consultationId: expertIds.consultation,
        crisisSignal: true,
        emergencySignal: true,
        content: {
          professional: '## 合成专业版\n- 合成要点',
          clientFacing: '合成通俗版。\n\n仅供参考，非医疗诊断',
        },
      }),
      readOnly: false,
      onDetail: () => {},
      onReload: () => {},
      onOpen: () => {},
      onChanged: () => {},
      onReadOnly: () => {},
      onBack: () => {},
      ...props,
    };
    return render(withExperts(<ArtifactView {...all} />));
  }

  it('危机和急症信号在审核栏最前面；分歧和缺少转介只提示，不拦截确认', async () => {
    mockApi({});
    const onOpenExperts = vi.fn();
    const user = userEvent.setup();
    renderView({
      onOpenExperts,
      consultation: consultation({
        synthesis: {
          consensus: [],
          disagreements: [
            { topic: '合成分歧', positions: [], generatedByBackend: false },
            { topic: '合成分歧二', positions: [], generatedByBackend: false },
          ],
          referrals: [{ expertId: ENDO.id, urgency: 'attention', to: null, reason: null }],
          followUpPoints: [],
          crisisSignal: false,
          emergencySignal: false,
          missingExperts: [],
        },
        calls: [call(), call({ id: expertIds.callNutri, expertId: NUTRI.id })],
      }),
    });
    const bar = screen.getByRole('region', { name: '审核' });
    const alerts = within(bar).getAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('心理危机提示');
    expect(alerts[1]).toHaveTextContent('疑似急症提示');
    // 不能关掉：提示旁边没有关闭按钮
    expect(within(bar).queryByRole('button', { name: /关闭|知道了/ })).not.toBeInTheDocument();
    expect(
      within(bar).getByText('本次调用了 2 位专家，有 2 处分歧，请在专家标签查看'),
    ).toBeInTheDocument();
    expect(within(bar).getByText(/专家建议转介，但专业版里没有就医或转介建议/)).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: '确认' })).toBeEnabled();
    await user.click(within(bar).getByRole('button', { name: '查看专家标签' }));
    expect(onOpenExperts).toHaveBeenCalledWith(expertIds.consultation);
  });

  it('专业版写了转介建议时不提示缺少转介', () => {
    mockApi({});
    renderView({
      detail: makeArtifactDetail({
        consultationId: expertIds.consultation,
        content: {
          professional: '## 合成专业版\n\n## 就医或转介建议\n建议内分泌科评估',
          clientFacing: '合成通俗版。\n\n仅供参考，非医疗诊断',
        },
      }),
      consultation: consultation({
        calls: [
          call({
            opinion: opinion({
              referral: { needed: true, urgency: 'attention', to: null, reason: null },
            }),
          }),
        ],
      }),
    });
    expect(
      screen.getByText('本次调用了 1 位专家，有 0 处分歧，请在专家标签查看'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/专家建议转介，但专业版里没有/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hasReferralSection 只认标题下面有内容的转介小节', () => {
    expect(hasReferralSection('## 就医或转介建议\n内容', '就医或转介建议')).toBe(true);
    expect(hasReferralSection('## 就医或转介建议\n\n## 下一节\n内容', '就医或转介建议')).toBe(
      false,
    );
    expect(hasReferralSection('没有这一节', '就医或转介建议')).toBe(false);
  });
});
