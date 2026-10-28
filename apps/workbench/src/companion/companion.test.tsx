import type { ClientSummary, CompanionOverview } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browserTimeZone } from '../api/twin';
import { localToday } from '../care/dates';
import { NOW, ids, json, mockApi } from '../test/mockApi';
import { CompanionView } from './CompanionView';

/** 结果区“客户 · 伴侣”（M6 规格 2.1、2.8）。全部是合成数据，序列号和激活码都是测试值 */

const CLIENT: ClientSummary = {
  id: ids.clientA,
  displayName: '合成客户甲',
  gender: 'female',
  birthYear: 1958,
  managerId: ids.manager,
  isSynthetic: true,
};
const BASE = `/clients/${ids.clientA}/companion`;
const zone = browserTimeZone();
const TZ = zone ? `?tz=${encodeURIComponent(zone)}` : '';
const NOTICE = { kind: 'notice', version: 2, text: '合成告知书正文', updatedAt: NOW };

function overview(over: Partial<CompanionOverview> = {}): CompanionOverview {
  return {
    status: 'unbound',
    device: null,
    consent: null,
    settings: { nameForClient: null, voiceSpeed: 'slow', volume: 'medium' },
    currentNoticeVersion: 2,
    ...over,
  };
}

const consented = {
  noticeVersion: 2,
  consentedOn: '2026-10-10',
  recordedAt: NOW,
  revokedOn: null,
};
const boundDevice = {
  serialLast4: '0001',
  status: 'bound' as const,
  boundAt: NOW,
  activatedAt: null,
  lastSeenAt: null,
  online: false,
  firmwareVersion: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('伴侣视图', () => {
  it('没有同意时不能绑定；勾选确认后按当前告知书版本记录同意', async () => {
    const api = mockApi({
      [`GET ${BASE}`]: () => json(200, overview()),
      'GET /companion/notice': () => json(200, NOTICE),
      [`POST ${BASE}/consents${TZ}`]: () => json(200, overview({ consent: consented })),
    });
    const user = userEvent.setup();
    render(<CompanionView client={CLIENT} />);
    expect(
      await screen.findByText('请先在下方记录线下告知和同意，再绑定设备。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '绑定设备' })).not.toBeInTheDocument();
    const record = screen.getByRole('button', { name: '记录同意' });
    expect(record).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: '我已按第 2 版告知书向客户本人线下告知，并取得客户同意',
      }),
    );
    await user.click(record);
    await waitFor(() => expect(api.callsTo('POST', `${BASE}/consents${TZ}`)).toHaveLength(1));
    expect(api.callsTo('POST', `${BASE}/consents${TZ}`)[0]!.body).toEqual({
      noticeVersion: 2,
      consentedOn: localToday(),
      confirmed: true,
    });
    expect(await screen.findByRole('form', { name: '绑定设备' })).toBeInTheDocument();
  });

  it('平台没有告知书模板时不能记录同意', async () => {
    mockApi({ [`GET ${BASE}`]: () => json(200, overview({ currentNoticeVersion: null })) });
    render(<CompanionView client={CLIENT} />);
    expect(
      await screen.findByText('平台还没有发布告知书模板，暂时不能记录同意。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '记录同意' })).not.toBeInTheDocument();
  });

  it('绑定：序列号或激活码不可用时只提示“不可用”；成功后显示尾号和待激活', async () => {
    let attempt = 0;
    const api = mockApi({
      [`GET ${BASE}`]: () => json(200, overview({ consent: consented })),
      'GET /companion/notice': () => json(200, NOTICE),
      [`POST ${BASE}/device`]: () =>
        ++attempt === 1
          ? json(409, { error: 'conflict', reasons: ['device_unavailable'] })
          : json(
              200,
              overview({ status: 'pending_activation', consent: consented, device: boundDevice }),
            ),
    });
    const user = userEvent.setup();
    render(<CompanionView client={CLIENT} />);
    const form = await screen.findByRole('form', { name: '绑定设备' });
    await user.type(within(form).getByRole('textbox', { name: '序列号' }), 'HB-TEST-0001');
    await user.type(within(form).getByRole('textbox', { name: '激活码' }), 'abcd-1234');
    await user.click(within(form).getByRole('button', { name: '绑定' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      '序列号或激活码不可用，请核对设备背面的信息。',
    );
    await user.click(within(form).getByRole('button', { name: '绑定' }));
    expect(await screen.findByText('尾号 0001')).toBeInTheDocument();
    expect(screen.getByText('待激活')).toBeInTheDocument();
    expect(api.callsTo('POST', `${BASE}/device`)[0]!.body).toEqual({
      serialNo: 'HB-TEST-0001',
      activationCode: 'abcd-1234',
    });
  });

  it('暂停、解绑要再确认一次', async () => {
    const bound = overview({
      status: 'pending_activation',
      consent: consented,
      device: boundDevice,
    });
    const api = mockApi({
      [`GET ${BASE}`]: () => json(200, bound),
      'GET /companion/notice': () => json(200, NOTICE),
      [`POST ${BASE}/pause`]: () =>
        json(200, { ...bound, status: 'paused', device: { ...boundDevice, status: 'paused' } }),
      [`DELETE ${BASE}/device`]: () => json(200, overview({ consent: consented })),
    });
    const user = userEvent.setup();
    render(<CompanionView client={CLIENT} />);
    await user.click(await screen.findByRole('button', { name: '暂停' }));
    expect(await screen.findByRole('button', { name: '恢复' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '解绑设备' }));
    expect(api.callsTo('DELETE', `${BASE}/device`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '确定解绑' }));
    expect(await screen.findByText('这位客户还没有绑定设备。')).toBeInTheDocument();
    expect(api.callsTo('DELETE', `${BASE}/device`)).toHaveLength(1);
  });

  it('告知书有新版本时提示重新告知；设置只提交改动后的值', async () => {
    const api = mockApi({
      [`GET ${BASE}`]: () => json(200, overview({ consent: { ...consented, noticeVersion: 1 } })),
      'GET /companion/notice': () => json(200, NOTICE),
      [`PATCH ${BASE}`]: () =>
        json(
          200,
          overview({
            consent: { ...consented, noticeVersion: 1 },
            settings: { nameForClient: '王阿姨', voiceSpeed: 'medium', volume: 'medium' },
          }),
        ),
    });
    const user = userEvent.setup();
    render(<CompanionView client={CLIENT} />);
    expect(
      await screen.findByText('平台已发布新版告知书，请向客户重新告知后再记录一次。'),
    ).toBeInTheDocument();
    const save = screen.getByRole('button', { name: '保存设置' });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /福宝怎么称呼客户/ }), '王阿姨');
    await user.selectOptions(screen.getByRole('combobox', { name: '语速' }), 'medium');
    await user.click(save);
    await waitFor(() => expect(api.callsTo('PATCH', BASE)).toHaveLength(1));
    expect(api.callsTo('PATCH', BASE)[0]!.body).toEqual({
      nameForClient: '王阿姨',
      voiceSpeed: 'medium',
      volume: 'medium',
    });
  });

  it('别人的客户：显示找不到', async () => {
    mockApi({});
    render(<CompanionView client={CLIENT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '找不到这位客户，可能已经转给其他健管师。',
    );
  });
});
