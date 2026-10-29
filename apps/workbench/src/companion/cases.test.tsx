import type {
  CompanionAlert,
  CompanionHandoff,
  CompanionInboxResponse,
  CompanionObservation,
} from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOW, ids, json, mockApi } from '../test/mockApi';
import { CasesSection } from './CompanionCases';
import { ChatSection } from './CompanionChat';
import { CompanionInboxGroup, companionInboxCount } from './CompanionInbox';

/** 福宝的预警、转交、收集信息、聊天（M6 第 6 步）。全部是合成数据 */

const ALERT_ID = '00000000-0000-4000-8000-0000000000e1';
const HANDOFF_ID = '00000000-0000-4000-8000-0000000000e2';
const OBS_ID = '00000000-0000-4000-8000-0000000000e3';
const MEMORY_ID = '00000000-0000-4000-8000-0000000000e4';
const SESSION_ID = '00000000-0000-4000-8000-0000000000e5';

const alert: CompanionAlert = {
  id: ALERT_ID,
  clientId: ids.clientA,
  clientName: '合成客户甲',
  category: 'crisis',
  trigger: 'keyword',
  said: '合成：活着没意思',
  companionSaid: '请马上联系家人，或拨打 120。',
  status: 'open',
  resolution: null,
  note: null,
  handledAt: null,
  createdAt: NOW,
};
const handoff: CompanionHandoff = {
  id: HANDOFF_ID,
  clientId: ids.clientA,
  clientName: '合成客户甲',
  category: 'medication',
  question: '合成：降压药能不能停',
  status: 'open',
  replyText: null,
  repliedAt: null,
  deliveredAt: null,
  closedAt: null,
  createdAt: NOW,
  overdue: true,
};
const pending: CompanionObservation = {
  id: OBS_ID,
  clientId: ids.clientA,
  category: 'measurement',
  polarity: null,
  text: '客户说昨天血压一百五、九十五',
  observedOn: '2026-10-28',
  metric: 'bp',
  values: [150, 95],
  status: 'pending_confirm',
  createdAt: NOW,
};

afterEach(() => vi.unstubAllGlobals());

describe('伴侣视图 · 预警、转交、收集信息', () => {
  const CASES = `/clients/${ids.clientA}/companion/cases`;
  const OBS = `/clients/${ids.clientA}/companion/observations`;

  it('预警处理方式必填，选“其他”时备注必填；不能忽略', async () => {
    const api = mockApi({
      [`GET ${CASES}`]: () => json(200, { alerts: [alert], handoffs: [] }),
      [`GET ${OBS}`]: () => json(200, { observations: [] }),
      [`POST /companion/alerts/${ALERT_ID}/handle`]: () =>
        json(200, { ...alert, status: 'handled', resolution: 'other', note: '合成备注' }),
    });
    const user = userEvent.setup();
    render(<CasesSection clientId={ids.clientA} />);
    expect(await screen.findByText('客户说：“合成：活着没意思”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /忽略/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '处理' }));
    const form = screen.getByRole('form', { name: '处理预警' });
    const submit = within(form).getByRole('button', { name: '标记为已处理' });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('处理方式（必填）'), 'other');
    expect(submit).toBeDisabled();
    await user.type(within(form).getByRole('textbox'), '合成备注');
    await user.click(submit);
    await waitFor(() =>
      expect(api.callsTo('POST', `/companion/alerts/${ALERT_ID}/handle`)).toHaveLength(1),
    );
    expect(api.callsTo('POST', `/companion/alerts/${ALERT_ID}/handle`)[0]!.body).toEqual({
      resolution: 'other',
      note: '合成备注',
    });
  });

  it('转交：写回复发给福宝；含禁用词时提示修改；超时的标出', async () => {
    mockApi({
      [`GET ${CASES}`]: () => json(200, { alerts: [], handoffs: [handoff] }),
      [`GET ${OBS}`]: () => json(200, { observations: [] }),
      [`POST /companion/handoffs/${HANDOFF_ID}/reply`]: () =>
        json(400, { error: 'invalid_content', reasons: ['banned_term'] }),
    });
    const user = userEvent.setup();
    render(<CasesSection clientId={ids.clientA} />);
    expect(await screen.findByText('已超时')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '写回复' }));
    const form = screen.getByRole('form', { name: '回复客户' });
    await user.type(within(form).getByRole('textbox'), '这个能根治');
    await user.click(within(form).getByRole('button', { name: '发送给福宝' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('不能对客户说的词');
  });

  it('回复里有药名：先看提醒，确认后带 acknowledgeWarnings 再发', async () => {
    let calls = 0;
    const api = mockApi({
      [`GET ${CASES}`]: () => json(200, { alerts: [], handoffs: [handoff] }),
      [`GET ${OBS}`]: () => json(200, { observations: [] }),
      [`POST /companion/handoffs/${HANDOFF_ID}/reply`]: () =>
        ++calls === 1
          ? json(400, { error: 'invalid_content', reasons: ['needs_confirmation', 'drug_name'] })
          : json(200, { ...handoff, status: 'replied', replyText: '合成回复' }),
    });
    const user = userEvent.setup();
    render(<CasesSection clientId={ids.clientA} />);
    await user.click(await screen.findByRole('button', { name: '写回复' }));
    const form = screen.getByRole('form', { name: '回复客户' });
    await user.type(within(form).getByRole('textbox'), '降压药先别停');
    await user.click(within(form).getByRole('button', { name: '发送给福宝' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('药名');
    await user.click(within(form).getByRole('button', { name: '仍然发送' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/companion/handoffs/${HANDOFF_ID}/reply`)).toHaveLength(2),
    );
    expect(api.callsTo('POST', `/companion/handoffs/${HANDOFF_ID}/reply`)[1]!.body).toEqual({
      text: '降压药先别停',
      acknowledgeWarnings: true,
    });
  });

  it('待确认的测量：确认后写进监测', async () => {
    const api = mockApi({
      [`GET ${CASES}`]: () => json(200, { alerts: [], handoffs: [] }),
      [`GET ${OBS}`]: () => json(200, { observations: [pending] }),
      [`POST /companion/observations/${OBS_ID}/confirm`]: () =>
        json(200, { ...pending, status: 'confirmed' }),
    });
    const user = userEvent.setup();
    render(<CasesSection clientId={ids.clientA} />);
    expect(await screen.findByText('客户报的血压：150 / 95 毫米汞柱')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认并写进监测' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/companion/observations/${OBS_ID}/confirm`)).toHaveLength(1),
    );
  });
});

describe('今日跟进 · 伴侣分组', () => {
  const inbox: CompanionInboxResponse = {
    alerts: [alert],
    handoffs: [handoff],
    pendingReadings: [{ ...pending, clientName: '合成客户甲' }],
    offlineDevices: [{ clientId: ids.clientB, clientName: '合成客户乙', lastSeenAt: NOW }],
  };

  it('预警在最上面；角标是预警、转交、待确认三组之和；离线点“知道了”', async () => {
    const api = mockApi({
      [`POST /clients/${ids.clientB}/companion/offline-ack`]: () =>
        new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const onOpenClient = vi.fn();
    render(
      <CompanionInboxGroup
        state={{ status: 'ready', data: inbox }}
        onRetry={() => {}}
        onOpenClient={onOpenClient}
        onChanged={onChanged}
      />,
    );
    expect(companionInboxCount(inbox)).toBe(3);
    const lists = screen.getAllByRole('list');
    expect(lists[0]).toHaveAccessibleName('伴侣预警');
    await user.click(within(lists[0]!).getByRole('button', { name: '合成客户甲' }));
    expect(onOpenClient).toHaveBeenCalledWith(ids.clientA);
    await user.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/clients/${ids.clientB}/companion/offline-ack`)).toHaveLength(1),
    );
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('伴侣视图 · 聊天和记忆', () => {
  it('按会话列出聊天；可以删记忆', async () => {
    const MEM = `/clients/${ids.clientA}/companion/memories`;
    const api = mockApi({
      [`GET /clients/${ids.clientA}/companion/sessions`]: () =>
        json(200, {
          sessions: [
            {
              id: SESSION_ID,
              startedAt: NOW,
              endedAt: NOW,
              summary: '聊了孙子放假。',
              messages: [
                {
                  id: '1',
                  role: 'client',
                  kind: 'chat',
                  content: '合成：孙子要回来了',
                  createdAt: NOW,
                },
                { id: '2', role: 'companion', kind: 'chat', content: '真好呀。', createdAt: NOW },
              ],
            },
          ],
          next: null,
        }),
      [`GET ${MEM}`]: () =>
        json(200, { memories: [{ id: MEMORY_ID, text: '客户喜欢听京剧', createdAt: NOW }] }),
      [`DELETE ${MEM}/${MEMORY_ID}`]: () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<ChatSection clientId={ids.clientA} />);
    expect(await screen.findByText(/聊了孙子放假/)).toBeInTheDocument();
    expect(screen.getByText('合成：孙子要回来了')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.callsTo('DELETE', `${MEM}/${MEMORY_ID}`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('客户喜欢听京剧')).not.toBeInTheDocument());
  });
});
