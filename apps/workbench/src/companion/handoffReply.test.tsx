import type { ArtifactDetailResponse, CompanionHandoff } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArtifactView } from '../artifacts/ArtifactView';
import { NOW, ids, json, makeArtifactDetail, mockApi } from '../test/mockApi';
import { TwinActionsContext } from '../twin/TwinActions';
import { CasesSection } from './CompanionCases';
import { HandoffPicker } from './HandoffPicker';

/** /转交回复（M6 第 6b-1 步）：选转交、改回复、审核后发送给福宝。全部是合成数据 */

const HANDOFF_ID = '00000000-0000-4000-8000-0000000000f1';
const CASES = `/clients/${ids.clientA}/companion/cases`;
const SEND = `/artifacts/${ids.artifact}/send-handoff-reply`;

const handoff: CompanionHandoff = {
  id: HANDOFF_ID,
  clientId: ids.clientA,
  clientName: '合成客户甲',
  category: 'medication',
  question: '合成：我这个降压药到底能不能停呀，最近老是忘记吃',
  status: 'open',
  replyText: null,
  repliedAt: null,
  deliveredAt: null,
  closedAt: null,
  createdAt: NOW,
  overdue: false,
};

function replyDetail(
  status: 'draft' | 'approved',
  extra: Partial<ArtifactDetailResponse> = {},
): ArtifactDetailResponse {
  return makeArtifactDetail(
    {
      skillId: 'handoff-reply',
      status,
      clientFacing: false,
      content: {
        professional: '## 回复（福宝会原样念给客户）\n用药的事请向开药医生确认。',
        clientFacing: '',
      },
      structured: { handoffId: HANDOFF_ID, reply: '用药的事请向开药医生确认。' },
    },
    extra,
  );
}

function renderView(detail: ArtifactDetailResponse, onDetail = vi.fn()) {
  render(
    <ArtifactView
      detail={detail}
      readOnly={false}
      onDetail={onDetail}
      onReload={() => {}}
      onOpen={() => {}}
      onChanged={() => {}}
      onReadOnly={() => {}}
      onBack={() => {}}
    />,
  );
  return onDetail;
}

afterEach(() => vi.unstubAllGlobals());

describe('/转交回复', () => {
  it('输入框上方列出未处理的转交，原话只显示前 20 字；选一个', async () => {
    mockApi({
      [`GET ${CASES}`]: () =>
        json(200, {
          alerts: [],
          handoffs: [handoff, { ...handoff, id: ids.artifact, status: 'replied' }],
        }),
    });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <HandoffPicker clientId={ids.clientA} readOnly={false} selected={[]} onSelect={onSelect} />,
    );
    const list = await screen.findByRole('list', { name: '未处理的伴侣转交' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent(/用药问题 · 合成：我这个降压药到底能不能停呀.*…/);
    expect(list).not.toHaveTextContent('忘记吃');
    await user.click(within(list).getByRole('radio'));
    expect(onSelect).toHaveBeenCalledWith([HANDOFF_ID]);
  });

  it('伴侣视图的转交：“让 AI 起草”打开 /转交回复 并带上这个转交', async () => {
    mockApi({
      [`GET ${CASES}`]: () => json(200, { alerts: [], handoffs: [handoff] }),
      [`GET /clients/${ids.clientA}/companion/observations`]: () => json(200, { observations: [] }),
    });
    const handoffReply = vi.fn();
    const user = userEvent.setup();
    render(
      <TwinActionsContext.Provider value={{ handoffReply }}>
        <CasesSection clientId={ids.clientA} />
      </TwinActionsContext.Provider>,
    );
    await user.click(await screen.findByRole('button', { name: '让 AI 起草' }));
    expect(handoffReply).toHaveBeenCalledWith(
      { id: ids.clientA, displayName: '合成客户甲' },
      HANDOFF_ID,
    );
  });

  it('草稿：默认打开回复编辑框，显示字数；清空后不能保存；没有发送按钮', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderView(replyDetail('draft'));
    const box = screen.getByRole('textbox', { name: /念给客户的回复/ });
    expect(box).toHaveValue('用药的事请向开药医生确认。');
    expect(screen.getByText('13 / 150 字')).toBeInTheDocument();
    await user.clear(box);
    expect(screen.getByText('回复不能为空')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发送给福宝' })).not.toBeInTheDocument();
  });

  it('审核通过后发送：先确认；有药名提醒时列出，确认后带 acknowledgeWarnings 再发', async () => {
    let calls = 0;
    const sent = replyDetail('approved', {
      events: [
        {
          id: ids.task,
          artifactId: ids.artifact,
          actorId: ids.manager,
          action: 'companion_reply_sent',
          reason: null,
          format: null,
          createdAt: NOW,
        },
      ],
    });
    const api = mockApi({
      [`POST ${SEND}`]: () =>
        ++calls === 1
          ? json(400, { error: 'invalid_content', reasons: ['needs_confirmation', 'drug_name'] })
          : json(200, sent),
    });
    const user = userEvent.setup();
    const onDetail = renderView(replyDetail('approved'));
    await user.click(screen.getByRole('button', { name: '发送给福宝' }));
    await user.click(screen.getByRole('button', { name: '确认发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('药名');
    await user.click(screen.getByRole('button', { name: '仍然发送' }));
    await waitFor(() => expect(onDetail).toHaveBeenCalledWith(sent));
    expect(api.callsTo('POST', SEND).map((c) => c.body)).toEqual([
      { acknowledgeWarnings: false },
      { acknowledgeWarnings: true },
    ]);
  });

  it('已发送的显示时间；转交已关闭时提示不能再发', async () => {
    mockApi({
      [`POST ${SEND}`]: () => json(409, { error: 'conflict', reasons: ['handoff_closed'] }),
    });
    const user = userEvent.setup();
    renderView(replyDetail('approved'));
    await user.click(screen.getByRole('button', { name: '发送给福宝' }));
    await user.click(screen.getByRole('button', { name: '确认发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已经回复或关闭');
  });
});
