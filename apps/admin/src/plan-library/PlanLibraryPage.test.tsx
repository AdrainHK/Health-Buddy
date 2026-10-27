import type { CurrentUser, Exercise, LibraryItemEvent, Recipe } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, NOW, USERS, type RecordedCall } from '../test/mockApi';

/** 合成的方案库条目（不含任何客户数据） */
const recipeIds = {
  draft: 'a1000000-0000-4000-8000-000000000001',
  review: 'a1000000-0000-4000-8000-000000000002',
  published: 'a1000000-0000-4000-8000-000000000003',
};
const exerciseId = 'a2000000-0000-4000-8000-000000000001';

const baseRecipe = {
  mealTypes: ['breakfast'],
  ingredients: [
    { name: '燕麦片', householdAmount: '半碗', grams: null, overseasAlternative: null },
  ],
  steps: ['加水煮 5 分钟'],
  nutritionPerServing: null,
  nutritionBasis: null,
  tags: ['high_fiber'],
  allergens: ['gluten'],
  sourceNote: '合成来源',
  reviewedByLabel: null,
  reviewedOn: null,
  updatedAt: NOW,
} as const;

function makeRecipes(): Recipe[] {
  return [
    {
      ...baseRecipe,
      id: recipeIds.draft,
      code: 'test-draft',
      name: '合成燕麦粥',
      status: 'draft',
      version: 2,
      updatedByName: '合成平台管理员',
      mealTypes: ['breakfast'],
      tags: ['high_fiber'],
      allergens: ['gluten'],
      ingredients: [...baseRecipe.ingredients],
      steps: [...baseRecipe.steps],
    },
    {
      ...baseRecipe,
      id: recipeIds.review,
      code: 'test-review',
      name: '合成杂粮饭',
      status: 'review',
      version: 1,
      updatedByName: null,
      mealTypes: ['lunch', 'dinner'],
      tags: [],
      allergens: [],
      ingredients: [...baseRecipe.ingredients],
      steps: [...baseRecipe.steps],
    },
    {
      ...baseRecipe,
      id: recipeIds.published,
      code: 'test-published',
      name: '合成青菜汤',
      status: 'published',
      version: 3,
      updatedByName: '合成平台管理员',
      reviewedByLabel: '营养顾问甲',
      reviewedOn: '2026-10-20',
      mealTypes: ['dinner'],
      tags: [],
      allergens: [],
      ingredients: [...baseRecipe.ingredients],
      steps: [...baseRecipe.steps],
    },
  ];
}

function makeExercises(): Exercise[] {
  return [
    {
      id: exerciseId,
      code: 'test-walk',
      name: '合成健步走',
      category: 'aerobic',
      intensity: 'moderate',
      setting: ['outdoor'],
      equipment: [],
      steps: ['加快步速'],
      keyPoints: ['抬头挺胸'],
      commonMistakes: [],
      managerCautions: '合成注意事项：近期胸闷的先请医生评估',
      met: 4.3,
      sourceNote: '合成来源',
      status: 'published',
      version: 1,
      reviewedByLabel: '运动顾问乙',
      reviewedOn: '2026-10-20',
      updatedByName: null,
      updatedAt: NOW,
    },
  ];
}

function renderAs(user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#plan-library';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/plan-library/recipes': () =>
      json(200, {
        items:
          user.role === 'platform_admin'
            ? makeRecipes()
            : makeRecipes().filter((r) => r.status === 'published'),
      }),
    'GET /admin/plan-library/exercises': () => json(200, { items: makeExercises() }),
    'GET /admin/plan-library/goal-templates': () => json(200, { items: [] }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

const rowOf = async (name: string) => {
  const header = await screen.findByRole('rowheader', { name });
  return header.closest('tr')!;
};

function statusTo(status: Recipe['status'], extra: Partial<Recipe> = {}) {
  return ({ path, body }: RecordedCall) => {
    const id = path.split('/')[4];
    const item = makeRecipes().find((r) => r.id === id)!;
    return json(200, { item: { ...item, ...(body as object), ...extra, status } });
  };
}

describe('方案库', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('平台管理员：顶部固定说明；列表显示类别、状态、版本和最后修改人（种子导入的条目写“种子导入”）', async () => {
    renderAs(USERS.platform_admin);
    expect(await screen.findByRole('heading', { name: '方案库' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      '种子内容是平台编写的初稿，发布前请由营养、运动顾问审定。',
    );
    const draft = await rowOf('合成燕麦粥');
    expect(draft).toHaveTextContent('早餐');
    expect(draft).toHaveTextContent('草稿');
    expect(draft).toHaveTextContent('第 2 版');
    expect(draft).toHaveTextContent('合成平台管理员');
    const review = await rowOf('合成杂粮饭');
    expect(review).toHaveTextContent('午餐、晚餐');
    expect(review).toHaveTextContent('种子导入');
    expect(screen.getByText('共 3 条')).toBeInTheDocument();
  });

  it('按状态和名称筛选；切换到运动标签加载运动库', async () => {
    const { api, user } = renderAs(USERS.platform_admin);
    await rowOf('合成燕麦粥');
    await user.selectOptions(screen.getByLabelText('状态'), '已发布');
    expect(screen.queryByRole('rowheader', { name: '合成燕麦粥' })).not.toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '合成青菜汤' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('状态'), '全部状态');
    await user.type(screen.getByLabelText('搜索名称'), '杂粮');
    expect(screen.getByText('共 1 条')).toBeInTheDocument();

    // 换库时清空筛选条件
    await user.click(screen.getByRole('tab', { name: '运动和放松练习' }));
    expect(screen.getByLabelText('搜索名称')).toHaveValue('');
    const walk = await rowOf('合成健步走');
    expect(walk).toHaveTextContent('有氧 · 中等强度');
    expect(api.callsTo('GET', '/admin/plan-library/exercises')).toHaveLength(1);
  });

  it('只有草稿能编辑；状态按顺序流转：送审、发布（填审定人和日期）、停用、退回草稿', async () => {
    const { api, user } = renderAs(USERS.platform_admin, {
      'POST /admin/plan-library/recipes/a1000000-0000-4000-8000-000000000001/status':
        statusTo('review'),
      'POST /admin/plan-library/recipes/a1000000-0000-4000-8000-000000000002/status': statusTo(
        'published',
        { reviewedByLabel: '营养顾问甲', reviewedOn: '2026-10-21' },
      ),
    });
    const draft = await rowOf('合成燕麦粥');
    expect(within(draft).getByRole('button', { name: '编辑 合成燕麦粥' })).toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: '送审 合成燕麦粥' })).toBeInTheDocument();
    expect(
      within(draft).queryByRole('button', { name: '发布 合成燕麦粥' }),
    ).not.toBeInTheDocument();

    const published = await rowOf('合成青菜汤');
    expect(within(published).queryByRole('button', { name: /编辑/ })).not.toBeInTheDocument();
    expect(within(published).getByRole('button', { name: '停用 合成青菜汤' })).toBeInTheDocument();
    expect(
      within(published).getByRole('button', { name: '退回草稿 合成青菜汤' }),
    ).toBeInTheDocument();

    await user.click(within(draft).getByRole('button', { name: '送审 合成燕麦粥' }));
    expect(await screen.findByText('状态已更新')).toBeInTheDocument();
    expect(
      api.callsTo('POST', `/admin/plan-library/recipes/${recipeIds.draft}/status`)[0]?.body,
    ).toEqual({ version: 2, status: 'review' });
    expect(await rowOf('合成燕麦粥')).toHaveTextContent('待审定');

    const review = await rowOf('合成杂粮饭');
    await user.click(within(review).getByRole('button', { name: '发布 合成杂粮饭' }));
    const dialog = await screen.findByRole('dialog', { name: '发布 合成杂粮饭' });
    await user.click(within(dialog).getByRole('button', { name: '发布' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写审定人和审定日期');
    expect(api.callsTo('POST', `/admin/plan-library/recipes/${recipeIds.review}/status`)).toEqual(
      [],
    );
    await user.type(within(dialog).getByLabelText('审定人（姓名或代号）'), '营养顾问甲');
    await user.type(within(dialog).getByLabelText('审定日期'), '2026-10-21');
    await user.click(within(dialog).getByRole('button', { name: '发布' }));
    expect(await rowOf('合成杂粮饭')).toHaveTextContent('已发布');
    expect(
      api.callsTo('POST', `/admin/plan-library/recipes/${recipeIds.review}/status`)[0]?.body,
    ).toEqual({
      version: 1,
      status: 'published',
      reviewedByLabel: '营养顾问甲',
      reviewedOn: '2026-10-21',
    });
  });

  it('新增食谱：食材按行拆分；内容没通过检查时列出标出的位置', async () => {
    let attempt = 0;
    const { api, user } = renderAs(USERS.platform_admin, {
      'POST /admin/plan-library/recipes': ({ body }) => {
        attempt++;
        if (attempt === 1) {
          return json(400, {
            error: 'invalid_content',
            issues: [
              { path: 'name', term: '降血糖', index: 0 },
              { path: 'steps.1', term: '根治', index: 0 },
            ],
          });
        }
        return json(201, {
          item: {
            ...(body as object),
            id: 'a1000000-0000-4000-8000-000000000009',
            status: 'draft',
            version: 1,
            reviewedByLabel: null,
            reviewedOn: null,
            updatedByName: '合成平台管理员',
            updatedAt: NOW,
          },
        });
      },
    });
    await rowOf('合成燕麦粥');
    await user.click(screen.getByRole('button', { name: '新增条目' }));
    const dialog = await screen.findByRole('dialog', { name: '新增食谱' });
    await user.type(within(dialog).getByLabelText('编码'), 'test-new');
    await user.type(within(dialog).getByLabelText('名称'), '降血糖小炒');
    await user.click(within(dialog).getByRole('checkbox', { name: '午餐' }));
    await user.type(
      within(dialog).getByLabelText('食材和家庭常用量'),
      '芹菜 | 三四根{enter}胡萝卜 | 小半根 | 甜椒',
    );
    await user.type(within(dialog).getByLabelText('做法'), '切丝{enter}少油快炒');
    await user.click(within(dialog).getByRole('checkbox', { name: '少油' }));
    await user.type(within(dialog).getByLabelText('来源说明'), '合成来源');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('内容没有通过检查');
    expect(alert).toHaveTextContent('名称：含“降血糖”');
    expect(alert).toHaveTextContent('做法 · 第 2 项：含“根治”');
    expect(api.callsTo('POST', '/admin/plan-library/recipes')[0]?.body).toEqual({
      code: 'test-new',
      name: '降血糖小炒',
      mealTypes: ['lunch'],
      ingredients: [
        { name: '芹菜', householdAmount: '三四根', grams: null, overseasAlternative: null },
        { name: '胡萝卜', householdAmount: '小半根', grams: null, overseasAlternative: '甜椒' },
      ],
      steps: ['切丝', '少油快炒'],
      nutritionPerServing: null,
      nutritionBasis: null,
      tags: ['low_oil'],
      allergens: [],
      sourceNote: '合成来源',
    });

    const name = within(dialog).getByLabelText('名称');
    await user.clear(name);
    await user.type(name, '芹菜炒胡萝卜');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await rowOf('芹菜炒胡萝卜')).toHaveTextContent('草稿');
    expect(screen.getByText('已保存')).toBeInTheDocument();
    // 逐字输入整份食谱，CI 上接近默认的 5 秒上限，单独放宽
  }, 15_000);

  it('修改记录列出改前改后', async () => {
    const events: LibraryItemEvent[] = [
      {
        id: '2',
        action: 'updated',
        actorName: '合成平台管理员',
        status: 'draft',
        version: 2,
        changes: [{ field: 'name', before: '燕麦粥', after: '合成燕麦粥' }],
        createdAt: NOW,
      },
      {
        id: '1',
        action: 'created',
        actorName: '合成平台管理员',
        status: 'draft',
        version: 1,
        changes: [],
        createdAt: NOW,
      },
    ];
    const { user } = renderAs(USERS.platform_admin, {
      [`GET /admin/plan-library/recipes/${recipeIds.draft}/events`]: () => json(200, { events }),
    });
    const row = await rowOf('合成燕麦粥');
    await user.click(within(row).getByRole('button', { name: '合成燕麦粥 的修改记录' }));
    const dialog = await screen.findByRole('dialog', { name: '修改记录：合成燕麦粥' });
    expect(await within(dialog).findByText('名称：燕麦粥 → 合成燕麦粥')).toBeInTheDocument();
    expect(within(dialog).getByText('修改内容')).toBeInTheDocument();
    expect(within(dialog).getByText('新增')).toBeInTheDocument();
  });

  it.each([
    ['协会管理员', USERS.operator_admin],
    ['机构管理员', USERS.org_admin],
  ])('%s只读：只看到已发布的条目，没有新增、编辑、状态和修改记录按钮', async (_l, account) => {
    const { api, user } = renderAs(account);
    expect(
      await screen.findByText('方案库由平台统一维护。你可以浏览已发布的条目，不能修改。'),
    ).toBeInTheDocument();
    const row = await rowOf('合成青菜汤');
    expect(screen.queryByRole('rowheader', { name: '合成燕麦粥' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增条目' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('状态')).not.toBeInTheDocument();
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['查看']);
    expect(row).not.toHaveTextContent('合成平台管理员');

    // 运动条目详情含给健管师看的注意事项
    await user.click(screen.getByRole('tab', { name: '运动和放松练习' }));
    const walk = await rowOf('合成健步走');
    await user.click(within(walk).getByRole('button', { name: '查看 合成健步走' }));
    const dialog = await screen.findByRole('dialog', { name: '合成健步走' });
    expect(dialog).toHaveTextContent('合成注意事项：近期胸闷的先请医生评估');
    expect(dialog).toHaveTextContent('运动顾问乙，2026-10-20');
    expect(api.writes()).toEqual([]);
  });
});
