import { ids } from '../test/mockApi';
import {
  conversationReducer,
  emptyConversation,
  type Conversation,
  type ViewMessage,
} from './conversation';

const assistant: ViewMessage = {
  id: 'local:1',
  role: 'assistant',
  mode: 'craft',
  content: '',
  skillId: null,
  clientRefs: [],
  status: 'streaming',
};

function started(): Conversation {
  return conversationReducer(emptyConversation, { type: 'start', assistant });
}

describe('conversationReducer', () => {
  it('adopts the server message id from the first event and appends text', () => {
    let s = started();
    s = conversationReducer(s, {
      type: 'event',
      event: { type: 'text', messageId: ids.assistantMsg, delta: '甲' },
    });
    s = conversationReducer(s, {
      type: 'event',
      event: { type: 'text', messageId: ids.assistantMsg, delta: '乙' },
    });
    expect(s.streamingId).toBe(ids.assistantMsg);
    expect(s.messages).toEqual([{ ...assistant, id: ids.assistantMsg, content: '甲乙' }]);
  });

  it('clears streamed text on done(refused) and restores the saved content later', () => {
    let s = started();
    s = conversationReducer(s, {
      type: 'event',
      event: { type: 'text', messageId: ids.assistantMsg, delta: '半截' },
    });
    s = conversationReducer(s, {
      type: 'event',
      event: { type: 'done', messageId: ids.assistantMsg, reason: 'refused' },
    });
    expect(s.streamingId).toBeNull();
    expect(s.messages[0]).toMatchObject({ content: '', status: 'refused', refused: true });

    s = conversationReducer(s, {
      type: 'restore',
      message: {
        id: ids.assistantMsg,
        role: 'assistant',
        mode: 'craft',
        content: '固定提醒',
        skillId: null,
        clientRefs: [],
        reportRefs: [],
        expertRefs: [],
        excludedExperts: [],
        twinRefs: [],
        libraryRefs: [],
        materialRefs: [],
        handoffRefs: [],
        planOptions: null,
        status: 'refused',
        createdAt: '2026-10-15T08:00:00.000Z',
      },
    });
    expect(s.messages[0]).toMatchObject({ content: '固定提醒', refused: true });
  });

  it('marks a stream that ends without done as a network error, or stopped when aborted', () => {
    expect(conversationReducer(started(), { type: 'end' }).messages[0]).toMatchObject({
      status: 'error',
      errorKind: 'network',
    });
    expect(
      conversationReducer(started(), { type: 'end', stopped: true }).messages[0],
    ).toMatchObject({ status: 'stopped' });
  });

  it('rolls back local messages when the request is rejected', () => {
    const s = conversationReducer(started(), { type: 'rollback', ids: ['local:1'] });
    expect(s).toEqual(emptyConversation);
  });
});

describe('conversationReducer：专家调用（M3 规格 2.6）', () => {
  const ev = (expertId: string, status: 'running' | 'done' | 'timeout') =>
    ({
      type: 'event',
      event: {
        type: 'expert_call',
        consultationId: '90000000-0000-4000-8000-0000000000c1',
        expertId,
        status,
        failureCategory: status === 'timeout' ? 'timeout' : null,
      },
    }) as const;

  it('每位专家的状态单独记在正在接收的回答上，换成真实 id 时一起搬过去', () => {
    let s = started();
    s = conversationReducer(s, ev('nutrition', 'running'));
    expect(s.expertCalls['local:1']).toEqual({
      nutrition: { status: 'running', failureCategory: null },
    });
    s = conversationReducer(s, {
      type: 'event',
      event: { type: 'text', messageId: ids.assistantMsg, delta: '甲' },
    });
    s = conversationReducer(s, ev('endocrine-metabolism', 'done'));
    s = conversationReducer(s, ev('nutrition', 'timeout'));
    expect(s.expertCalls['local:1']).toBeUndefined();
    expect(s.expertCalls[ids.assistantMsg]).toEqual({
      nutrition: { status: 'timeout', failureCategory: 'timeout' },
      'endocrine-metabolism': { status: 'done', failureCategory: null },
    });
  });

  it('本地停止时还在进行的专家标为已停止，已回复的保留', () => {
    let s = started();
    s = conversationReducer(s, ev('nutrition', 'running'));
    s = conversationReducer(s, ev('endocrine-metabolism', 'done'));
    s = conversationReducer(s, { type: 'end', stopped: true });
    expect(s.expertCalls['local:1']).toEqual({
      nutrition: { status: 'stopped', failureCategory: null },
      'endocrine-metabolism': { status: 'done', failureCategory: null },
    });
  });

  it('consultation 事件的危机、急症信号记在回答上（换成真实 id 时一起搬过去），没有信号时不记', () => {
    const consultationEvent = (crisisSignal: boolean, emergencySignal: boolean) =>
      ({
        type: 'event',
        event: {
          type: 'consultation',
          consultationId: '90000000-0000-4000-8000-0000000000c1',
          status: 'failed',
          crisisSignal,
          emergencySignal,
        },
      }) as const;
    let s = conversationReducer(started(), consultationEvent(false, false));
    expect(s.expertSignals).toEqual({});
    s = conversationReducer(s, consultationEvent(false, true));
    expect(s.expertSignals['local:1']).toEqual({ crisis: false, emergency: true });
    s = conversationReducer(s, {
      type: 'event',
      event: { type: 'text', messageId: ids.assistantMsg, delta: '甲' },
    });
    s = conversationReducer(s, consultationEvent(true, false));
    expect(s.expertSignals).toEqual({ [ids.assistantMsg]: { crisis: true, emergency: true } });
  });
});
