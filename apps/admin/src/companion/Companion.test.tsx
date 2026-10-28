import { COMPANION_DEFAULT_SCRIPTS, type CurrentUser } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { json, makeThresholds, mockApi, NOW, USERS } from '../test/mockApi';
import { parseDeviceLines } from './DeviceBatchesPage';

/** 伴侣固定话术和出厂设备批次（M6 规格 2.10）。全部是合成数据，密钥和激活码都是测试值 */

const scripts = Object.entries(COMPANION_DEFAULT_SCRIPTS).map(([kind, text]) => ({
  kind,
  version: 1,
  text,
  updatedAt: NOW,
}));
const SECRET = 'x'.repeat(32);

function renderAs(user: CurrentUser, hash: string, routes: Parameters<typeof mockApi>[1] = {}) {
  window.location.hash = hash;
  const api = mockApi(user, {
    'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
    'GET /admin/companion/scripts': () => json(200, { scripts }),
    'GET /admin/companion/device-batches': () => json(200, { batches: [] }),
    ...routes,
  });
  render(<App />);
  return { api, user: userEvent.setup() };
}

afterEach(() => vi.unstubAllGlobals());

describe('伴侣话术和设备（平台后台）', () => {
  it('只有平台管理员能看到这两个版块', async () => {
    for (const role of ['operator_admin', 'org_admin'] as const) {
      renderAs(USERS[role], '#companion-scripts');
      await screen.findByRole('navigation');
      expect(screen.queryByRole('link', { name: '伴侣话术' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: '伴侣设备' })).not.toBeInTheDocument();
      document.body.innerHTML = '';
    }
  });

  it('话术：列出每种话术；修改后保存为新版本；不符合要求时标出问题', async () => {
    let attempt = 0;
    const { api, user } = renderAs(USERS.platform_admin, '#companion-scripts', {
      'PUT /admin/companion/scripts/handoff': () =>
        ++attempt === 1
          ? json(400, {
              error: 'invalid_content',
              issues: [{ category: 'manager_promise', term: '会给您打电话', index: 8 }],
            })
          : json(200, {
              kind: 'handoff',
              version: 2,
              text: '已经转给您的健管师了。',
              updatedAt: NOW,
            }),
    });
    expect(await screen.findByText(COMPANION_DEFAULT_SCRIPTS.crisis)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '伴侣话术' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '伴侣设备' })).toBeInTheDocument();
    expect(screen.getByText('线下告知书模板')).toBeInTheDocument();
    expect(screen.getByText('还没有内容')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '修改转交健管师' }));
    const dialog = screen.getByRole('dialog', { name: '修改：转交健管师' });
    const box = within(dialog).getByRole('textbox', { name: '内容' });
    await user.clear(box);
    await user.type(box, '已经转给健管师，她会给您打电话。');
    await user.click(within(dialog).getByRole('button', { name: '保存为新版本' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '替健管师承诺：会给您打电话',
    );
    await user.clear(box);
    await user.type(box, '已经转给您的健管师了。');
    await user.click(within(dialog).getByRole('button', { name: '保存为新版本' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已保存为第 2 版');
    expect(api.callsTo('PUT', '/admin/companion/scripts/handoff').at(-1)!.body).toEqual({
      text: '已经转给您的健管师了。',
    });
  });

  it('设备：粘贴清单导入；已导入过的序列号整批拒绝并列出', async () => {
    let attempt = 0;
    const { api, user } = renderAs(USERS.platform_admin, '#device-batches', {
      'POST /admin/companion/device-batches': () =>
        ++attempt === 1
          ? json(409, {
              error: 'conflict',
              reasons: ['duplicate_serials'],
              serials: ['HB-TEST-0001'],
            })
          : json(201, {
              id: '90000000-0000-4000-8000-000000000001',
              name: '第一批',
              deviceCount: 2,
              boundCount: 0,
              importedAt: NOW,
            }),
    });
    expect(await screen.findByText('还没有导入任何设备。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导入一批设备' }));
    const dialog = screen.getByRole('dialog', { name: '导入一批设备' });
    await user.type(within(dialog).getByRole('textbox', { name: '批次名称' }), '第一批');
    await user.type(
      within(dialog).getByRole('textbox', { name: '设备清单' }),
      `# 序列号,密钥,激活码\nHB-TEST-0001,${SECRET},ABCD1234\nHB-TEST-0002,${SECRET},EFGH5678`,
    );
    await user.click(within(dialog).getByRole('button', { name: '导入' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '这些序列号已经导入过：HB-TEST-0001',
    );
    await user.click(within(dialog).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('已导入“第一批”，共 2 台');
    expect(api.callsTo('POST', '/admin/companion/device-batches')[1]!.body).toEqual({
      name: '第一批',
      devices: [
        { serialNo: 'HB-TEST-0001', deviceSecret: SECRET, activationCode: 'ABCD1234' },
        { serialNo: 'HB-TEST-0002', deviceSecret: SECRET, activationCode: 'EFGH5678' },
      ],
    });
  });

  it('清单解析：逗号、中文逗号、制表符都可以；格式不对时标出行号', () => {
    expect(
      parseDeviceLines(`A1,${SECRET},ABCDEF\nA2\t${SECRET}\tGHIJKL\n\nA3，${SECRET}，MNOPQR`),
    ).toEqual({
      devices: [
        { serialNo: 'A1', deviceSecret: SECRET, activationCode: 'ABCDEF' },
        { serialNo: 'A2', deviceSecret: SECRET, activationCode: 'GHIJKL' },
        { serialNo: 'A3', deviceSecret: SECRET, activationCode: 'MNOPQR' },
      ],
    });
    expect(parseDeviceLines(`A1,${SECRET}\n# 注释\nA2,${SECRET},X,Y`)).toEqual({
      badLines: [1, 3],
    });
  });
});
