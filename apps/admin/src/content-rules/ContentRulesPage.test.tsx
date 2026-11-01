import { POPSCI_DEFAULT_RULES, type ContentRulesResponse } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, USERS } from '../test/mockApi';

/** M8 第 2 步：平台“科普合规规则”页（规格 2.3，Q3）。合成数据 */

const V1: ContentRulesResponse = {
  version: 1,
  rules: POPSCI_DEFAULT_RULES,
  createdAt: '2026-11-01T00:00:00.000Z',
  history: [{ version: 1, createdAt: '2026-11-01T00:00:00.000Z' }],
};

function renderPage(user = USERS.platform_admin, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#content-rules';
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/content-rules': () => json(200, V1),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('科普合规规则页', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('列出内置检查和各组词表；改一组的词语后保存为新版本', async () => {
    const { api, user } = renderPage(USERS.platform_admin, {
      'PUT /admin/content-rules': () =>
        json(200, {
          ...V1,
          version: 2,
          history: [{ version: 2, createdAt: V1.createdAt }, ...V1.history],
        }),
    });
    expect(await screen.findByText('当前版本 v1（2026-11-01 保存）')).toBeInTheDocument();
    expect(screen.getByText(/原有禁用词表：命中即“禁止”/)).toBeInTheDocument();
    const group = screen.getByRole('listitem', { name: '疗效承诺' });
    const terms = within(group).getByRole('textbox', { name: /词语/ });
    expect(terms).toHaveValue(POPSCI_DEFAULT_RULES[0]!.terms.join('\n'));
    await user.type(terms, '\n神奇疗效');
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));
    expect(await screen.findByText('已保存为 v2')).toBeInTheDocument();
    const body = api.callsTo('PUT', '/admin/content-rules')[0]!.body as {
      baseVersion: number;
      rules: { id: string; terms: string[] }[];
    };
    expect(body.baseVersion).toBe(1);
    expect(body.rules[0]!.terms).toContain('神奇疗效');
    expect(body.rules).toHaveLength(POPSCI_DEFAULT_RULES.length);
  });

  it('新增的组没填名称和原因时不提交；别人先保存了新版本时提示重新载入', async () => {
    const { api, user } = renderPage(USERS.platform_admin, {
      'PUT /admin/content-rules': () =>
        json(409, { error: 'conflict', reasons: ['rules_changed'] }),
    });
    await screen.findByText('当前版本 v1（2026-11-01 保存）');
    await user.click(screen.getByRole('button', { name: '新增一组' }));
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('有空的名称、原因或词语');
    expect(api.callsTo('PUT', '/admin/content-rules')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '删除“custom_6”' }));
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('别人刚保存了新版本');
    await user.click(screen.getByRole('button', { name: '重新载入' }));
    await waitFor(() => expect(api.callsTo('GET', '/admin/content-rules')).toHaveLength(2));
  });

  it('协会管理员的导航里没有这一页', async () => {
    window.location.hash = '#content-rules';
    mockApi(USERS.operator_admin, {
      'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    });
    render(<App />);
    await screen.findByRole('navigation');
    expect(screen.queryByRole('link', { name: '科普合规规则' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '科普合规规则' })).not.toBeInTheDocument();
  });
});
