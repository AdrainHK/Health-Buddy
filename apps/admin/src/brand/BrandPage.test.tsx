import type { Brand } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, USERS } from '../test/mockApi';

const BRAND: Brand = {
  operatorName: '合成协会',
  displayName: null,
  primaryColor: null,
  loginGreeting: null,
  logoUrl: null,
  updatedAt: null,
};

function renderPage(routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = '#brand';
  const api = mockApi(USERS.operator_admin, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/brand': () => json(200, { brand: BRAND }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

describe('协会品牌页（M7 规格 2.2）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('改名称、主色、欢迎语时浅色和深色预览实时变化；保存后提示刷新生效', async () => {
    const { api, user } = renderPage({
      'PUT /admin/brand': () =>
        json(200, { brand: { ...BRAND, displayName: '合成品牌', primaryColor: '#1d4ed8' } }),
    });
    await user.type(await screen.findByLabelText('显示名称'), '合成品牌');
    await user.type(screen.getByLabelText('主色'), '#1d4ed8');
    await user.type(screen.getByLabelText('登录页欢迎语'), '欢迎使用合成协会的工作台');
    for (const theme of ['light', 'dark']) {
      const preview = screen.getByTestId(`preview-${theme}`);
      expect(preview).toHaveAttribute('data-hb-theme', theme);
      expect(preview).toHaveTextContent('合成品牌 · Health Buddy');
      expect(preview).toHaveTextContent('欢迎使用合成协会的工作台');
      expect(preview.style.getPropertyValue('--hb-brand-custom')).toBe('#1d4ed8');
    }
    expect(
      screen.getByTestId('preview-dark').style.getPropertyValue('--hb-brand-custom-dark'),
    ).not.toBe('#1d4ed8');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('status')).toHaveTextContent('刷新页面后生效');
    expect(api.callsTo('PUT', '/admin/brand')[0]?.body).toEqual({
      displayName: '合成品牌',
      primaryColor: '#1d4ed8',
      loginGreeting: '欢迎使用合成协会的工作台',
    });
  });

  it('颜色太浅不能保存；含禁用词前端先拦住，不发请求', async () => {
    const { api, user } = renderPage();
    await user.type(await screen.findByLabelText('主色'), '#ffcc00');
    expect(screen.getByRole('alert')).toHaveTextContent('对比度不到 4.5:1');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.clear(screen.getByLabelText('主色'));
    await user.type(screen.getByLabelText('登录页欢迎语'), '在这里根治慢病');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const field = screen.getByLabelText('登录页欢迎语').closest('div')!;
    expect(within(field).getByRole('alert')).toHaveTextContent('不合规的用词');
    expect(api.callsTo('PUT', '/admin/brand')).toHaveLength(0);
  });

  it('上传的 SVG 被拒绝时说明原因', async () => {
    const { user } = renderPage();
    vi.stubGlobal(
      'fetch',
      ((orig) =>
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input) === '/api/admin/brand/logo'
            ? json(400, { error: 'bad_request', reasons: ['unsafe_svg'] })
            : orig(input, init),
        ))(globalThis.fetch),
    );
    await user.upload(
      await screen.findByLabelText('Logo'),
      new File(['<svg onload="x"></svg>'], 'logo.svg', { type: 'image/svg+xml' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('含有脚本或外部链接');
  });

  it('顶栏显示“协会名 · Health Buddy”', async () => {
    renderPage();
    expect(await screen.findByTestId('admin-brand')).toHaveTextContent('合成协会 · Health Buddy');
  });
});
