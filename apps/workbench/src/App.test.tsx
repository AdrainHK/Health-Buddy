import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'manager@test.example',
  displayName: '测试健管师',
  role: 'manager',
  operator: { id: '22222222-2222-4222-8222-222222222222', name: '测试协会', brandColor: '#3355aa' },
  orgId: null,
};

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** 模拟后端：只认一个账号密码，记录登录状态。 */
function mockServer() {
  let loggedIn = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me')
      return loggedIn ? json(200, { user: USER }) : json(401, { error: 'unauthenticated' });
    if (url === '/api/auth/login') {
      const body = JSON.parse(String(init?.body)) as { email: string; password: string };
      if (body.email === USER.email && body.password === 'right-password') {
        loggedIn = true;
        return json(200, { user: USER });
      }
      return json(401, { error: 'invalid_credentials' });
    }
    if (url === '/api/auth/logout') {
      loggedIn = false;
      return new Response(null, { status: 204 });
    }
    return json(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App login flow', () => {
  beforeEach(() => {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty('--hb-brand');
  });

  it('shows the login page when not signed in', async () => {
    mockServer();
    render(<App />);
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByText('今天想让我帮你做什么？')).not.toBeInTheDocument();
  });

  it('shows an error for wrong credentials and clears the password', async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('邮箱'), USER.email);
    await user.type(screen.getByLabelText('密码'), 'wrong');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱或密码不正确');
    expect(screen.getByLabelText('密码')).toHaveValue('');
  });

  it('signs in, applies the operator brand colour, and signs out', async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('邮箱'), USER.email);
    await user.type(screen.getByLabelText('密码'), 'right-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('今天想让我帮你做什么？')).toBeInTheDocument();
    expect(screen.getByText('测试健管师')).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--hb-brand')).toBe('#3355aa');

    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--hb-brand')).toBe(''),
    );
  });

  it('shows a network error when the server is unreachable', async () => {
    const fetchMock = mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('邮箱'), USER.email);
    await user.type(screen.getByLabelText('密码'), 'x');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败');
  });
});
