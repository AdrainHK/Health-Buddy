import type {
  ArtifactDetailResponse,
  ArtifactSummary,
  ClientSummary,
  SkillSummary,
  Task,
  TaskDetailResponse,
  TaskStreamEvent,
} from '@health-buddy/shared';

/** 测试用的合成数据和后端模拟。只用合成数据，不含真实客户信息。 */

export const ids = {
  task: '10000000-0000-4000-8000-000000000001',
  task2: '10000000-0000-4000-8000-000000000002',
  task3: '10000000-0000-4000-8000-000000000003',
  clientA: '20000000-0000-4000-8000-00000000000a',
  clientB: '20000000-0000-4000-8000-00000000000b',
  manager: '30000000-0000-4000-8000-000000000001',
  managerMsg: '40000000-0000-4000-8000-000000000001',
  assistantMsg: '40000000-0000-4000-8000-000000000002',
  assistantMsg2: '40000000-0000-4000-8000-000000000003',
  step1: '50000000-0000-4000-8000-000000000001',
  step2: '50000000-0000-4000-8000-000000000002',
  plan: '60000000-0000-4000-8000-000000000001',
  artifact: '70000000-0000-4000-8000-000000000001',
  artifact2: '70000000-0000-4000-8000-000000000002',
  artifact3: '70000000-0000-4000-8000-000000000003',
  event1: '80000000-0000-4000-8000-000000000001',
  event2: '80000000-0000-4000-8000-000000000002',
};

export const NOW = '2026-10-15T08:00:00.000Z';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    title: '合成任务',
    clientId: null,
    archived: false,
    detachedReason: null,
    expertId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export const SKILL: SkillSummary = {
  id: 'client-recent-summary',
  requiresClient: true,
  modes: ['plan', 'craft'],
  clientFacing: true,
  involvesHealthJudgment: true,
  requiresReport: false,
  usesReport: false,
  allowsEmptyRequest: false,
  planSkills: [],
  experts: 'none',
  usesMaterials: false,
  usesHandoff: false,
  usesPlanOptions: false,
};

export const CLIENTS: ClientSummary[] = [
  {
    id: ids.clientA,
    displayName: '合成客户甲',
    gender: 'female',
    birthYear: 1960,
    managerId: ids.manager,
    isSynthetic: true,
  },
  {
    id: ids.clientB,
    displayName: '合成客户乙',
    gender: 'male',
    birthYear: 1975,
    managerId: ids.manager,
    isSynthetic: true,
  },
];

export function emptyDetail(task: Task = makeTask()): TaskDetailResponse {
  return { task, messages: [], steps: [], plans: [], artifacts: [], uploads: [] };
}

export const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const encoder = new TextEncoder();

export const sseFrame = (event: TaskStreamEvent | Record<string, unknown>) =>
  `data: ${JSON.stringify(event)}\n\n`;

/** 一次性返回全部事件的 SSE 响应 */
export function sseResponse(events: (TaskStreamEvent | Record<string, unknown>)[]): Response {
  const body = events.map(sseFrame).join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/** 可以一点点推送事件的 SSE 响应。请求被取消时像真实的 fetch 一样让流出错。 */
export function controlledSse(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    if (closed) return;
    closed = true;
    const err = new Error('aborted');
    err.name = 'AbortError';
    controller.error(err);
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    send(event: TaskStreamEvent) {
      controller.enqueue(encoder.encode(sseFrame(event)));
    },
    raw(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: RecordedCall, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * 模拟后端：按“方法 路径”找处理函数，记录每次调用。
 * 没有登记的接口返回 404。
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace(/^\/api/, '');
    const call: RecordedCall = {
      method,
      path,
      // 上传文件时 body 是 FormData，原样记录
      body:
        init?.body instanceof FormData
          ? init.body
          : init?.body
            ? (JSON.parse(String(init.body)) as unknown)
            : undefined,
    };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    if (!handler) return json(404, { error: 'not_found' });
    return handler(call, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

export function setWideViewport() {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

/** 合成产物摘要 */
export function makeArtifactSummary(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id: ids.artifact,
    taskId: ids.task,
    skillId: SKILL.id,
    version: 1,
    status: 'draft',
    hasCriticalFlags: false,
    createdAt: NOW,
    sourceReportDate: null,
    sourceFileName: null,
    ...overrides,
  };
}

export const SYNTHETIC_DISCLAIMER = '仅供参考，非医疗诊断';

/** 合成产物详情。通俗版默认以免责声明结尾，和后端保存的一致。 */
export function makeArtifactDetail(
  overrides: Partial<ArtifactDetailResponse['artifact']> = {},
  extra: Partial<Omit<ArtifactDetailResponse, 'artifact'>> = {},
): ArtifactDetailResponse {
  const artifact: ArtifactDetailResponse['artifact'] = {
    ...makeArtifactSummary(),
    clientId: ids.clientA,
    parentId: null,
    content: {
      professional: '## 合成专业版\n- 近 30 天合成监测数据平稳',
      clientFacing: `合成通俗版：最近状态平稳，继续保持。\n\n${SYNTHETIC_DISCLAIMER}`,
    },
    contentHash: 'hash-1',
    consultationId: null,
    emergencySignal: false,
    crisisSignal: false,
    structured: null,
    planOptions: null,
    criticalFlags: [],
    sourceReportId: null,
    riskTierSuggestion: null,
    clientFacing: true,
    ...overrides,
  };
  const {
    id,
    taskId,
    skillId,
    version,
    status,
    hasCriticalFlags,
    createdAt,
    sourceReportDate,
    sourceFileName,
  } = artifact;
  return {
    artifact,
    sourceReport: null,
    companion: null,
    contentCheck: null,
    hints: { judgementHints: [], criticalValueMentions: [], riskTierMentions: [] },
    versions: [
      {
        id,
        taskId,
        skillId,
        version,
        status,
        hasCriticalFlags,
        createdAt,
        sourceReportDate,
        sourceFileName,
      },
    ],
    events: [
      {
        id: ids.event1,
        artifactId: id,
        actorId: null,
        action: 'created',
        reason: null,
        format: null,
        createdAt: NOW,
      },
    ],
    ...extra,
  };
}
