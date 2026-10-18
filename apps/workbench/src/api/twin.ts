import {
  followUpItemResponseSchema,
  followUpListResponseSchema,
  monitoringReadingListResponseSchema,
  monitoringReadingResponseSchema,
  timeZoneSchema,
  twinDomainResponseSchema,
  twinForecastDetailResponseSchema,
  twinLevelsResponseSchema,
  twinResponseSchema,
  twinTimelineResponseSchema,
  type CreateMonitoringReadingRequest,
  type FollowUpItem,
  type FollowUpListResponse,
  type MonitoringReading,
  type SetTwinStatusRequest,
  type TwinClientLevel,
  type TwinDomain,
  type TwinDomainView,
  type TwinForecastDetailResponse,
  type TwinResponse,
  type TwinTimelineResponse,
  type TwinTimelineType,
  type UpdateFollowUpRequest,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/**
 * 客户数字孪生和今日跟进（M4 规格 2.2–2.6、7.4）。孪生接口只读后端算好的结果，不调用大模型。
 * 别人的客户一律 404。
 */

const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * 浏览器时区（Q13）：账号没设置时区时，“今日”按它算。后端拿到后再校验是否存在；
 * 格式不对（极少见的环境）就不传，后端按协会默认时区处理。
 */
export function browserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZoneSchema.safeParse(tz).success ? tz : null;
  } catch {
    return null;
  }
}

function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const s = search.toString();
  return s ? `?${s}` : '';
}

/** 孪生主视图（工作台只给健管师，响应是健管师的 schema） */
export function getTwin(clientId: string, signal?: AbortSignal): Promise<TwinResponse> {
  return apiRequest(`/clients/${clientId}/twin`, twinResponseSchema, opts(signal));
}

export function getTwinTimeline(
  clientId: string,
  options: { before?: string | null; types?: readonly TwinTimelineType[] },
  signal?: AbortSignal,
): Promise<TwinTimelineResponse> {
  const q = query({
    before: options.before ?? null,
    types: options.types?.length ? options.types.join(',') : null,
  });
  return apiRequest(
    `/clients/${clientId}/twin/timeline${q}`,
    twinTimelineResponseSchema,
    opts(signal),
  );
}

/** 某个指标的历次数值和最新预测（小图和大图共用） */
export function getForecastDetail(
  clientId: string,
  metric: string,
  signal?: AbortSignal,
): Promise<TwinForecastDetailResponse> {
  return apiRequest(
    `/clients/${clientId}/twin/forecasts/${encodeURIComponent(metric)}`,
    twinForecastDetailResponseSchema,
    opts(signal),
  );
}

/** 手动调整状态（Q4）：理由必填，到这个方面下次有新数据时失效 */
export async function setTwinStatus(
  clientId: string,
  body: SetTwinStatusRequest,
): Promise<TwinDomainView> {
  const { domain } = await apiRequest(
    `/clients/${clientId}/twin/status`,
    twinDomainResponseSchema,
    {
      method: 'POST',
      body,
    },
  );
  return domain;
}

/** 取消手动调整，恢复系统计算 */
export async function clearTwinStatus(
  clientId: string,
  domain: TwinDomain,
): Promise<TwinDomainView> {
  const res = await apiRequest(
    `/clients/${clientId}/twin/status/${domain}`,
    twinDomainResponseSchema,
    { method: 'DELETE' },
  );
  return res.domain;
}

/** 左侧栏客户列表的状态圆点 */
export async function getTwinLevels(signal?: AbortSignal): Promise<TwinClientLevel[]> {
  const { clients } = await apiRequest('/twin/levels', twinLevelsResponseSchema, opts(signal));
  return clients;
}

/** 今日跟进清单（未处理的）。clientId 为空时是所有客户的 */
export function listFollowUps(
  options: { clientId?: string | null } = {},
  signal?: AbortSignal,
): Promise<FollowUpListResponse> {
  const q = query({ clientId: options.clientId ?? null, tz: browserTimeZone() });
  return apiRequest(`/follow-ups${q}`, followUpListResponseSchema, opts(signal));
}

/** 已处理、暂缓、忽略。危急类不能忽略（后端 400） */
export async function updateFollowUp(
  id: string,
  body: UpdateFollowUpRequest,
): Promise<FollowUpItem> {
  const q = query({ tz: browserTimeZone() });
  const { item } = await apiRequest(`/follow-ups/${id}${q}`, followUpItemResponseSchema, {
    method: 'PATCH',
    body,
  });
  return item;
}

/** 手动录入一条监测读数（Q29）。每分钟最多 60 条，超出 429 */
export async function createMonitoringReading(
  clientId: string,
  body: CreateMonitoringReadingRequest,
): Promise<MonitoringReading> {
  const { reading } = await apiRequest(
    `/clients/${clientId}/monitoring-readings`,
    monitoringReadingResponseSchema,
    { method: 'POST', body },
  );
  return reading;
}

/** 自己给这位客户手动录入的读数 */
export async function listManualReadings(
  clientId: string,
  signal?: AbortSignal,
): Promise<MonitoringReading[]> {
  const { readings } = await apiRequest(
    `/clients/${clientId}/manual-readings`,
    monitoringReadingListResponseSchema,
    opts(signal),
  );
  return readings;
}

export function deleteMonitoringReading(id: string): Promise<void> {
  return apiRequest(`/monitoring-readings/${id}`, null, { method: 'DELETE' });
}
