import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { json, makeThresholds, mockApi, USERS } from './test/mockApi';

describe('后台登录和角色分流', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty('--hb-brand');
  });

  it('未登录时显示登录页，产品名只用 Health Buddy', async () => {
    mockApi(null);
    render(<App />);
    expect(await screen.findByRole('heading', { name: '登录后台' })).toBeInTheDocument();
    expect(screen.getByText('Health Buddy')).toBeInTheDocument();
  });

  it('密码错误时提示并清空密码', async () => {
    mockApi(null, { 'POST /auth/login': () => json(401, { error: 'invalid_credentials' }) });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('邮箱'), 'platform@test.example');
    await user.type(screen.getByLabelText('密码'), 'wrong');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱或密码不正确');
    expect(screen.getByLabelText('密码')).toHaveValue('');
  });

  it('平台管理员登录后进入危急指标设置，可以退出', async () => {
    const api = mockApi(null, {
      'POST /auth/login': () => json(200, { user: USERS.platform_admin }),
      'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('邮箱'), USERS.platform_admin.email);
    await user.type(screen.getByLabelText('密码'), 'synthetic-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '危急指标设置' })).toBeInTheDocument();
    expect(screen.getByText('合成平台管理员')).toBeInTheDocument();
    expect(api.callsTo('POST', '/auth/login')[0]?.body).toEqual({
      email: USERS.platform_admin.email,
      password: 'synthetic-password',
    });

    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '登录后台' })).toBeInTheDocument();
  });

  it('健管师登录后台时引导去工作台，不请求阈值接口', async () => {
    const api = mockApi(USERS.manager);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: '后台仅供管理员使用' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往工作台' })).toHaveAttribute('href', '/');
    expect(screen.queryByText('危急指标设置')).not.toBeInTheDocument();
    expect(api.callsTo('GET', '/critical-thresholds')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '登录后台' })).toBeInTheDocument();
  });
});
