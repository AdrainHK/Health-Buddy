import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  ArtifactDetailResponse,
  ArtifactSummary,
  ClientRecord,
  ClientSummary,
  CurrentUser,
  ExtractedValue,
  ReportUpload,
  SkillSummary,
  Task,
  TaskDetailResponse,
} from '@health-buddy/shared';

/**
 * M2 验收标准 25：手机宽度（375px）下，档案和核对界面不横向滚动；核对界面改为上下排列
 * （原件在上，数值在下，规格 2.1）。接口全部在浏览器里模拟，只用合成数据。
 * 数据故意带上很长的机构名、指标名、单位、原文件名和不带空格的英文，检查不会把页面撑宽。
 */

const NOW = '2026-10-15T08:00:00.000Z';
const ids = {
  manager: '30000000-0000-4000-8000-000000000001',
  operator: '30000000-0000-4000-8000-000000000002',
  org: '30000000-0000-4000-8000-000000000003',
  client: '20000000-0000-4000-8000-00000000000a',
  task: '10000000-0000-4000-8000-000000000001',
  upload: 'a0000000-0000-4000-8000-000000000001',
  file: 'a0000000-0000-4000-8000-000000000002',
  report: 'a0000000-0000-4000-8000-000000000005',
  history: '90000000-0000-4000-8000-000000000002',
  tier: '90000000-0000-4000-8000-000000000003',
  artifact: '70000000-0000-4000-8000-000000000001',
  event: '80000000-0000-4000-8000-000000000001',
};
const LONG_LATIN = 'SyntheticHealthLaboratoryOfVeryLongNamesWithoutAnySpacesForWrapping';

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
const task: Task = {
  id: ids.task,
  title: '合成客户甲的体检报告',
  clientId: ids.client,
  archived: false,
  detachedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
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
  },
];

function value(seq: number, overrides: Partial<ExtractedValue>): ExtractedValue {
  return {
    id: `b0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    rawName: '总胆固醇',
    code: 'tc',
    rawValue: '5.62',
    rawUnit: 'mmol/L',
    value: 5.62,
    unit: 'mmol/L',
    refLow: null,
    refHigh: 5.2,
    refText: '<5.2',
    page: 1,
    sourceSnippet: '总胆固醇 5.62 mmol/L <5.2',
    flags: [],
    reviewStatus: 'pending',
    checked: false,
    attention: false,
    abnormal: 'high',
    ...overrides,
  };
}

const upload: ReportUpload = {
  id: ids.upload,
  clientId: ids.client,
  taskId: ids.task,
  status: 'needs_review',
  failureCategory: null,
  attempts: 1,
  pageCount: 1,
  progressPage: 1,
  reportId: null,
  createdAt: NOW,
  version: 3,
  reportDate: '2026-09-12',
  institution: `合成健康体检中心 ${LONG_LATIN}`,
  files: [
    {
      id: ids.file,
      seq: 0,
      mimeType: 'image/png',
      sizeBytes: 123456,
      pageCount: 1,
      originalName: `${LONG_LATIN}-synthetic-report-scan-2026-09-12.png`,
    },
  ],
  values: [
    value(1, {}),
    value(2, {
      rawName: 'Fasting Plasma Glucose (Hexokinase Method, Serum)',
      code: 'fpg',
      rawValue: '104',
      rawUnit: 'mg/dL',
      value: 5.772,
      unit: 'mmol/L',
      refLow: 3.885,
      refHigh: 5.495,
      refText: '70-99',
      flags: ['unit_converted'],
      attention: true,
    }),
    value(3, {
      rawName: `同型半胱氨酸${LONG_LATIN}`,
      code: null,
      rawValue: '11.2',
      rawUnit: 'μmol/L',
      value: 11.2,
      unit: 'μmol/L',
      refLow: 0,
      refHigh: 15,
      refText: '0-15',
      flags: ['unmapped'],
      attention: true,
      abnormal: 'normal',
    }),
    value(4, {
      rawName: '谷丙转氨酶',
      code: 'alt',
      rawValue: '52',
      rawUnit: 'U/L',
      value: 52,
      unit: 'U/L',
      refHigh: null,
      refText: null,
      abnormal: 'no_reference',
    }),
    value(5, {
      rawName: '体重',
      code: 'weight',
      rawValue: '650',
      rawUnit: 'kg',
      value: 650,
      unit: 'kg',
      refHigh: null,
      refText: null,
      flags: ['out_of_bounds'],
      attention: true,
      abnormal: 'no_reference',
    }),
  ],
  sameDateReportIds: [],
  criticalAcknowledged: false,
};

const record: ClientRecord = {
  client,
  riskTier: {
    id: ids.tier,
    tier: 'medium',
    reason: `合成理由：总胆固醇 5.62 mmol/L 高于报告参考范围 <5.2；${LONG_LATIN}`,
    setBy: ids.manager,
    setByName: '合成健管师',
    setAt: NOW,
    source: 'manual',
    sourceArtifactId: null,
  },
  healthHistory: [
    {
      id: ids.history,
      category: 'lifestyle',
      content: `合成记录：每周快走三次，晚餐偏咸。${LONG_LATIN}`,
      recordedOn: '2026-05-01',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  reports: [
    {
      id: ids.report,
      reportDate: '2026-09-12',
      source: 'upload',
      institution: `合成健康体检中心 ${LONG_LATIN}`,
      indicatorCount: 12,
      abnormalCount: 3,
    },
  ],
  indicators: [
    {
      code: 'tc',
      points: [
        {
          reportId: ids.report,
          reportDate: '2026-09-12',
          source: 'upload',
          value: 5.62,
          unit: 'mmol/L',
          originalValue: '217.3',
          originalUnit: 'mg/dL',
          refText: '<5.2',
          abnormal: 'high',
        },
      ],
    },
    {
      code: 'fpg',
      points: [
        {
          reportId: ids.report,
          reportDate: '2026-09-12',
          source: 'upload',
          value: 5.772,
          unit: 'mmol/L',
          originalValue: '104',
          originalUnit: 'mg/dL',
          refText: '70-99',
          abnormal: 'high',
        },
      ],
    },
  ],
  monitoring: [
    {
      metric: 'sbp',
      unit: 'mmHg',
      count: 30,
      latest: { value: 128, measuredAt: NOW, source: 'synthetic' },
    },
  ],
  artifacts: [],
  readOnly: false,
};

const artifactSummary: ArtifactSummary = {
  id: ids.artifact,
  taskId: ids.task,
  skillId: 'report-interpretation',
  version: 1,
  status: 'draft',
  hasCriticalFlags: false,
  createdAt: NOW,
  sourceReportDate: '2026-09-12',
  sourceFileName: 'synthetic-report-scan.png',
};
const ARTIFACT_TITLE =
  '合成客户甲（测试） 体检报告（2026-09-12 · synthetic-report-scan.png）解读 · 第 1 版';

const artifactDetail: ArtifactDetailResponse = {
  artifact: {
    ...artifactSummary,
    clientId: ids.client,
    parentId: null,
    content: {
      professional: '## 合成专业版\n- 总胆固醇 5.62 mmol/L，高于报告参考范围 <5.2',
      clientFacing: '合成通俗版：大部分指标在参考范围内。\n\n仅供参考，非医疗诊断',
    },
    contentHash: 'hash-1',
    criticalFlags: [],
    sourceReportId: ids.report,
    riskTierSuggestion: null,
    clientFacing: true,
  },
  sourceReport: { id: ids.report, reportDate: '2026-09-12', correctedSince: false },
  hints: { judgementHints: [], criticalValueMentions: [], riskTierMentions: [] },
  versions: [artifactSummary],
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
  artifacts: [artifactSummary],
  uploads: [upload],
};

/** 合成的“报告原件”：一张比手机屏幕宽得多的图片 */
const ORIGINAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754" viewBox="0 0 1240 1754"><rect width="1240" height="1754" fill="#fff"/><text x="40" y="80" font-size="40">synthetic report</text></svg>`;

/** 发给核对确认接口的请求体 */
const verified: unknown[] = [];

async function mockApi(page: Page): Promise<string[]> {
  const unknown: string[] = [];
  verified.length = 0;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  // 只拦截接口；开发服务器的模块路径里也可能带 /api/（如 packages/shared/dist/api）
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = `${url.pathname}${url.search}`;
      const key = `${req.method()} ${path}`;
      switch (true) {
        case key === 'GET /api/auth/me':
          return json(route, { user });
        case key === 'GET /api/tasks':
          return json(route, { tasks: [task] });
        case key === 'GET /api/tasks?archived=true':
          return json(route, { tasks: [] });
        case key === 'GET /api/clients':
          return json(route, { clients: [client] });
        case key === 'GET /api/skills':
          return json(route, { skills });
        case key === `GET /api/tasks/${ids.task}`:
          return json(route, detail);
        case key === `GET /api/clients/${ids.client}/record`:
          return json(route, { record });
        case key === `GET /api/clients/${ids.client}/reports`:
          return json(route, { reports: record.reports });
        case key === `GET /api/clients/${ids.client}/report-uploads`:
          return json(route, { uploads: [upload] });
        case key === `GET /api/report-uploads/${ids.upload}`:
          return json(route, { upload });
        case key === `GET /api/artifacts/${ids.artifact}`:
          return json(route, artifactDetail);
        case key === `POST /api/report-uploads/${ids.upload}/verify`:
          verified.push(req.postDataJSON());
          return json(route, {
            upload: { ...upload, status: 'verified', reportId: ids.report, version: 4 },
            critical: [],
          });
        case key.startsWith(`GET /api/report-files/${ids.file}/content`):
          return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: ORIGINAL_SVG });
        default:
          unknown.push(key);
          return json(route, { error: 'not_found' }, 404);
      }
    },
  );
  return unknown;
}

/** 页面（以及 body）的内容宽度不超过视口：没有横向滚动 */
async function expectNoHorizontalScroll(page: Page, where: string) {
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(sizes.doc, `${where}: document ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(
    sizes.viewport,
  );
  expect(sizes.body, `${where}: body ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport);
  // 结果区浮层本身也不能横向滚动
  const overflowing = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="tabpanel"], [role="tabpanel"] *')]
      .filter((el) => {
        const style = getComputedStyle(el);
        const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
        return scrolls && el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
  );
  expect(overflowing, `${where}: horizontally scrolling elements`).toEqual([]);
  // 没有元素伸到视口右边以外
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="tabpanel"] *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${el.textContent?.slice(0, 20) ?? ''}`),
  );
  expect(outside, `${where}: elements past the right edge`).toEqual([]);
}

async function openResults(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page
    .getByRole('button', { name: /合成客户甲的体检报告/ })
    .first()
    .click();
  await page.getByRole('button', { name: '打开结果区' }).click();
}

test('档案：375px 下不横向滚动', async ({ page }) => {
  const unknown = await mockApi(page);
  await openResults(page);
  await page.getByRole('tab', { name: '档案' }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('region', { name: '健康史' })).toBeVisible();
  await expect(panel.getByRole('region', { name: '指标趋势' })).toBeVisible();
  await expect(panel.getByText(/合成理由/)).toBeVisible();
  await expectNoHorizontalScroll(page, 'record');
  expect(unknown.filter((k) => k.startsWith('GET /api/clients'))).toEqual([]);
});

test('核对：375px 下不横向滚动，原件在上、数值在下', async ({ page }) => {
  await mockApi(page);
  await openResults(page);
  await page.getByRole('tab', { name: /核对/ }).click();
  const panel = page.getByRole('tabpanel');
  await panel.getByRole('button', { name: '去核对' }).first().click();
  const image = panel.getByRole('img').first();
  await expect(image).toBeVisible();
  await expect(panel.getByText('确认核对').first()).toBeVisible();
  // 验收反馈 4：原件上方固定提醒核对姓名；勾选前“确认核对”和“确认所有数据”都不能点
  const notice = panel.getByText('请确认报告上的姓名是本客户');
  await expect(notice).toBeVisible();
  const confirmAll = panel.getByRole('button', { name: '确认所有数据' });
  await expect(confirmAll).toBeDisabled();
  await expect(panel.getByRole('button', { name: '确认核对' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: '我已对照原件确认，报告上的姓名是本客户' }).check();
  await expect(confirmAll).toBeEnabled();
  // 等原件加载完，避免布局还在变化
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete)).toBe(true);
  await expectNoHorizontalScroll(page, 'review');

  // 上下排列：原件在识别结果上面，原件宽度不超过视口
  const imageBox = await image.boundingBox();
  const firstValue = await panel.getByText('总胆固醇').first().boundingBox();
  expect(imageBox && firstValue).toBeTruthy();
  expect(imageBox!.y).toBeLessThan(firstValue!.y);
  const noticeBox = await notice.boundingBox();
  expect(noticeBox!.y).toBeLessThan(imageBox!.y);
  expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(375 + 1);
});

test('对话：375px 下选了 /体检解读 后的报告选择不横向滚动（验收反馈 6）', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page
    .getByRole('button', { name: /合成客户甲的体检报告/ })
    .first()
    .click();
  const box = page.getByRole('textbox');
  await box.fill('/');
  await page.getByRole('option', { name: '体检解读' }).click();
  const picker = page.getByRole('group', { name: '选择要用的报告' });
  await expect(picker).toBeVisible();
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    doc: document.documentElement.scrollWidth,
  }));
  expect(sizes.doc).toBeLessThanOrEqual(sizes.viewport);
  const pickerBox = await picker.boundingBox();
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(375 + 1);
  await picker.getByRole('button', { name: '报告 · 2026-09-12' }).click();
  await expect(page.getByRole('button', { name: '移除报告 2026-09-12' })).toBeVisible();
});

test('核对：375px 下在确认按钮旁勾选姓名确认，然后确认（手机验收反馈 1）', async ({ page }) => {
  await mockApi(page);
  await openResults(page);
  await page.getByRole('tab', { name: /核对/ }).click();
  const panel = page.getByRole('tabpanel');
  await panel.getByRole('button', { name: '去核对' }).first().click();
  const confirmAll = panel.getByRole('button', { name: '确认所有数据' });
  await confirmAll.scrollIntoViewIfNeeded();
  await expect(confirmAll).toBeDisabled();
  // 按钮旁写明还差什么
  await expect(panel.getByRole('list', { name: '确认前还需要' })).toContainText(
    '勾选“报告上的姓名是本客户”',
  );
  // 不用滚回原件上方：按钮旁就有同步的勾选框，手指点得到
  const near = panel.getByRole('checkbox', { name: '报告上的姓名是本客户（已对照原件）' });
  await expect(near).toBeInViewport();
  const box = await near.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(20);
  await near.tap();
  await expect(near).toBeChecked();
  await expect(
    panel.getByRole('checkbox', { name: '我已对照原件确认，报告上的姓名是本客户' }),
  ).toBeChecked();
  await expect(confirmAll).toBeEnabled();
  // 还有需特别注意的行没勾：“确认核对”仍不能点，原因写在按钮旁
  await expect(panel.getByRole('button', { name: '确认核对' })).toBeDisabled();
  await expect(panel.getByRole('list', { name: '确认前还需要' })).toContainText('确认所有数据');
  await confirmAll.tap();
  await expect(panel.getByText('已核对，已写入档案').first()).toBeVisible();
  expect(verified).toEqual([
    expect.objectContaining({
      identityConfirmed: true,
      confirmAll: true,
      reportDate: '2026-09-12',
    }),
  ]);
  await expectNoHorizontalScroll(page, 'review confirmed');
});

test('刷新：375px 下刷新页面后仍能看到产物和记录（验收反馈 3、4）', async ({ page }) => {
  await mockApi(page);
  await openResults(page);
  const panel = page.getByRole('tabpanel');
  await panel.getByRole('button', { name: ARTIFACT_TITLE }).click();
  await expect(page.getByRole('heading', { name: ARTIFACT_TITLE })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`task=${ids.task}`));

  await page.reload();
  // 刷新后任务和产物都恢复了
  await expect(page.getByRole('heading', { level: 1, name: '合成客户甲的体检报告' })).toBeVisible();
  await page.getByRole('button', { name: '打开结果区' }).click();
  await expect(page.getByRole('heading', { name: ARTIFACT_TITLE })).toBeVisible();
  await page.getByRole('tab', { name: '记录' }).click();
  const history = page.getByRole('tabpanel');
  await expect(history.getByRole('button', { name: '查看第 1 版' })).toContainText(ARTIFACT_TITLE);
  await expect(history.getByText('系统 · 生成')).toBeVisible();
  await expectNoHorizontalScroll(page, 'history after reload');
});
