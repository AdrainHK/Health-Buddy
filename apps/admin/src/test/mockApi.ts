import type {
  AdminExpertListResponse,
  CriticalThreshold,
  CurrentUser,
  ExpertStatsResponse,
} from '@health-buddy/shared';

/** 测试用的合成数据和后端模拟。只用合成数据，不含真实账号或客户信息。 */

export const NOW = '2026-10-15T08:00:00.000Z';

export const ids = {
  platformAdmin: '30000000-0000-4000-8000-000000000001',
  otherAdmin: '30000000-0000-4000-8000-000000000002',
  operator: '22222222-2222-4222-8222-222222222222',
  org: '33333333-3333-4333-8333-333333333333',
  sbpHigh: '80000000-0000-4000-8000-000000000001',
  fpgLow: '80000000-0000-4000-8000-000000000002',
  uricHigh: '80000000-0000-4000-8000-000000000003',
  created: '80000000-0000-4000-8000-000000000009',
};

const OPERATOR = { id: ids.operator, name: '合成协会', brandColor: null };

export const USERS = {
  platform_admin: {
    id: ids.platformAdmin,
    email: 'platform@test.example',
    displayName: '合成平台管理员',
    role: 'platform_admin',
    operator: null,
    orgId: null,
  },
  operator_admin: {
    id: '30000000-0000-4000-8000-000000000003',
    email: 'operator@test.example',
    displayName: '合成协会管理员',
    role: 'operator_admin',
    operator: OPERATOR,
    orgId: null,
  },
  org_admin: {
    id: '30000000-0000-4000-8000-000000000004',
    email: 'org@test.example',
    displayName: '合成机构管理员',
    role: 'org_admin',
    operator: OPERATOR,
    orgId: ids.org,
  },
  manager: {
    id: '30000000-0000-4000-8000-000000000005',
    email: 'manager@test.example',
    displayName: '合成健管师',
    role: 'manager',
    operator: OPERATOR,
    orgId: ids.org,
  },
} satisfies Record<CurrentUser['role'], CurrentUser>;

export function makeThresholds(): CriticalThreshold[] {
  return [
    {
      id: ids.uricHigh,
      metric: 'uric_acid',
      comparator: 'gte',
      value: 540,
      level: 'attention',
      enabled: true,
      updatedBy: null,
      updatedAt: NOW,
    },
    {
      id: ids.sbpHigh,
      metric: 'sbp',
      comparator: 'gte',
      value: 180,
      level: 'urgent',
      enabled: true,
      updatedBy: ids.otherAdmin,
      updatedAt: NOW,
    },
    {
      id: ids.fpgLow,
      metric: 'fpg',
      comparator: 'lt',
      value: 3,
      level: 'urgent',
      enabled: false,
      updatedBy: ids.platformAdmin,
      updatedAt: NOW,
    },
  ];
}

export const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * 模拟后端：按“方法 路径”找处理函数，记录每次调用。没有登记的接口返回 404。
 * 默认登记了已登录用户的 /auth/me 和 /auth/logout。
 */
export function mockApi(user: CurrentUser | null, routes: Record<string, Handler> = {}) {
  const calls: RecordedCall[] = [];
  const all: Record<string, Handler> = {
    'GET /auth/me': () => (user ? json(200, { user }) : json(401, { error: 'unauthenticated' })),
    'POST /auth/logout': () => new Response(null, { status: 204 }),
    ...routes,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^\/api/, '');
    const call: RecordedCall = {
      method,
      path,
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    };
    calls.push(call);
    const handler = all[`${method} ${path}`];
    if (!handler) return json(404, { error: 'not_found' });
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
    writes: () => calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/')),
  };
}

export const expertIds = {
  otherOperator: '22222222-2222-4222-8222-222222222223',
  event1: '90000000-0000-4000-8000-000000000001',
  event2: '90000000-0000-4000-8000-000000000002',
};

/** 平台专家列表：营养专家使用中，心血管专家已暂停 */
export function makeAdminExperts(): AdminExpertListResponse {
  const base = {
    version: '0.1.0',
    status: 'review' as const,
    sourcesPending: true,
    statusAllowed: false,
    evalTarget: 15,
  };
  return {
    from: '2026-09-16',
    to: '2026-10-15',
    experts: [
      {
        ...base,
        id: 'nutrition',
        name: '营养专家',
        sourcesVersion: '0123456789ab',
        enabled: true,
        updatedAt: null,
        evalCases: 7,
        calls: 12,
        useful: 5,
        notUseful: 2,
      },
      {
        ...base,
        id: 'cardiovascular',
        name: '心血管专家',
        sourcesVersion: 'abcdef012345',
        enabled: false,
        updatedAt: NOW,
        evalCases: 9,
        calls: 3,
        useful: 0,
        notUseful: 1,
      },
    ],
  };
}

const counts = {
  calls: 4,
  succeeded: 3,
  timedOut: 1,
  successRate: 0.75,
  timeoutRate: 0.25,
  inputTokens: 1200,
  outputTokens: 600,
  costUsd: 0.0123,
  useful: 2,
  notUseful: 1,
};

/** 统计结果。platform 为 true 时带协会；否则协会字段为空（协会管理员只看本协会） */
export function makeStats(platform: boolean): ExpertStatsResponse {
  return {
    scope: platform ? 'platform' : 'operator',
    from: '2026-09-16',
    to: '2026-10-15',
    operatorId: null,
    operators: platform
      ? [
          { id: ids.operator, name: '合成协会' },
          { id: expertIds.otherOperator, name: '合成协会乙' },
        ]
      : [],
    rows: [
      {
        operatorId: platform ? ids.operator : null,
        operatorName: platform ? '合成协会' : null,
        expertId: 'nutrition',
        expertName: '营养专家',
        date: '2026-10-14',
        ...counts,
      },
    ],
    totals: [{ expertId: 'nutrition', expertName: '营养专家', ...counts }],
  };
}
