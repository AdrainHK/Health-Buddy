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
