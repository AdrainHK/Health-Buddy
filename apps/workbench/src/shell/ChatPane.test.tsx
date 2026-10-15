import type { Task, TaskDetailResponse, TaskStep, TaskStreamEvent } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CLIENTS,
  NOW,
  SKILL,
  controlledSse,
  emptyDetail,
  ids,
  json,
  makeTask,
  mockApi,
  sseResponse,
} from '../test/mockApi';
import { ChatPane, type ChatPaneProps } from './ChatPane';

const MSG_PATH = `/tasks/${ids.task}/messages`;
const DETAIL_PATH = `/tasks/${ids.task}`;

function step(seq: number, labelKey: string, status: TaskStep['status']): TaskStep {
  return {
    id: seq === 0 ? ids.step1 : ids.step2,
    messageId: ids.assistantMsg,
    seq,
    kind: labelKey === 'steps.readClient' ? 'read_client' : 'answer',
    labelKey,
    status,
    startedAt: NOW,
    finishedAt: status === 'running' ? null : NOW,
  };
}

const text = (delta: string, messageId = ids.assistantMsg): TaskStreamEvent => ({
  type: 'text',
  messageId,
  delta,
});
const done = (
  reason: 'complete' | 'stopped' | 'refused' | 'error',
  messageId = ids.assistantMsg,
): TaskStreamEvent => ({ type: 'done', messageId, reason });

function renderPane(props: Partial<ChatPaneProps> = {}) {
  const all: ChatPaneProps = {
    narrow: false,
    onOpenMenu: () => {},
    resultsOpen: true,
    onToggleResults: () => {},
    task: makeTask(),
    skills: [SKILL],
    clients: CLIENTS,
    ...props,
  };
  return render(<ChatPane {...all} />);
}

const input = () => screen.getByRole('textbox');

afterEach(() => vi.unstubAllGlobals());

describe('ChatPane history', () => {
  it('loads messages, steps and plans of the selected task', async () => {
    const detail: TaskDetailResponse = {
      ...emptyDetail(),
      messages: [
        {
          id: ids.managerMsg,
          role: 'manager',
          mode: 'plan',
          content: '合成请求：写一份小结',
          skillId: SKILL.id,
          clientRefs: [ids.clientA],
          status: 'complete',
          createdAt: NOW,
        },
        {
          id: ids.assistantMsg,
          role: 'assistant',
          mode: 'plan',
          content: '',
          skillId: SKILL.id,
          clientRefs: [],
          status: 'complete',
          createdAt: NOW,
        },
      ],
      steps: [step(0, 'steps.readClient', 'done')],
      plans: [
        {
          id: ids.plan,
          messageId: ids.assistantMsg,
          steps: [{ kind: 'read_client' }, { kind: 'run_skill', skillId: SKILL.id }],
          status: 'proposed',
        },
      ],
    };
    mockApi({ [`GET ${DETAIL_PATH}`]: () => json(200, detail) });
    renderPane();

    expect(await screen.findByText('合成请求：写一份小结')).toBeInTheDocument();
    expect(screen.getByText('合成客户甲')).toBeInTheDocument();
    expect(screen.getByText('读取客户档案', { selector: 'span' })).toBeInTheDocument();
    const plan = screen.getByRole('region', { name: '执行计划' });
    expect(within(plan).getByText('调用技能：客户近况小结')).toBeInTheDocument();
    expect(within(plan).getByRole('button', { name: '确认执行' })).toBeEnabled();
  });

  it('shows a retry button when the detail fails to load', async () => {
    let fail = true;
    mockApi({
      [`GET ${DETAIL_PATH}`]: () =>
        fail ? json(500, { error: 'internal_error' }) : json(200, emptyDetail()),
    });
    const user = userEvent.setup();
    renderPane();
    expect(await screen.findByRole('alert')).toHaveTextContent('对话加载失败');
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('今天想让我帮你做什么？')).toBeInTheDocument();
  });
});

describe('ChatPane sending and streaming', () => {
  it('streams text, steps, artifact and suggestion; posts the composed request', async () => {
    let sse!: ReturnType<typeof controlledSse>;
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: (_c, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
    });
    const onArtifact = vi.fn();
    const onTaskChanged = vi.fn();
    const user = userEvent.setup();
    renderPane({ onArtifact, onTaskChanged });

    await user.type(await screen.findByRole('textbox'), '合成问题');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'craft',
      content: '合成问题',
      clientRefs: [],
    });
    expect(screen.getByText('合成问题')).toBeInTheDocument();
    expect(input()).toHaveValue('');
    expect(screen.getByRole('button', { name: '停止生成' })).toBeInTheDocument();
    expect(screen.getByText('正在生成…')).toBeInTheDocument();

    sse.send({ type: 'step', step: step(1, 'steps.answer', 'running') });
    sse.send(text('第一段'));
    await screen.findByText('第一段');
    sse.send(text('，第二段'));
    await screen.findByText('第一段，第二段');
    expect(screen.getByText('生成回答')).toBeInTheDocument();

    sse.send({ type: 'step', step: step(1, 'steps.answer', 'done') });
    sse.send({
      type: 'artifact',
      artifact: {
        id: ids.artifact,
        taskId: ids.task,
        skillId: SKILL.id,
        version: 1,
        status: 'draft',
        hasCriticalFlags: false,
        createdAt: NOW,
      },
    });
    sse.send({ type: 'suggestion', skillId: SKILL.id });
    sse.send(done('complete'));
    sse.close();

    expect(await screen.findByText('已生成草稿，请在右侧结果区审核')).toBeInTheDocument();
    expect(onArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: ids.artifact }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument());
    expect(onTaskChanged).toHaveBeenCalled();
    expect(screen.getByText('1/1')).toBeInTheDocument();

    // 技能建议：只把技能放进输入框，不自动执行
    const before = api.callsTo('POST', MSG_PATH).length;
    await user.click(screen.getByRole('button', { name: '使用 /客户近况小结' }));
    expect(screen.getByRole('button', { name: '移除技能 客户近况小结' })).toBeInTheDocument();
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(before);
  });

  it('on done(refused) clears the streamed text and shows the saved content', async () => {
    const saved = '仅供健管师参考的固定提醒';
    let sse!: ReturnType<typeof controlledSse>;
    let detailCalls = 0;
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => {
        detailCalls += 1;
        if (detailCalls === 1) return json(200, emptyDetail());
        return json(200, {
          ...emptyDetail(),
          messages: [
            {
              id: ids.assistantMsg,
              role: 'assistant',
              mode: 'ask',
              content: saved,
              skillId: null,
              clientRefs: [],
              status: 'refused',
              createdAt: NOW,
            },
          ],
        });
      },
      [`POST ${MSG_PATH}`]: (_c, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '合成问题');
    await user.keyboard('{Enter}');

    sse.send(text('模型的半截回答'));
    await screen.findByText('模型的半截回答');
    sse.send(done('refused'));
    sse.close();

    expect(await screen.findByText('模型未作答，请换个说法再试')).toBeInTheDocument();
    expect(await screen.findByText(saved)).toBeInTheDocument();
    expect(screen.queryByText('模型的半截回答')).not.toBeInTheDocument();
    expect(detailCalls).toBe(2);
  });

  it('stop posts to the stop endpoint and keeps the generated text', async () => {
    let sse!: ReturnType<typeof controlledSse>;
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: (_c, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
      [`POST /tasks/${ids.task}/stop`]: () => {
        // 后端停止后推送 done(stopped) 并结束流
        sse.send(done('stopped'));
        sse.close();
        return json(200, { stopped: true });
      },
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '合成问题');
    await user.keyboard('{Enter}');
    sse.send(text('已经生成的部分'));
    await screen.findByText('已经生成的部分');

    await user.click(screen.getByRole('button', { name: '停止生成' }));
    expect(api.callsTo('POST', `/tasks/${ids.task}/stop`)).toHaveLength(1);
    expect(await screen.findByText('已停止')).toBeInTheDocument();
    expect(screen.getByText('已经生成的部分')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
  });

  it('shows a friendly message for stream error events', async () => {
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: () => sseResponse([{ type: 'error', kind: 'timeout' }, done('error')]),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '合成问题');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('AI 响应超时，请重试')).toBeInTheDocument();
  });

  it.each([
    [409, { error: 'conflict', reasons: ['busy'] }, '上一条回答还在生成，请稍候再发'],
    [429, { error: 'too_many_requests' }, '操作太频繁，请稍后再试'],
  ])('rolls back and explains a %i rejection', async (status, body, message) => {
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: () => json(status, body),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '合成问题');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    // 本地消息撤回，输入恢复，可以重试
    expect(screen.queryByRole('list', { name: '对话记录' })).not.toBeInTheDocument();
    expect(input()).toHaveValue('合成问题');
    expect(input()).toBeEnabled();
  });

  it('disables the input after a 409 read_only rejection', async () => {
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: () => json(409, { error: 'conflict', reasons: ['read_only'] }),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '合成问题');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('客户已转出或删除，此任务只读');
    expect(input()).toBeDisabled();
  });

  it('confirms a proposed plan through the confirm stream', async () => {
    const confirmPath = `/tasks/${ids.task}/plans/${ids.plan}/confirm`;
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: () =>
        sseResponse([
          {
            type: 'plan',
            plan: {
              id: ids.plan,
              messageId: ids.assistantMsg,
              steps: [{ kind: 'read_client' }, { kind: 'run_skill', skillId: SKILL.id }],
              status: 'proposed',
            },
          },
          done('complete'),
        ]),
      [`POST ${confirmPath}`]: () =>
        sseResponse([
          {
            type: 'step',
            step: { ...step(0, 'steps.readClient', 'done'), messageId: ids.assistantMsg2 },
          },
          done('complete', ids.assistantMsg2),
        ]),
    });
    const user = userEvent.setup();
    renderPane({ task: makeTask({ clientId: ids.clientA }) });
    await user.click(await screen.findByRole('radio', { name: '想一想' }));
    await user.type(input(), '/');
    await user.keyboard('{Enter}');
    await user.type(input(), '合成请求');
    await user.keyboard('{Enter}');

    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'plan',
      content: '合成请求',
      skillId: SKILL.id,
      clientRefs: [],
    });
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    expect(api.callsTo('POST', confirmPath)).toHaveLength(1);
    expect(await screen.findByText('已确认')).toBeInTheDocument();
    expect(await screen.findByText('读取客户档案', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('ChatPane / skills and @ clients', () => {
  beforeEach(() => {
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()),
      [`POST ${MSG_PATH}`]: () => sseResponse([done('complete')]),
    });
  });

  it('picks a skill from the / menu and asks for a client before sending', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '请写 /近况');
    const menu = screen.getByRole('listbox', { name: '选择技能' });
    await user.click(within(menu).getByRole('option', { name: '客户近况小结' }));
    expect(input()).toHaveValue('请写 ');
    expect(screen.getByRole('button', { name: '移除技能 客户近况小结' })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('请先 @ 客户');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    await user.type(input(), '@乙');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: '移除客户 合成客户乙' })).toBeInTheDocument();
    expect(screen.queryByText('请先 @ 客户')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([url, init]) => url === `/api${MSG_PATH}` && init?.method === 'POST'),
      ).toHaveLength(1),
    );
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      mode: 'craft',
      content: '请写',
      skillId: SKILL.id,
      clientRefs: [ids.clientB],
    });
  });

  it('navigates the @ menu with the arrow keys', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.type(await screen.findByRole('textbox'), '@');
    const menu = screen.getByRole('listbox', { name: '选择客户' });
    expect(within(menu).getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('option', { name: '合成客户乙' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('in ask mode, a selected skill shows a switch hint and is not sent', async () => {
    const user = userEvent.setup();
    renderPane({ task: makeTask({ clientId: ids.clientA }) });
    await user.click(await screen.findByRole('radio', { name: '问一问' }));
    await user.type(input(), '/');
    await user.keyboard('{Enter}');
    await user.type(input(), '合成请求');
    expect(screen.getByText('技能需要在做一做或想一想模式下使用')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: '切换到做一做' }));
    expect(screen.getByRole('radio', { name: '做一做' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('技能需要在做一做或想一想模式下使用')).not.toBeInTheDocument();
  });

  it('only allows the client already linked to the task', async () => {
    const user = userEvent.setup();
    renderPane({ task: makeTask({ clientId: ids.clientA }) });
    await user.type(await screen.findByRole('textbox'), '@乙');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('该任务已关联其他客户，如需引用请新建任务');
    expect(screen.queryByRole('button', { name: /移除客户/ })).not.toBeInTheDocument();

    await user.type(input(), '@甲');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: '移除客户 合成客户甲' })).toBeInTheDocument();
  });
});

describe('ChatPane read-only and new tasks', () => {
  it('disables the input for a read-only task', async () => {
    mockApi({ [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail()) });
    renderPane({
      task: makeTask({ clientId: null, archived: true, detachedReason: 'client_transferred' }),
    });
    await waitFor(() => expect(input()).toBeDisabled());
    expect(input()).toHaveAttribute('placeholder', '客户已转出或删除，此任务只读');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('creates a task on the first message from the welcome screen', async () => {
    const created: Task = makeTask({ id: ids.task2, title: '新任务' });
    const api = mockApi({
      'POST /tasks': () => json(200, { task: created }),
      [`POST /tasks/${ids.task2}/messages`]: () => sseResponse([text('回答'), done('complete')]),
    });
    const onTaskCreated = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatPane
        narrow={false}
        onOpenMenu={() => {}}
        resultsOpen
        onToggleResults={() => {}}
        task={null}
        skills={[SKILL]}
        clients={CLIENTS}
        onTaskCreated={onTaskCreated}
      />,
    );
    await user.type(input(), '合成问题');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onTaskCreated).toHaveBeenCalledWith(created));
    // 上层选中新任务后不重新加载，流式内容保留
    rerender(
      <ChatPane
        narrow={false}
        onOpenMenu={() => {}}
        resultsOpen
        onToggleResults={() => {}}
        task={created}
        skills={[SKILL]}
        clients={CLIENTS}
        onTaskCreated={onTaskCreated}
      />,
    );
    expect(await screen.findByText('回答')).toBeInTheDocument();
    expect(api.callsTo('GET', `/tasks/${ids.task2}`)).toHaveLength(0);
  });
});
