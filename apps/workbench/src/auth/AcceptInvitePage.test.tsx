import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, mockApi } from '../test/mockApi';

const TOKEN = 'B'.repeat(43);

describe('接受邀请、设置密码（M7 规格 2.4）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('两次密码不一样或太短时不提交；设置成功后清掉地址栏里的令牌、引导登录', async () => {
    window.location.hash = `#/invite/${TOKEN}`;
    const api = mockApi({
      'POST /auth/invite/accept': () => json(200, { role: 'manager' }),
    });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: '设置密码' })).toBeInTheDocument();
    // 不读登录状态
    expect(api.callsTo('GET', '/auth/me')).toHaveLength(0);
    await user.type(screen.getByLabelText('新密码'), 'short');
    await user.click(screen.getByRole('button', { name: '设置密码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('至少 10 位');
    await user.clear(screen.getByLabelText('新密码'));
    await user.type(screen.getByLabelText('新密码'), 'synthetic-pass-123');
    await user.type(screen.getByLabelText('再输入一次'), 'synthetic-pass-124');
    await user.click(screen.getByRole('button', { name: '设置密码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('不一样');
    expect(api.callsTo('POST', '/auth/invite/accept')).toHaveLength(0);
    await user.clear(screen.getByLabelText('再输入一次'));
    await user.type(screen.getByLabelText('再输入一次'), 'synthetic-pass-123');
    await user.click(screen.getByRole('button', { name: '设置密码' }));
    expect(await screen.findByRole('status')).toHaveTextContent('密码已设置');
    expect(api.callsTo('POST', '/auth/invite/accept')[0]?.body).toEqual({
      token: TOKEN,
      password: 'synthetic-pass-123',
    });
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('button', { name: '前往登录' })).toBeInTheDocument();
  });

  it('链接失效（410）时提示联系管理员重发', async () => {
    window.location.hash = `#/invite/${TOKEN}`;
    mockApi({ 'POST /auth/invite/accept': () => json(410, { error: 'invite_expired' }) });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('新密码'), 'synthetic-pass-123');
    await user.type(screen.getByLabelText('再输入一次'), 'synthetic-pass-123');
    await user.click(screen.getByRole('button', { name: '设置密码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('链接已失效，请联系管理员重发');
  });
});
