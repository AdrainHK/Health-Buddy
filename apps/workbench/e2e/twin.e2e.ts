import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  ArtifactDetailResponse,
  ArtifactSummary,
  ClientSummary,
  CurrentUser,
  FollowUpItem,
  SkillSummary,
  Task,
  TaskDetailResponse,
  TwinDomainView,
  TwinForecast,
  TwinForecastDetailResponse,
  TwinResponse,
  TwinTimelineResponse,
} from '@health-buddy/shared';

/**
 * M4 工作台孪生（规格 2.1–2.6，验收标准 1、12、31）在手机宽度（375px）下：
 * 左侧栏点客户 → 底部面板打开“客户 · 孪生” → 点小图看大图；今日跟进 → 处理一项。
 * 接口全部在浏览器里模拟，不需要后端和模型；只用合成数据，长名称检查不会把页面撑宽。
 */

const NOW = '2026-10-18T08:00:00.000Z';
const LONG_LATIN = 'SyntheticClientNameWithoutAnySpacesForWrappingChecksInTheTwinView';
const ids = {
  manager: '30000000-0000-4000-8000-000000000001',
  operator: '30000000-0000-4000-8000-000000000002',
  org: '30000000-0000-4000-8000-000000000003',
  client: '20000000-0000-4000-8000-00000000000a',
  task: '10000000-0000-4000-8000-000000000001',
  record: 'c0000000-0000-4000-8000-000000000001',
  forecast: 'd0000000-0000-4000-8000-000000000001',
  follow: 'e0000000-0000-4000-8000-000000000001',
  visit: 'a3000000-0000-4000-8000-000000000001',
  plan: 'a1000000-0000-4000-8000-000000000001',
  goal: 'a2000000-0000-4000-8000-000000000001',
  visitRecord: 'a4000000-0000-4000-8000-000000000001',
  recipe: 'a5000000-0000-4000-8000-000000000001',
  exercise: 'a6000000-0000-4000-8000-000000000001',
  artifact: '70000000-0000-4000-8000-000000000001',
  event: '80000000-0000-4000-8000-000000000001',
  report: 'f0000000-0000-4000-8000-000000000001',
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
  displayName: `合成客户甲 ${LONG_LATIN}`,
  gender: 'female',
  birthYear: 1968,
  managerId: ids.manager,
  isSynthetic: true,
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
const skills: SkillSummary[] = [];
/** M5：一份方案草稿（结构化内容编辑器在手机宽度下不横向滚动） */
const planArtifact: ArtifactSummary = {
  id: ids.artifact,
  taskId: ids.task,
  skillId: 'care-plan',
  version: 1,
  status: 'draft',
  hasCriticalFlags: false,
  createdAt: NOW,
  sourceReportDate: null,
  sourceFileName: null,
};
const planArtifactDetail: ArtifactDetailResponse = {
  artifact: {
    ...planArtifact,
    clientId: ids.client,
    parentId: null,
    content: {
      professional: '## 合成方案专业版',
      clientFacing: '合成方案通俗版\n\n仅供参考，非医疗诊断',
    },
    contentHash: 'hash-1',
    criticalFlags: [],
    sourceReportId: null,
    riskTierSuggestion: null,
    clientFacing: true,
    consultationId: null,
    emergencySignal: false,
    crisisSignal: false,
    structured: {
      sections: [
        { section: 'diet', professional: '合成', clientFacing: '合成', goals: [] },
        {
          section: 'exercise',
          professional: '合成',
          clientFacing: '合成',
          goals: [{ templateId: ids.goal, params: { steps: 7000 } }],
        },
      ],
      recipes: [{ day: 1, meal: 'breakfast', recipeId: ids.recipe }],
      exercises: [{ exerciseId: ids.exercise, frequencyPerWeek: 3, minutes: 20 }],
    },
    planOptions: { sections: ['diet', 'exercise'], cycleWeeks: 8 },
  },
  sourceReport: null,
  hints: { judgementHints: [], criticalValueMentions: [], riskTierMentions: [] },
  versions: [planArtifact],
  events: [
    {
      id: ids.event,
      artifactId: ids.artifact,
      actorId: null,
      action: 'created',
      reason: null,
      format: null,
      createdAt: NOW,
    },
  ],
};

const detail: TaskDetailResponse = {
  task,
  messages: [],
  steps: [],
  plans: [],
  artifacts: [planArtifact],
  uploads: [],
};

function domain(d: TwinDomainView['domain'], level: TwinDomainView['level']): TwinDomainView {
  return {
    domain: d,
    level,
    computed:
      level === 'unknown'
        ? null
        : {
            id: ids.record,
            domain: d,
            level,
            origin: 'computed',
            basis:
              d === 'metabolic'
                ? [
                    {
                      source: 'report',
                      metric: 'fpg',
                      value: 6.5,
                      unit: 'mmol/L',
                      observedOn: '2026-09-12',
                      outcome: 'yellow',
                      hits: [
                        {
                          ruleId: 'r1',
                          method: 'out_of_reference',
                          level: 'yellow',
                          snapshot: { refLow: 3.9, refHigh: 6.1, abnormal: 'high' },
                        },
                      ],
                      reportId: ids.report,
                      indicatorId: 'i1',
                      refLow: 3.9,
                      refHigh: 6.1,
                      noReference: false,
                    },
                  ]
                : [],
            rulesVersion: 3,
            reason: null,
            manualExpires: null,
            trigger: 'report_verified',
            setBy: null,
            setByName: null,
            createdAt: NOW,
          },
    manual: null,
    manualExpiredByNewData: false,
    previousLevel: level === 'yellow' ? 'green' : null,
    changedAt: level === 'yellow' ? '2026-10-02T00:00:00.000Z' : null,
  };
}

const forecast: TwinForecast = {
  id: ids.forecast,
  metric: 'sbp',
  source: 'monitoring',
  methodVersion: 'ols-linear-v1',
  intervalLevel: 0.8,
  status: 'ok',
  insufficientReason: null,
  pointsNeeded: null,
  nPoints: 26,
  spanDays: 182,
  horizonMonths: 6,
  uncertainty: 'high',
  basis: { kind: 'weekly_averages', from: '2026-04-20', to: '2026-10-12', anchor: '2026-10-15' },
  points: [
    { monthsAhead: 3, date: '2027-01-15', mid: 136, low: 124, high: 148, clipped: false },
    { monthsAhead: 6, date: '2027-04-15', mid: 142, low: 122, high: 162, clipped: false },
  ],
  computedAt: NOW,
};
const insufficient: TwinForecast = {
  ...forecast,
  id: 'd0000000-0000-4000-8000-000000000002',
  metric: 'fpg',
  source: 'report',
  status: 'insufficient_data',
  insufficientReason: 'too_few_points',
  pointsNeeded: 2,
  uncertainty: null,
  horizonMonths: null,
  basis: null,
  points: [],
};

const twin: TwinResponse = {
  client,
  domains: [
    domain('metabolic', 'yellow'),
    domain('cardiovascular', 'green'),
    domain('sleep', 'unknown'),
    domain('weight', 'green'),
  ],
  riskTier: null,
  forecasts: [forecast, insufficient],
  openFollowUpCount: 1,
  hasOpenCritical: true,
  computing: false,
  hasData: true,
};

const sbpDetail: TwinForecastDetailResponse = {
  metric: 'sbp',
  unit: 'mmHg',
  actual: Array.from({ length: 26 }, (_, i) => ({
    at: new Date(Date.parse('2026-04-20T08:00:00.000Z') + i * 7 * 86_400_000).toISOString(),
    value: 122 + i * 0.4,
    source: 'monitoring' as const,
    manual: false,
  })),
  forecasts: [forecast],
  reference: { low: 90, high: 140 },
};
const fpgDetail: TwinForecastDetailResponse = {
  metric: 'fpg',
  unit: 'mmol/L',
  actual: [{ at: '2026-09-12T00:00:00.000Z', value: 6.5, source: 'report', manual: false }],
  forecasts: [insufficient],
  reference: { low: 3.9, high: 6.1 },
};

const followUp: FollowUpItem = {
  id: ids.follow,
  clientId: ids.client,
  clientName: client.displayName,
  kind: 'critical',
  severity: 1,
  domain: 'cardiovascular',
  metric: 'sbp',
  basis: {
    source: 'monitoring',
    metric: 'sbp',
    value: 182,
    unit: 'mmHg',
    observedOn: '2026-10-17',
    rule: { comparator: 'gte', value: 180, level: 'urgent' },
  },
  status: 'open',
  snoozeUntil: null,
  resolution: null,
  dismissReason: null,
  note: null,
  firstTriggeredAt: '2026-10-17T02:00:00.000Z',
  lastTriggeredAt: '2026-10-17T02:00:00.000Z',
  carriedDays: 1,
  consultedAt: null,
  resolvedAt: null,
};

const timeline: TwinTimelineResponse = {
  events: [
    {
      type: 'status_change',
      id: 'status:1',
      at: '2026-10-02T00:00:00.000Z',
      domain: 'metabolic',
      from: 'green',
      to: 'yellow',
      origin: 'computed',
      trigger: 'report_verified',
    },
    {
      type: 'health_history',
      id: 'history:1',
      at: '2026-09-01T00:00:00.000Z',
      category: 'lifestyle',
      summary: `合成记录：每周快走三次。${LONG_LATIN}`,
      action: 'created',
    },
  ],
  nextBefore: null,
};

/** M5：一次逾期的随访、一份生效方案、一条随访记录、一份食谱（长名称检查不会把页面撑宽） */
const visit = {
  id: ids.visit,
  clientId: ids.client,
  dueDate: '2026-10-16',
  method: 'phone',
  purpose: 'routine',
  focus: `了解晚饭后散步的情况 ${LONG_LATIN}`,
  origin: 'schedule',
  status: 'planned',
  cancelReason: null,
  note: null,
  carePlanId: null,
  followUpItemId: null,
  recordId: null,
  rescheduledFrom: null,
  doneAt: null,
  createdAt: NOW,
};
const planSummary = {
  id: ids.plan,
  clientId: ids.client,
  artifactId: null,
  sections: ['exercise'],
  cycleWeeks: 8,
  startDate: '2026-10-01',
  reviewDate: '2026-11-26',
  status: 'active',
  endReason: null,
  approvedAt: NOW,
  endedAt: null,
};
const plan = {
  ...planSummary,
  snapshot: {
    structured: {
      sections: [
        {
          section: 'exercise',
          professional: '合成',
          clientFacing: '合成',
          goals: [{ templateId: ids.goal, params: { steps: 7000 } }],
        },
      ],
      recipes: [],
      exercises: [],
    },
    content: { professional: '## 合成方案', clientFacing: '合成通俗版\n\n仅供参考，非医疗诊断' },
    libraryVersions: [],
  },
};
const goalTemplate = {
  id: ids.goal,
  version: 1,
  code: 'daily_steps',
  section: 'exercise',
  text: '每天步行 {steps} 步',
  params: [{ name: 'steps', type: 'int', min: 4000, max: 10000, default: 6000, unit: '步' }],
  metric: 'steps',
  metricParam: 'steps',
  sourceNote: '合成来源说明',
};
const exercise = {
  id: ids.exercise,
  version: 1,
  code: 'brisk_walk',
  name: `合成快走 ${LONG_LATIN.slice(0, 50)}`,
  category: 'aerobic',
  intensity: 'moderate',
  setting: ['outdoor'],
  equipment: [],
  steps: ['抬头挺胸'],
  keyPoints: ['微微出汗、能说话'],
  commonMistakes: [],
  managerCautions: '合成注意事项',
  met: null,
  sourceNote: '合成来源说明',
};
const recipe = {
  id: ids.recipe,
  version: 1,
  code: 'oat_porridge',
  name: `合成燕麦粥 ${LONG_LATIN.slice(0, 50)}`,
  mealTypes: ['breakfast'],
  ingredients: [{ name: '燕麦', householdAmount: '半碗', grams: 40, overseasAlternative: null }],
  steps: [`燕麦加水煮软 ${LONG_LATIN}`],
  nutritionPerServing: null,
  nutritionBasis: null,
  tags: ['high_fiber'],
  allergens: ['gluten'],
  sourceNote: '合成来源说明',
};

async function mockApi(page: Page) {
  const patches: unknown[] = [];
  let done = false;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const key = `${req.method()} ${url.pathname}`;
      const items = done ? [] : [followUp];
      const list = {
        items,
        openCount: items.length,
        date: '2026-10-18',
        timeZone: 'Asia/Shanghai',
      };
      switch (true) {
        case key === 'GET /api/auth/me':
          return json(route, { user });
        case key === 'GET /api/tasks':
          return json(route, { tasks: url.search ? [] : [task] });
        case key === 'GET /api/clients':
          return json(route, { clients: [client] });
        case key === 'GET /api/skills':
          return json(route, { skills });
        case key === `GET /api/tasks/${ids.task}`:
          return json(route, detail);
        case key === 'GET /api/critical-thresholds':
          return json(route, {
            thresholds: [
              {
                id: 'b0000000-0000-4000-8000-000000000001',
                metric: 'sbp',
                comparator: 'gte',
                value: 180,
                level: 'urgent',
                enabled: true,
                updatedBy: null,
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            ],
          });
        case key === 'GET /api/twin/levels':
          return json(route, { clients: [{ clientId: ids.client, level: 'yellow' }] });
        case key === 'GET /api/follow-ups':
          return json(route, list);
        case key === 'GET /api/visits/today':
          return json(route, {
            items: [{ ...visit, clientName: client.displayName, overdueDays: 2 }],
            count: 1,
            date: '2026-10-18',
            timeZone: 'Asia/Shanghai',
          });
        case key === 'GET /api/visits':
          return json(route, { visits: [visit] });
        case key === `GET /api/clients/${ids.client}/care-plans`:
          return json(route, { current: planSummary, history: [] });
        case key === `GET /api/care-plans/${ids.plan}`:
          return json(route, { plan });
        case key === `GET /api/clients/${ids.client}/care-plans/current/adherence`:
          return json(route, { adherence: null });
        case key === `GET /api/clients/${ids.client}/visit-records`:
          return json(route, {
            records: [
              {
                id: ids.visitRecord,
                clientId: ids.client,
                visitId: null,
                visitDate: '2026-10-10',
                method: 'wechat',
                excerpt: `合成客户说最近晚饭后散步 ${LONG_LATIN}`,
                approvedAt: NOW,
              },
            ],
          });
        case key === 'GET /api/plan-library/goal-templates':
          return json(route, { items: [goalTemplate] });
        case key === 'GET /api/plan-library/recipes':
          return json(route, { items: [recipe] });
        case key === 'GET /api/plan-library/exercises':
          return json(route, { items: [exercise] });
        case key === `GET /api/artifacts/${ids.artifact}`:
          return json(route, planArtifactDetail);
        case key === `GET /api/clients/${ids.client}/visit-materials`:
          return json(route, { materials: [], consentRecorded: true });
        case key === `PATCH /api/follow-ups/${ids.follow}`:
          patches.push(req.postDataJSON());
          done = true;
          return json(route, { item: { ...followUp, status: 'done' } });
        case key === `GET /api/clients/${ids.client}/twin`:
          return json(route, { ...twin, hasOpenCritical: !done });
        case key === `GET /api/clients/${ids.client}/twin/forecasts/sbp`:
          return json(route, sbpDetail);
        case key === `GET /api/clients/${ids.client}/twin/forecasts/fpg`:
          return json(route, fpgDetail);
        case key === `GET /api/clients/${ids.client}/twin/timeline`:
          return json(route, timeline);
        case key === `GET /api/clients/${ids.client}/report-uploads`:
          return json(route, { uploads: [] });
        case key === `GET /api/clients/${ids.client}/manual-readings`:
          return json(route, { readings: [] });
        default:
          return json(route, { error: 'not_found' }, 404);
      }
    },
  );
  return patches;
}

/** 页面和结果区都没有横向滚动，没有元素伸到视口右边以外 */
async function expectNoHorizontalScroll(
  page: Page,
  where: string,
  scope = '[role="tabpanel"] *, [role="dialog"] *, main *',
) {
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(sizes.doc, `${where}: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.body, `${where}: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport);
  const outside = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1;
        })
        .map((el) => `${el.tagName.toLowerCase()} ${el.textContent?.slice(0, 20) ?? ''}`),
    scope,
  );
  expect(outside, `${where}: elements past the right edge`).toEqual([]);
}

test('孪生：左侧栏点客户打开“客户 · 孪生”，375px 下单列、不横向滚动，点小图看大图', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  const clients = page.getByRole('region', { name: '客户' });
  await expect(clients.getByRole('img', { name: /孪生状态：需要留意/ })).toBeVisible();
  await clients.getByRole('button', { name: /合成客户甲/ }).click();

  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('heading', { name: '画像' })).toBeVisible();
  await expect(panel.getByRole('note')).toContainText('有危急指标，请先电话联系客户');
  await expect(panel.getByRole('note')).toContainText('仅供参考，非医疗诊断');
  await expect(panel.getByRole('article', { name: '代谢' })).toContainText(
    '由绿变黄（2026-10-02）',
  );
  await expect(panel.getByTestId('forecast-median').first()).toHaveAttribute(
    'data-uncertainty',
    'high',
  );
  await expect(panel.getByTestId('forecast-insufficient')).toContainText('还需要 2 次');
  // 四张状态卡片单列：左边对齐
  const xs = await panel
    .getByRole('article')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(new Set(xs).size).toBe(1);
  await expectNoHorizontalScroll(page, 'twin');

  await panel.getByRole('button', { name: '查看收缩压（日常监测）的大图和依据' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('方法：按过去的变化速度直线外推');
  await expect(dialog).toContainText('不确定性等级：高');
  await expect(dialog).toContainText('按当前走势，约 6 个月后可能高于报告参考范围上限');
  await expect(dialog.getByTestId('forecast-disclaimer')).toHaveText('仅供参考，非医疗诊断');
  const box = await dialog.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1);
  await expectNoHorizontalScroll(page, 'forecast dialog');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toBeHidden();
});

test('今日跟进：375px 下处理一项危急指标（不能忽略），角标随之更新', async ({ page }) => {
  const patches = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: /今日跟进.*2 项未处理/ }).click();
  const list = page.getByRole('list', { name: '异常跟进' });
  await expect(list).toContainText('收缩压 182 mmHg（2026-10-17 监测）达到危急阈值 ≥ 180');
  await expect(list).toContainText('已延续 1 天');
  // 手机宽度下结果区是收起的底部面板（不在视口内），只检查中间区域
  await expect(page.getByRole('list', { name: '今日随访' })).toContainText('已逾期 2 天');
  await expectNoHorizontalScroll(page, 'follow-ups', 'main *');

  await list.getByRole('button', { name: /处理/ }).click();
  await expect(list.getByRole('radio', { name: '忽略' })).toHaveCount(0);
  await list.getByRole('combobox', { name: /处理方式类别/ }).selectOption({ label: '已电话联系' });
  await list.getByRole('button', { name: '确定' }).click();
  await expect(page.getByText('今天没有需要跟进的项目')).toBeVisible();
  expect(patches).toEqual([{ action: 'done', resolution: 'called' }]);
  await page.getByRole('button', { name: '打开菜单' }).click();
  // 只剩今日随访的一项
  await expect(page.getByRole('button', { name: /今日跟进.*1 项未处理/ })).toBeVisible();
});

test('方案与随访、方案库：375px 下不横向滚动（M5 验收标准 31）', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  const clients = page.getByRole('region', { name: '客户' });
  await clients.getByRole('button', { name: /合成客户甲/ }).click();
  const panel = page.getByRole('tabpanel');
  await panel.getByRole('button', { name: '方案与随访' }).click();
  await expect(panel.getByTestId('current-plan')).toContainText('每天步行 7000 步');
  await expect(panel.getByRole('list', { name: '随访日程' })).toContainText('了解晚饭后散步的情况');
  await expect(panel.getByRole('list', { name: '随访记录' })).toContainText('2026-10-10 · 微信');
  await expectNoHorizontalScroll(page, 'care view');

  await page
    .getByRole('complementary', { name: '结果' })
    .getByRole('button', { name: '关闭结果区' })
    .click();
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '方案库' }).click();
  const item = page.getByRole('button', { name: /合成燕麦粥/ });
  await expect(item).toBeVisible();
  await expectNoHorizontalScroll(page, 'library', 'main *');
  await item.click();
  await expect(page.getByRole('heading', { level: 2, name: /合成燕麦粥/ })).toBeVisible();
  await expectNoHorizontalScroll(page, 'library detail', 'main *');
});

test('方案草稿的编辑器：375px 下不横向滚动，只能改内容和替换条目（M5 规格 2.1）', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`/?task=${ids.task}`);
  await page.getByRole('button', { name: '打开结果区' }).click();
  const panel = page.getByRole('tabpanel');
  await panel
    .getByRole('button', { name: /健康方案|第1版/ })
    .first()
    .click();
  await page.getByRole('tab', { name: '食谱、动作和目标' }).click();
  const editor = page.getByTestId('care-plan-editor');
  await expect(editor.getByRole('combobox', { name: '第 1 天 · 早餐' })).toBeVisible();
  await expect(editor.getByRole('spinbutton', { name: /steps/ })).toHaveValue('7000');
  await expectNoHorizontalScroll(page, 'plan editor');
});
