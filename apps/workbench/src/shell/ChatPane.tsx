import { Button, IconButton } from '@health-buddy/ui';
import type {
  ArtifactSummary,
  ClientSummary,
  SkillSummary,
  Task,
  TaskMode,
  TaskPlan,
} from '@health-buddy/shared';
import { Menu, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { type ReactNode, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, isAbortError } from '../api/http';
import { confirmPlan, sendMessage, type StreamOptions } from '../api/stream';
import { createTask, getTask, stopTask } from '../api/workbench';
import { Composer } from '../chat/Composer';
import {
  conversationReducer,
  emptyConversation,
  LOCAL_PREFIX,
  type ViewMessage,
} from '../chat/conversation';
import { MessageList } from '../chat/MessageList';
import styles from './ChatPane.module.css';
import { isReadOnlyTask } from './taskGroups';

export interface ChatPaneProps {
  narrow: boolean;
  onOpenMenu: () => void;
  resultsOpen: boolean;
  onToggleResults: () => void;
  /** 当前任务；为空时显示欢迎页，发送第一条消息时自动新建任务 */
  task?: Task | null;
  skills?: SkillSummary[];
  clients?: ClientSummary[];
  /** 在对话区里新建了任务（欢迎页直接发送时） */
  onTaskCreated?: (task: Task) => void;
  /** 任务可能变了（更新时间、关联客户、只读），侧栏需要刷新 */
  onTaskChanged?: () => void;
  /** 生成了草稿，结果区需要刷新 */
  onArtifact?: (artifact: ArtifactSummary) => void;
  /**
   * 对话在对话区之外有了变化（如结果区里的退回重写生成了新一轮）时改变，
   * 对话区据此重新加载当前任务的对话。
   */
  conversationVersion?: number;
}

interface Draft {
  text: string;
  mode: TaskMode;
  skill: SkillSummary | null;
  client: ClientSummary | null;
}

type ErrorKey =
  'busy' | 'tooMany' | 'readOnly' | 'badRequest' | 'notFound' | 'conflict' | 'network' | 'unknown';

type Notice = { kind: 'needClient' } | { kind: 'otherClient' } | { kind: 'error'; key: ErrorKey };

function errorKey(err: unknown): ErrorKey {
  if (!(err instanceof ApiError)) return 'unknown';
  if (err.code === 'network') return 'network';
  if (err.status === 429) return 'tooMany';
  if (err.status === 409) {
    if (err.reasons.includes('read_only')) return 'readOnly';
    if (err.reasons.includes('busy')) return 'busy';
    return 'conflict';
  }
  if (err.status === 400) return 'badRequest';
  if (err.status === 404) return 'notFound';
  return 'unknown';
}

const EMPTY: never[] = [];

/** 中间对话区：消息流、执行步骤、计划和输入框（M1 规格 3.2–3.5） */
export function ChatPane({
  narrow,
  onOpenMenu,
  resultsOpen,
  onToggleResults,
  task = null,
  skills = EMPTY,
  clients = EMPTY,
  onTaskCreated,
  onTaskChanged,
  onArtifact,
  conversationVersion = 0,
}: ChatPaneProps) {
  const { t } = useTranslation();
  const [conversation, dispatch] = useReducer(conversationReducer, emptyConversation);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [reloadKey, setReloadKey] = useState(0);
  // 默认“做一做”，与 WorkBuddy 的默认模式一致。
  const [mode, setMode] = useState<TaskMode>('craft');
  const [text, setText] = useState('');
  const [skill, setSkill] = useState<SkillSummary | null>(null);
  const [client, setClient] = useState<ClientSummary | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [generating, setGenerating] = useState(false);
  const [queued, setQueued] = useState<Draft | null>(null);
  /** 发消息时才发现任务已只读（409 read_only），在侧栏刷新前先禁用输入 */
  const [readOnlyTaskId, setReadOnlyTaskId] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generatingRef = useRef(false);
  const queuedRef = useRef<Draft | null>(null);
  const createdTaskIdRef = useRef<string | null>(null);
  const localSeq = useRef(0);
  const submitRef = useRef<(draft: Draft) => void>(() => {});

  const taskId = task?.id ?? null;
  const readOnly = task !== null && (isReadOnlyTask(task) || readOnlyTaskId === task.id);

  // 切换任务：停止上一个任务的流（后端把断开当作停止），加载新任务的历史
  useEffect(() => {
    if (taskId !== null && createdTaskIdRef.current === taskId) {
      // 刚在欢迎页新建的任务，对话就在本地，不用加载
      createdTaskIdRef.current = null;
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    generatingRef.current = false;
    queuedRef.current = null;
    setGenerating(false);
    setQueued(null);
    setNotice(null);
    setSkill(null);
    setClient(null);
    dispatch({ type: 'reset' });
    if (taskId === null) {
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    const controller = new AbortController();
    getTask(taskId, controller.signal)
      .then((detail) => {
        dispatch({ type: 'load', detail });
        setLoadState('idle');
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoadState('error');
      });
    return () => controller.abort();
  }, [taskId, reloadKey]);

  // 对话在别处有了变化（退回重写）：静默重新加载，不清空已显示的内容，避免闪烁。
  // 本地正在生成时跳过（退回重写和对话生成互斥，后端会拒绝其中一个）。
  const seenConversationVersion = useRef(conversationVersion);
  useEffect(() => {
    if (seenConversationVersion.current === conversationVersion) return;
    seenConversationVersion.current = conversationVersion;
    if (taskId === null || generatingRef.current) return;
    const controller = new AbortController();
    getTask(taskId, controller.signal)
      .then((detail) => {
        if (generatingRef.current || detail.task.id !== taskId) return;
        dispatch({ type: 'load', detail });
        setLoadState('idle');
      })
      .catch(() => {
        // 静默刷新失败时保留当前内容，切换任务或刷新页面后可以看到
      });
    return () => controller.abort();
  }, [conversationVersion, taskId]);

  // 离开页面时停止正在进行的流
  useEffect(() => () => abortRef.current?.abort(), []);

  // 新内容出现时滚到底部
  const lastMessage = conversation.messages.at(-1);
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [conversation.messages.length, lastMessage?.content, conversation.steps.length]);

  const clearComposer = () => {
    setText('');
    setSkill(null);
    setClient(null);
  };

  const restoreComposer = (draft: Draft) => {
    setText(draft.text);
    setSkill(draft.skill);
    setClient(draft.client);
  };

  const nextLocalId = () => `${LOCAL_PREFIX}${++localSeq.current}`;

  /**
   * 跑一轮流式生成。流打开前被拒绝（400、404、409、429）时撤回本地消息、恢复输入；
   * 打开后断开时保留已显示的内容并标为出错。
   */
  async function runStream(
    target: Task,
    start: { manager?: ViewMessage; assistant: ViewMessage },
    open: (options: StreamOptions) => Promise<void>,
    hooks: { onOpen?: () => void; draft?: Draft } = {},
  ): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setNotice(null);
    dispatch({ type: 'start', ...start });

    let opened = false;
    let refusedId: string | null = null;
    const current = () => abortRef.current === controller;
    try {
      await open({
        signal: controller.signal,
        onOpen: () => {
          opened = true;
          hooks.onOpen?.();
        },
        onEvent: (event) => {
          if (!current()) return;
          if (event.type === 'done' && event.reason === 'refused') refusedId = event.messageId;
          if (event.type === 'artifact') onArtifact?.(event.artifact);
          dispatch({ type: 'event', event });
        },
      });
      if (current()) dispatch({ type: 'end' });
    } catch (err) {
      if (!current()) return; // 已切换到别的任务
      if (isAbortError(err)) {
        dispatch({ type: 'end', stopped: true });
      } else if (!opened) {
        const ids = [start.manager?.id, start.assistant.id].filter((x): x is string => !!x);
        dispatch({ type: 'rollback', ids });
        if (hooks.draft) restoreComposer(hooks.draft);
        const key = errorKey(err);
        if (key === 'readOnly') setReadOnlyTaskId(target.id);
        setNotice({ kind: 'error', key });
      } else {
        dispatch({ type: 'end', errorKind: 'network' });
      }
    }
    if (!current()) return;

    abortRef.current = null;
    generatingRef.current = false;
    setGenerating(false);
    onTaskChanged?.();

    // 拒答：本轮流式文本已清空，换成后端保存的内容（只有固定提醒）
    const refused = refusedId;
    if (refused) {
      try {
        const detail = await getTask(target.id);
        const saved = detail.messages.find((m) => m.id === refused);
        if (saved && !generatingRef.current) dispatch({ type: 'restore', message: saved });
      } catch {
        // 加载失败时保持清空，刷新后可以看到
      }
    }

    // 生成中输入的追问，等这一轮结束后再发
    const next = queuedRef.current;
    if (next) {
      queuedRef.current = null;
      setQueued(null);
      submitRef.current(next);
    }
  }

  async function submit(draft: Draft): Promise<void> {
    if (readOnly) return;
    const content = draft.text.trim();
    if (!content) return;
    // 问一问不能用技能（Q4）：提示切换模式，不发送
    if (draft.skill && draft.mode === 'ask') return;
    const linkedClientId = task?.clientId ?? null;
    if (draft.client && linkedClientId && draft.client.id !== linkedClientId) {
      setNotice({ kind: 'otherClient' });
      return;
    }
    if (draft.skill?.requiresClient && !draft.client && !linkedClientId) {
      setNotice({ kind: 'needClient' });
      return;
    }
    if (generatingRef.current) {
      // 生成中的追问排队，当前回答结束或被停止后再发（规格 3.2）
      queuedRef.current = draft;
      setQueued(draft);
      clearComposer();
      return;
    }

    clearComposer();
    let target = task;
    if (!target) {
      try {
        target = await createTask();
      } catch (err) {
        restoreComposer(draft);
        setNotice({ kind: 'error', key: errorKey(err) });
        return;
      }
      createdTaskIdRef.current = target.id;
      onTaskCreated?.(target);
    }

    const manager: ViewMessage = {
      id: nextLocalId(),
      role: 'manager',
      mode: draft.mode,
      content,
      skillId: draft.skill?.id ?? null,
      clientRefs: draft.client ? [draft.client.id] : [],
      status: 'complete',
    };
    const assistant: ViewMessage = {
      id: nextLocalId(),
      role: 'assistant',
      mode: draft.mode,
      content: '',
      skillId: draft.skill?.id ?? null,
      clientRefs: [],
      status: 'streaming',
    };
    const taskForSend = target;
    await runStream(
      taskForSend,
      { manager, assistant },
      (options) =>
        sendMessage(
          taskForSend.id,
          {
            mode: draft.mode,
            content,
            ...(draft.skill ? { skillId: draft.skill.id } : {}),
            clientRefs: draft.client ? [draft.client.id] : [],
          },
          options,
        ),
      { draft },
    );
  }

  useEffect(() => {
    submitRef.current = (draft) => void submit(draft);
  });

  const onConfirmPlan = (plan: TaskPlan) => {
    if (!task || readOnly || generatingRef.current) return;
    const target = task;
    const assistant: ViewMessage = {
      id: nextLocalId(),
      role: 'assistant',
      mode: 'craft',
      content: '',
      skillId: null,
      clientRefs: [],
      status: 'streaming',
    };
    void runStream(target, { assistant }, (options) => confirmPlan(target.id, plan.id, options), {
      onOpen: () => dispatch({ type: 'planConfirmed', planId: plan.id }),
    });
  };

  const onStop = () => {
    if (!task) return;
    // 后端停止后会推送 done(stopped)，已生成的内容保留；停止请求本身失败时直接断开
    stopTask(task.id).catch(() => abortRef.current?.abort());
  };

  const onUseSkill = (skillId: string) => {
    const found = skills.find((s) => s.id === skillId);
    if (!found) return;
    setSkill(found);
    inputRef.current?.focus();
  };

  const onClientChange = (next: ClientSummary | null) => {
    if (next && task?.clientId && next.id !== task.clientId) {
      // 每个任务只关联一位客户（Q6）
      setNotice({ kind: 'otherClient' });
      return;
    }
    setClient(next);
    if (next && notice?.kind === 'needClient') setNotice(null);
  };

  const onSkillChange = (next: SkillSummary | null) => {
    setSkill(next);
    if (notice?.kind === 'needClient' && !next?.requiresClient) setNotice(null);
  };

  const askSkillConflict = mode === 'ask' && skill !== null;
  let noticeNode: ReactNode = null;
  if (askSkillConflict) {
    noticeNode = (
      <>
        <span>{t('chat.hints.askSkill')}</span>
        <Button variant="ghost" onClick={() => setMode('craft')}>
          {t('chat.hints.switchToCraft')}
        </Button>
      </>
    );
  } else if (notice) {
    noticeNode = (
      <span role="alert">
        {notice.kind === 'needClient'
          ? t('chat.hints.needClient')
          : notice.kind === 'otherClient'
            ? t('chat.hints.otherClient')
            : t(`chat.errors.${notice.key}`)}
      </span>
    );
  } else if (queued) {
    noticeNode = (
      <>
        <span role="status">{t('chat.queued')}</span>
        <Button
          variant="ghost"
          onClick={() => {
            const draft = queuedRef.current;
            queuedRef.current = null;
            setQueued(null);
            if (draft) restoreComposer(draft);
          }}
        >
          {t('chat.cancelQueued')}
        </Button>
      </>
    );
  }

  const composer = (
    <Composer
      inputRef={inputRef}
      text={text}
      onTextChange={setText}
      mode={mode}
      onModeChange={setMode}
      skill={skill}
      onSkillChange={onSkillChange}
      client={client}
      onClientChange={onClientChange}
      skills={skills}
      clients={clients}
      disabled={readOnly || loadState !== 'idle'}
      generating={generating}
      onSubmit={() => void submit({ text, mode, skill, client })}
      onStop={onStop}
      notice={noticeNode}
    />
  );

  const hasMessages = conversation.messages.length > 0;

  return (
    <main className={styles.pane}>
      <header className={styles.topbar}>
        {narrow && (
          <IconButton
            label={t('nav.openMenu')}
            icon={<Menu size={18} />}
            aria-controls="hb-sidebar"
            onClick={onOpenMenu}
          />
        )}
        <h1 className={styles.title}>{task?.title || t('chat.untitled')}</h1>
        <IconButton
          label={resultsOpen ? t('results.close') : t('results.open')}
          icon={resultsOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          aria-expanded={resultsOpen}
          aria-controls="hb-results"
          onClick={onToggleResults}
        />
      </header>

      {loadState === 'loading' && (
        <div className={styles.body}>
          <p className={styles.hint} role="status">
            {t('chat.loading')}
          </p>
        </div>
      )}
      {loadState === 'error' && (
        <div className={styles.body}>
          <p className={styles.hint} role="alert">
            {t('chat.loadFailed')}
          </p>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t('chat.retry')}</Button>
        </div>
      )}
      {loadState === 'idle' &&
        (hasMessages ? (
          <>
            <div className={styles.thread}>
              <div className={styles.column}>
                <MessageList
                  conversation={conversation}
                  clients={clients}
                  canConfirm={!readOnly && !generating}
                  onConfirmPlan={onConfirmPlan}
                  onUseSkill={onUseSkill}
                />
                <div ref={bottomRef} />
              </div>
            </div>
            <div className={styles.dock}>
              <div className={styles.column}>{composer}</div>
            </div>
          </>
        ) : (
          <div className={styles.body}>
            <div className={styles.welcome}>
              <p className={styles.greeting}>{t('chat.greeting')}</p>
              <p className={styles.subtitle}>{t('chat.subtitle')}</p>
              {composer}
            </div>
          </div>
        ))}
    </main>
  );
}
