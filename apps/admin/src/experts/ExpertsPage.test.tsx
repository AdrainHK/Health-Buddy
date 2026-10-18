import type { CurrentUser } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import {
  expertIds,
  ids,
  json,
  makeAdminExperts,
  makeStats,
  makeThresholds,
  mockApi,
  NOW,
  USERS,
} from '../test/mockApi';

function renderAt(hash: string, user: CurrentUser, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = hash;
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/experts': () => json(200, makeAdminExperts()),
    'GET /expert-stats': () => json(200, makeStats(user.role === 'platform_admin')),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

const rowOf = async (name: string) => {
  const header = await screen.findByRole('rowheader', { name });
  return header.closest('tr')!;
};

describe('专家管理（平台管理员）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('列出每位专家的版本、知识来源版本、状态、评测用例、上下架、调用次数和有用/没用', async () => {
    renderAt('#experts', USERS.platform_admin);
    expect(await screen.findByRole('heading', { name: '专家管理' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '专家管理' })).toHaveAttribute('aria-current', 'page');

    const nutrition = await rowOf('营养专家');
    expect(nutrition).toHaveTextContent('0.1.0');
    expect(nutrition).toHaveTextContent('0123456789ab');
    expect(nutrition).toHaveTextContent('待确认');
    expect(nutrition).toHaveTextContent('当前环境不可用');
    expect(nutrition).toHaveTextContent('知识来源待医学顾问确认');
    expect(nutrition).toHaveTextContent('7 / 15');
    expect(nutrition).toHaveTextContent('使用中');
    expect(nutrition).toHaveTextContent('12');
    expect(nutrition).toHaveTextContent('5 / 2');

    const cardio = await rowOf('心血管专家');
    expect(cardio).toHaveTextContent('已暂停');
    expect(within(cardio).getByRole('button', { name: '恢复心血管专家' })).toBeInTheDocument();
    expect(screen.getByText(/2026-09-16 至 2026-10-15/)).toBeInTheDocument();
  });

  it('暂停需要二次确认：取消不发请求，确认后发请求并刷新列表', async () => {
    let paused = false;
    const { api, user } = renderAt('#experts', USERS.platform_admin, {
      'GET /admin/experts': () => {
        const res = makeAdminExperts();
        res.experts[0]!.enabled = !paused;
        return json(200, res);
      },
      'PATCH /admin/experts/nutrition/availability': () => {
        paused = true;
        return new Response(null, { status: 204 });
      },
    });

    await user.click(await screen.findByRole('button', { name: '暂停营养专家' }));
    let dialog = screen.getByRole('dialog', { name: '暂停营养专家？' });
    expect(dialog).toHaveTextContent('已有的历史意见仍可查看');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '暂停营养专家' }));
    dialog = screen.getByRole('dialog', { name: '暂停营养专家？' });
    await user.click(within(dialog).getByRole('button', { name: '确定暂停' }));
    expect(api.callsTo('PATCH', '/admin/experts/nutrition/availability')[0]?.body).toEqual({
      enabled: false,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('已暂停营养专家');
    const row = await rowOf('营养专家');
    expect(await within(row).findByRole('button', { name: '恢复营养专家' })).toBeInTheDocument();
    expect(api.callsTo('GET', '/admin/experts')).toHaveLength(2);
  });

  it('恢复同样需要确认；失败时提示', async () => {
    const { api, user } = renderAt('#experts', USERS.platform_admin, {
      'PATCH /admin/experts/cardiovascular/availability': () =>
        json(500, { error: 'internal_error' }),
    });
    await user.click(await screen.findByRole('button', { name: '恢复心血管专家' }));
    const dialog = screen.getByRole('dialog', { name: '恢复心血管专家？' });
    await user.click(within(dialog).getByRole('button', { name: '确定恢复' }));
    expect(api.callsTo('PATCH', '/admin/experts/cardiovascular/availability')[0]?.body).toEqual({
      enabled: true,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('操作失败，请稍后再试');
  });

  it('查看暂停和恢复记录：操作人只显示“我”或“平台管理员”', async () => {
    const { user } = renderAt('#experts', USERS.platform_admin, {
      'GET /admin/experts/cardiovascular/availability-events': () =>
        json(200, {
          events: [
            {
              id: expertIds.event2,
              expertId: 'cardiovascular',
              action: 'paused',
              actorId: ids.platformAdmin,
              createdAt: NOW,
            },
            {
              id: expertIds.event1,
              expertId: 'cardiovascular',
              action: 'resumed',
              actorId: ids.otherAdmin,
              createdAt: NOW,
            },
          ],
        }),
      'GET /admin/experts/nutrition/availability-events': () => json(200, { events: [] }),
    });
    await user.click(await screen.findByRole('button', { name: '查看心血管专家的暂停和恢复记录' }));
    const history = await screen.findByRole('region', { name: '心血管专家的暂停和恢复记录' });
    const items = await within(history).findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('暂停');
    expect(items[0]).toHaveTextContent('我');
    expect(items[1]).toHaveTextContent('恢复');
    expect(items[1]).toHaveTextContent('平台管理员');

    await user.click(screen.getByRole('button', { name: '查看营养专家的暂停和恢复记录' }));
    expect(await screen.findByText('还没有暂停或恢复过')).toBeInTheDocument();
  });

  it('加载失败时可以重试', async () => {
    let fail = true;
    const { user } = renderAt('#experts', USERS.platform_admin, {
      'GET /admin/experts': () =>
        fail ? json(500, { error: 'internal_error' }) : json(200, makeAdminExperts()),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('专家列表加载失败');
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await rowOf('营养专家');
  });

  it.each([
    ['协会管理员', USERS.operator_admin],
    ['机构管理员', USERS.org_admin],
  ])('%s看不到专家管理，地址栏指向它时也不请求专家接口', async (_label, account) => {
    const { api } = renderAt('#experts', account);
    expect(await screen.findByRole('heading', { name: '危急指标设置' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '专家管理' })).not.toBeInTheDocument();
    expect(api.callsTo('GET', '/admin/experts')).toHaveLength(0);
    expect(api.writes()).toHaveLength(0);
  });
});
