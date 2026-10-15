import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from './AppShell';

function setViewport(narrow: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: narrow && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

describe('AppShell (wide screen)', () => {
  beforeEach(() => setViewport(false));

  it('shows the product name, the three columns and the greeting', () => {
    render(<AppShell />);
    expect(screen.getByRole('complementary', { name: 'Health Buddy' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '结果' })).toBeInTheDocument();
    expect(screen.getByText('今天想让我帮你做什么？')).toBeInTheDocument();
  });

  it('collapses and expands the sidebar', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('还没有任务')).not.toBeInTheDocument();
  });

  it('closes and reopens the results panel', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    // 顶栏的开关按钮带 aria-expanded；结果区自己的关闭按钮没有。
    const toggle = screen
      .getAllByRole('button', { name: '关闭结果区' })
      .find((b) => b.hasAttribute('aria-expanded'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    if (!toggle) throw new Error('results toggle not found');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: '打开结果区' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('switches result tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    const artifacts = screen.getByRole('tab', { name: '产物' });
    artifacts.focus();
    await user.keyboard('{ArrowRight}');
    const client = screen.getByRole('tab', { name: '客户' });
    expect(client).toHaveAttribute('aria-selected', 'true');
    expect(client).toHaveFocus();
    expect(within(screen.getByRole('tabpanel')).getByText('未选择客户')).toBeInTheDocument();
  });

  it('keeps the composer disabled until chat ships in M1', () => {
    render(<AppShell />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '做一做' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('AppShell (narrow screen)', () => {
  beforeEach(() => setViewport(true));

  it('starts with both overlays closed and opens the menu as a drawer', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(screen.getByRole('complementary', { name: 'Health Buddy' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();
  });

  it('closes the menu when the results sheet opens, so only one overlay shows', async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    await user.click(screen.getByRole('button', { name: '打开结果区', hidden: true }));
    expect(screen.queryByRole('complementary', { name: 'Health Buddy' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '结果' })).toBeInTheDocument();
  });
});
