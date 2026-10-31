import type { MyPlan } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../shell/AppShell';
import { CLIENTS, SKILL, json, mockApi } from '../test/mockApi';

const PLAN: MyPlan = {
  code: 'basic',
  name: '合成基础版',
  features: { experts: false, twin: true, care: false, companion: true },
  monthlyQuotas: { llm_calls: 500, expert_calls: null, report_pages: 100, companion_devices: null },
  contractEnd: '2026-12-31',
  usage: { llm_calls: 12, expert_calls: 3, report_pages: 0, companion_devices: 1 },
};

function setup() {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  mockApi({
    'GET /tasks': () => json(200, { tasks: [] }),
    'GET /tasks?archived=true': () => json(200, { tasks: [] }),
    'GET /clients': () => json(200, { clients: CLIENTS }),
    'GET /skills': () => json(200, { skills: [SKILL] }),
    'GET /me/plan': () => json(200, { plan: PLAN }),
  });
  render(<AppShell account={{ name: '合成健管师', onLogout: () => {} }} />);
  return userEvent.setup();
}

describe('我的账号和按套餐隐藏入口（M7 规格 2.5）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('“我的账号”显示套餐、到期日和本月用量，不限的显示“不限”', async () => {
    const user = setup();
    await user.click(await screen.findByRole('button', { name: '我的账号' }));
    const dialog = await screen.findByRole('dialog', { name: '我的账号' });
    expect(await within(dialog).findByText('合成基础版')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('2026-12-31');
    expect(dialog).toHaveTextContent('本月 AI 调用已用 12 / 500');
    expect(dialog).toHaveTextContent('本月专家调用已用 3（不限）');
    expect(dialog).toHaveTextContent('危机、急症的提示不受额度限制');
  });

  it('套餐没有专家中心、方案与随访时，侧栏不显示对应入口', async () => {
    setup();
    const nav = await screen.findByRole('complementary', { name: 'Health Buddy' });
    await within(nav).findByRole('button', { name: '我的账号' });
    await vi.waitFor(() => expect(within(nav).queryByText('专家中心')).toBeNull());
    expect(within(nav).queryByText('方案库')).toBeNull();
  });
});
