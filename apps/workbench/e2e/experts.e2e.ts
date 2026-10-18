import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  ClientSummary,
  CurrentUser,
  ExpertConsultation,
  ExpertDetail,
  ExpertSummary,
  SkillSummary,
  Task,
  TaskDetailResponse,
  TaskStep,
  TaskStreamEvent,
} from '@health-buddy/shared';

/**
 * M3 工作台界面在手机宽度（375px）下：专家库 → 向专家提问 → 执行步骤和回答；任务里 @专家；
 * 专家标签的危机提示。接口全部在浏览器里模拟，只用合成数据；长名称检查不会把页面撑宽。
 */

const NOW = '2026-10-18T08:00:00.000Z';
const LONG_LATIN = 'SyntheticGuidelineDocumentNameWithoutAnySpacesForWrappingChecks';
const ids = {
  manager: '30000000-0000-4000-8000-000000000001',
  operator: '30000000-0000-4000-8000-000000000002',
  org: '30000000-0000-4000-8000-000000000003',
  client: '20000000-0000-4000-8000-00000000000a',
  boundTask: '10000000-0000-4000-8000-0000000000b1',
  task: '10000000-0000-4000-8000-000000000001',
  manager1: '40000000-0000-4000-8000-000000000001',
  assistant1: '40000000-0000-4000-8000-000000000002',
  step: '50000000-0000-4000-8000-000000000001',
  consultation: '90000000-0000-4000-8000-0000000000c1',
  call1: '90000000-0000-4000-8000-0000000000e1',
  call2: '90000000-0000-4000-8000-0000000000e2',
};

const user: CurrentUser = {
  id: ids.manager,
  email: 'manager@test.example',
  displayName: '合成健管师',
  role: 'manager',
  operator: { id: ids.operator, name: '合成协会', brandColor: null },
  orgId: ids.org,
};
const client: ClientSummary = {
  id: ids.client,
  displayName: '合成客户甲（测试）',
  gender: 'female',
  birthYear: 1968,
  managerId: ids.manager,
  isSynthetic: true,
};
const endo: ExpertSummary = {
  id: 'endocrine-metabolism',
  name: '内分泌与代谢专家',
  tagline: '血糖、血脂、尿酸、甲状腺功能和体重相关指标的解读要点',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
const nutrition: ExpertSummary = {
  id: 'nutrition',
  name: '营养专家',
  tagline: '结合客户数据给出饮食方面的建议要点',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
const mental: ExpertSummary = {
  id: 'mental-health',
  name: '心理专家',
  tagline: '帮助健管师理解客户的情绪、压力和睡眠情况并做好支持和转介',
  version: '0.1.0',
  status: 'review',
  available: true,
  sourcesPending: true,
};
const experts = [endo, nutrition, mental];
const endoDetail: ExpertDetail = {
  ...endo,
  strengths: ['合成擅长：血糖和血脂之间的关联'],
  outOfScope: ['合成不负责：药物选择、剂量和调整（转介内分泌科医生）'],
  sources: Array.from({ length: 6 }, (_, i) => ({
    sourceId: `S${i + 1}`,
    name: `合成指南第${i + 1}份 ${LONG_LATIN}`,
    section: i < 3 ? '一、糖尿病及并发症' : '二、血脂异常',
    publisher: null,
    version: null,
    priority: ((i % 3) + 1) as 1 | 2 | 3,
    scope: i === 0 ? ('advice' as const) : ('referral_only' as const),
    status: 'candidate' as const,
  })),
  cards: [],
  myUsageCount: 3,
};
const skills: SkillSummary[] = [
  {
    id: 'report-interpretation',
    requiresClient: true,
    modes: ['plan', 'craft'],
    clientFacing: true,
    involvesHealthJudgment: true,
    requiresReport: true,
    usesReport: true,
    allowsEmptyRequest: false,
    planSkills: [],
    experts: 'auto',
  },
];
const boundTask: Task = {
  id: ids.boundTask,
  title: '向内分泌与代谢专家提问',
  clientId: null,
  archived: false,
  detachedReason: null,
  expertId: endo.id,
  createdAt: NOW,
  updatedAt: NOW,
};
const task: Task = {
  id: ids.task,
  title: '合成客户甲的随访',
  clientId: ids.client,
  archived: false,
  detachedReason: null,
  expertId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function step(overrides: Partial<TaskStep>): TaskStep {
  return {
    id: ids.step,
    messageId: ids.assistant1,
    seq: 0,
    kind: 'consult_experts',
    labelKey: 'steps.consultExperts',
    expertIds: [],
    labelDate: null,
    status: 'done',
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

const sse = (events: TaskStreamEvent[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** 专家标签用的调用：心理专家标出危机信号，两位专家有一处分歧 */
function consultationFor(taskId: string): ExpertConsultation {
  return {
    id: ids.consultation,
    taskId,
    messageId: ids.assistant1,
    trigger: 'mention',
    status: 'done',
    routing: {
      selected: [
        { expertId: endo.id, selectedReason: 'manager', reasons: [{ kind: 'manager' }] },
        { expertId: mental.id, selectedReason: 'manager', reasons: [{ kind: 'manager' }] },
      ],
      excluded: [],
      overCap: [],
      ruleOnly: false,
    },
    synthesisStatus: 'done',
    crisisSignal: true,
    emergencySignal: false,
    synthesis: {
      consensus: [
        {
          point: `合成共识：先了解近期作息和饮食 ${LONG_LATIN}`,
          experts: [endo.id, mental.id],
          citations: [],
        },
      ],
      disagreements: [
        {
          topic: '是否需要就医评估',
          positions: [
            { expertId: endo.id, view: '合成观点：建议就医评估', citations: [] },
            { expertId: mental.id, view: '合成观点：先由心理咨询师评估', citations: [] },
          ],
          generatedByBackend: true,
        },
      ],
      referrals: [
        { expertId: mental.id, urgency: 'urgent', to: '心理咨询师或精神科医生', reason: null },
      ],
      followUpPoints: [],
      crisisSignal: true,
      emergencySignal: false,
      missingExperts: [],
    },
    calls: [endo.id, mental.id].map((expertId, i) => ({
      id: i === 0 ? ids.call1 : ids.call2,
      expertId,
      expertVersion: '0.1.0',
      selectedReason: 'manager' as const,
      status: 'done' as const,
      failureCategory: null,
      opinion: {
        inScope: true,
        outOfScopeNote: null,
        summary: `合成结论 ${LONG_LATIN}`,
        findings: [
          {
            point: '合成要点：最近情绪低落',
            basis: 'data_only' as const,
            dataRefs: [{ label: '空腹血糖', value: '6.5 mmol/L', date: '2026-09-12' }],
            citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
          },
        ],
        suggestions: [],
        referral: { needed: false, urgency: null, to: null, reason: null },
        questionsToAsk: [],
        dataGaps: [],
        crisisSignal: expertId === mental.id,
        emergencySignal: false,
      },
      removedFindings: 0,
      feedback: null,
      startedAt: NOW,
      finishedAt: NOW,
    })),
    createdAt: NOW,
    finishedAt: NOW,
  };
}

interface Mock {
  unknown: string[];
  posted: { path: string; body: unknown }[];
}

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = { unknown: [], posted: [] };
  let tasks: Task[] = [task];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const detail = (t: Task): TaskDetailResponse => ({
    task: t,
    messages: [],
    steps: [],
    plans: [],
    artifacts: [],
    uploads: [],
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const key = `${req.method()} ${url.pathname}${url.search}`;
      if (req.method() === 'POST')
        mock.posted.push({ path: url.pathname, body: req.postDataJSON() });
      switch (true) {
        case key === 'GET /api/auth/me':
          return json(route, { user });
        case key === 'GET /api/tasks':
          return json(route, { tasks });
        case key === 'GET /api/tasks?archived=true':
          return json(route, { tasks: [] });
        case key === 'GET /api/clients':
          return json(route, { clients: [client] });
        case key === 'GET /api/skills':
          return json(route, { skills });
        case key === 'GET /api/experts':
          return json(route, { experts });
        case key === `GET /api/experts/${endo.id}`:
          return json(route, { expert: endoDetail });
        case key.startsWith('GET /api/experts/'):
          return json(route, { error: 'not_found' }, 404);
        case key === 'POST /api/tasks':
          tasks = [boundTask, task];
          return json(route, { task: boundTask });
        case key === `GET /api/tasks/${ids.task}`:
          return json(route, detail(task));
        case key === `GET /api/tasks/${ids.boundTask}`:
          return json(route, detail(boundTask));
        case key === `GET /api/clients/${ids.client}/reports`:
          return json(route, { reports: [] });
        case key === `GET /api/clients/${ids.client}/report-uploads`:
          return json(route, { uploads: [] });
        case key === `GET /api/tasks/${ids.boundTask}/expert-consultations`:
          return json(route, { consultations: [consultationFor(ids.boundTask)] });
        case key === `GET /api/tasks/${ids.task}/expert-consultations`:
          // 发送 @专家 之前还没有调用
          return json(route, {
            consultations: mock.posted.some((p) => p.path.endsWith('/messages'))
              ? [consultationFor(ids.task)]
              : [],
          });
        case key.endsWith('/messages') && req.method() === 'POST': {
          const body = req.postDataJSON() as { expertRefs?: string[] };
          const expertIds = body.expertRefs?.length ? body.expertRefs : [endo.id];
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: sse([
              {
                type: 'step',
                step: step({
                  kind: expertIds.length === 1 ? 'consult_expert' : 'consult_experts',
                  labelKey: expertIds.length === 1 ? 'steps.consultExpert' : 'steps.consultExperts',
                  expertIds,
                }),
              },
              ...expertIds.map((expertId): TaskStreamEvent => ({
                type: 'expert_call',
                consultationId: ids.consultation,
                expertId,
                status: 'done',
                failureCategory: null,
              })),
              {
                type: 'text',
                messageId: ids.assistant1,
                delta: `**结论**\n合成专家回答 ${LONG_LATIN}\n\n仅供健管师专业参考，非医疗诊断，请勿直接转发给客户`,
              },
              {
                type: 'consultation',
                consultationId: ids.consultation,
                status: 'done',
                crisisSignal: true,
                emergencySignal: false,
              },
              { type: 'done', messageId: ids.assistant1, reason: 'complete' },
            ]),
          });
        }
        default:
          mock.unknown.push(key);
          return json(route, { error: 'not_found' }, 404);
      }
    },
  );
  return mock;
}

async function expectNoHorizontalScroll(page: Page, where: string) {
  // 移动端侧栏/结果面板有滑入动画，等所有动画结束再量尺寸
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(sizes.doc, `${where}: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.body, `${where}: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport);
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main *, [role="tabpanel"] *')]
      .filter((el) => {
        if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${el.textContent?.slice(0, 20) ?? ''}`),
  );
  expect(outside, `${where}: elements past the right edge`).toEqual([]);
}

test('专家库 → 向专家提问 → 执行步骤和回答（375px）', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '专家中心' }).click();

  const library = page.getByRole('list', { name: '专家库' });
  await expect(library.getByRole('button', { name: '查看内分泌与代谢专家' })).toBeVisible();
  await expect(library.getByText('知识来源待医学顾问确认，仅供试用').first()).toBeVisible();
  await expectNoHorizontalScroll(page, 'library');
  // 手机上为单列卡片
  const boxes = await library
    .getByRole('listitem')
    .evaluateAll((items) => items.map((el) => el.getBoundingClientRect().x));
  expect(new Set(boxes.map(Math.round)).size).toBe(1);

  await library.getByRole('button', { name: '查看内分泌与代谢专家' }).click();
  await expect(page.getByText('我用过 3 次')).toBeVisible();
  const table = page.getByRole('table', { name: '一、糖尿病及并发症' });
  await expect(table.getByText('来源文件原名').first()).toBeAttached();
  await expect(table.getByText(/合成指南第1份/)).toBeVisible();
  await expectNoHorizontalScroll(page, 'expert detail');

  await page.getByRole('button', { name: '向 TA 提问' }).click();
  await expect(page.getByText('向内分泌与代谢专家提问', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('radio', { name: '问一问' })).toBeChecked();
  await page.getByRole('textbox').fill('合成问题：血糖偏高要关注什么');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByTestId(`expert-call-${endo.id}`)).toHaveText('内分泌与代谢专家：已回复');
  await expect(page.getByText('已调用：内分泌与代谢专家').first()).toBeVisible();
  await expect(page.getByTestId('assistant-text')).toContainText('合成专家回答');
  await expect(
    page.getByText('仅供健管师专业参考，非医疗诊断，请勿直接转发给客户').first(),
  ).toBeVisible();
  expect(mock.posted.find((p) => p.path === '/api/tasks')?.body).toEqual({
    expertId: endo.id,
    title: '向内分泌与代谢专家提问',
  });
  await expectNoHorizontalScroll(page, 'expert answer');
});

test('任务里 @专家（375px）', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page
    .getByRole('button', { name: /合成客户甲的随访/ })
    .first()
    .click();
  const box = page.getByRole('textbox');
  await box.fill('@营');
  await page.getByRole('option', { name: /营养专家/ }).click();
  await box.fill('@心理');
  await page.getByRole('option', { name: /心理专家/ }).click();
  await expect(page.getByRole('button', { name: '移除专家 营养专家' })).toBeVisible();
  await page.getByRole('radio', { name: '问一问' }).click();
  await box.fill('合成问题：最近睡不好');
  await expectNoHorizontalScroll(page, 'composer with experts');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByTestId(`expert-call-${nutrition.id}`)).toHaveText('营养专家：已回复');
  await expect(page.getByTestId(`expert-call-${mental.id}`)).toHaveText('心理专家：已回复');
  await expect(page.getByText('已调用：营养专家、心理专家').first()).toBeVisible();
  const sent = mock.posted.find((p) => p.path.endsWith('/messages'))?.body;
  expect(sent).toMatchObject({ mode: 'ask', expertRefs: [nutrition.id, mental.id] });
  await expectNoHorizontalScroll(page, 'steps');
});

test('专家标签：危机提示在最前面（375px）', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page
    .getByRole('button', { name: /合成客户甲的随访/ })
    .first()
    .click();
  const box = page.getByRole('textbox');
  await box.fill('@心理');
  await page.getByRole('option', { name: /心理专家/ }).click();
  await page.getByRole('radio', { name: '问一问' }).click();
  await box.fill('合成问题');
  await page.getByRole('button', { name: '发送' }).click();
  // 对话区的回答最前面也有危机提示，正文按 Markdown 显示，写明参与的专家
  const answer = page.getByRole('listitem', { name: 'AI 助手' }).last();
  await expect(answer.getByRole('alert').first()).toContainText('心理危机提示');
  await expect(answer.getByTestId('answered-by')).toContainText('专家意见：');
  await expect(answer.getByTestId('assistant-text')).not.toContainText('**');
  await expectNoHorizontalScroll(page, 'chat with crisis alert');
  await page.getByRole('button', { name: '查看专家意见' }).click();

  const panel = page.getByRole('tabpanel');
  await expect(page.getByRole('tab', { name: '专家' })).toHaveAttribute('aria-selected', 'true');
  const crisis = panel.getByRole('alert').first();
  await expect(crisis).toContainText('心理危机提示');
  await expect(panel.getByRole('region', { name: '专家分歧（1 处）' })).toBeVisible();
  // 危机提示在汇总之前
  const crisisBox = await crisis.boundingBox();
  const summaryBox = await panel.getByRole('region', { name: '汇总' }).boundingBox();
  expect(crisisBox!.y).toBeLessThan(summaryBox!.y);
  await expect(panel.getByRole('button', { name: '查看引用 S1-01' }).first()).toContainText(
    '来源待确认',
  );
  await expectNoHorizontalScroll(page, 'experts tab');
});
