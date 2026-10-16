import type {
  ArtifactSummary,
  MessageStatus,
  TaskDetailResponse,
  TaskMessage,
  TaskMode,
  TaskPlan,
  TaskStep,
  TaskStreamEvent,
} from '@health-buddy/shared';

/** 流式事件里的错误类别，加上前端自己发现的断网 */
export type StreamErrorKind = Extract<TaskStreamEvent, { type: 'error' }>['kind'] | 'network';

/** 对话区显示的一条消息。除了保存的字段，还带本轮流式过程中收到、但后端不保存的信息。 */
export interface ViewMessage {
  id: string;
  role: TaskMessage['role'];
  mode: TaskMode;
  content: string;
  skillId: string | null;
  clientRefs: string[];
  /** @ 引用的已核对报告（规格 2.6） */
  reportRefs?: string[];
  status: MessageStatus;
  /** 技能建议（Q5），只建议不执行 */
  suggestion?: string;
  /** 本轮生成的草稿 */
  artifacts?: ArtifactSummary[];
  errorKind?: StreamErrorKind;
  /** 模型拒答：已清空流式文本，显示的是后端保存的内容 */
  refused?: boolean;
}

export interface Conversation {
  messages: ViewMessage[];
  steps: TaskStep[];
  plans: TaskPlan[];
  /** 正在接收流式事件的回答。开始时是本地临时 id，收到第一个带 messageId 的事件后换成真实 id。 */
  streamingId: string | null;
}

export const emptyConversation: Conversation = {
  messages: [],
  steps: [],
  plans: [],
  streamingId: null,
};

export const LOCAL_PREFIX = 'local:';

export type ConversationAction =
  | { type: 'reset' }
  | { type: 'load'; detail: TaskDetailResponse }
  /** 开始一轮：加入本地消息（健管师消息可选），回答作为正在流式接收的消息 */
  | { type: 'start'; manager?: ViewMessage; assistant: ViewMessage }
  /** 流还没打开就失败了（409、429 等）：撤回本地加的消息 */
  | { type: 'rollback'; ids: string[] }
  | { type: 'event'; event: TaskStreamEvent }
  /** 流结束。没收到 done 就断开时，把回答标为出错；本地取消时标为已停止 */
  | { type: 'end'; errorKind?: StreamErrorKind; stopped?: boolean }
  /** 拒答后重新加载到的已保存内容 */
  | { type: 'restore'; message: TaskMessage }
  | { type: 'planConfirmed'; planId: string };

function updateMessage(
  messages: ViewMessage[],
  id: string,
  fn: (m: ViewMessage) => ViewMessage,
): ViewMessage[] {
  return messages.map((m) => (m.id === id ? fn(m) : m));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

/** 第一个带 messageId 的事件到达时，把本地临时 id 换成真实 id */
function adopt(state: Conversation, messageId: string): Conversation {
  const current = state.streamingId;
  if (!current || current === messageId || !current.startsWith(LOCAL_PREFIX)) return state;
  return {
    ...state,
    streamingId: messageId,
    messages: updateMessage(state.messages, current, (m) => ({ ...m, id: messageId })),
  };
}

function eventMessageId(event: TaskStreamEvent): string | undefined {
  switch (event.type) {
    case 'text':
    case 'done':
      return event.messageId;
    case 'step':
      return event.step.messageId;
    case 'plan':
      return event.plan.messageId;
    default:
      return undefined;
  }
}

function applyEvent(state: Conversation, event: TaskStreamEvent): Conversation {
  const messageId = eventMessageId(event);
  const s = messageId ? adopt(state, messageId) : state;
  const target = messageId ?? s.streamingId;
  if (!target) return s;
  switch (event.type) {
    case 'text':
      return {
        ...s,
        messages: updateMessage(s.messages, target, (m) => ({
          ...m,
          content: m.content + event.delta,
        })),
      };
    case 'step':
      return { ...s, steps: upsert(s.steps, event.step) };
    case 'plan':
      return { ...s, plans: upsert(s.plans, event.plan) };
    case 'artifact':
      return {
        ...s,
        messages: updateMessage(s.messages, target, (m) => ({
          ...m,
          artifacts: [...(m.artifacts ?? []), event.artifact],
        })),
      };
    case 'suggestion':
      return {
        ...s,
        messages: updateMessage(s.messages, target, (m) => ({ ...m, suggestion: event.skillId })),
      };
    case 'error':
      return {
        ...s,
        messages: updateMessage(s.messages, target, (m) => ({ ...m, errorKind: event.kind })),
      };
    case 'done':
      return {
        ...s,
        streamingId: s.streamingId === target ? null : s.streamingId,
        messages: updateMessage(s.messages, target, (m) =>
          event.reason === 'refused'
            ? // 拒答：本轮流式显示的文本全部丢掉，稍后换成后端保存的内容
              { ...m, status: 'refused', content: '', refused: true }
            : { ...m, status: event.reason },
        ),
      };
  }
}

function fromMessage(m: TaskMessage): ViewMessage {
  return {
    id: m.id,
    role: m.role,
    mode: m.mode,
    content: m.content,
    skillId: m.skillId,
    clientRefs: m.clientRefs,
    ...(m.reportRefs.length ? { reportRefs: m.reportRefs } : {}),
    status: m.status,
    ...(m.status === 'refused' ? { refused: true } : {}),
  };
}

export function conversationReducer(state: Conversation, action: ConversationAction): Conversation {
  switch (action.type) {
    case 'reset':
      return emptyConversation;
    case 'load':
      return {
        messages: action.detail.messages.map(fromMessage),
        steps: action.detail.steps,
        plans: action.detail.plans,
        streamingId: null,
      };
    case 'start':
      return {
        ...state,
        streamingId: action.assistant.id,
        messages: [
          ...state.messages,
          ...(action.manager ? [action.manager] : []),
          action.assistant,
        ],
      };
    case 'rollback':
      return {
        ...state,
        streamingId: null,
        messages: state.messages.filter((m) => !action.ids.includes(m.id)),
      };
    case 'event':
      return applyEvent(state, action.event);
    case 'end': {
      const id = state.streamingId;
      if (!id) return state;
      return {
        ...state,
        streamingId: null,
        messages: updateMessage(state.messages, id, (m) =>
          m.status !== 'streaming'
            ? m
            : action.stopped
              ? { ...m, status: 'stopped' }
              : { ...m, status: 'error', errorKind: action.errorKind ?? m.errorKind ?? 'network' },
        ),
      };
    }
    case 'restore':
      return {
        ...state,
        messages: updateMessage(state.messages, action.message.id, (m) => ({
          ...m,
          content: action.message.content,
        })),
      };
    case 'planConfirmed':
      return {
        ...state,
        plans: state.plans.map((p) =>
          p.id === action.planId ? { ...p, status: 'confirmed' as const } : p,
        ),
      };
  }
}
