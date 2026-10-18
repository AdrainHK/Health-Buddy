import {
  adminExpertListResponseSchema,
  expertAvailabilityEventListResponseSchema,
  expertStatsResponseSchema,
  type AdminExpertListResponse,
  type ExpertAvailabilityEvent,
  type ExpertStatsQuery,
  type ExpertStatsResponse,
} from '@health-buddy/shared';
import { apiRequest } from './http';

function queryString(query: ExpertStatsQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * 专家调用统计（M3 规格 6.4）。运营商只拿到本协会，平台管理员看全部或按协会筛选；
 * 健管师、机构管理员后端返回 403。
 */
export function getExpertStats(query: ExpertStatsQuery = {}): Promise<ExpertStatsResponse> {
  return apiRequest(`/expert-stats${queryString(query)}`, expertStatsResponseSchema);
}

/** 平台总后台的专家列表（只有平台管理员） */
export function listAdminExperts(): Promise<AdminExpertListResponse> {
  return apiRequest('/admin/experts', adminExpertListResponseSchema);
}

/** 暂停或恢复专家（Q11），记录由数据库写入 */
export async function setExpertAvailability(id: string, enabled: boolean): Promise<void> {
  await apiRequest(`/admin/experts/${encodeURIComponent(id)}/availability`, null, {
    method: 'PATCH',
    body: { enabled },
  });
}

export async function listAvailabilityEvents(id: string): Promise<ExpertAvailabilityEvent[]> {
  const { events } = await apiRequest(
    `/admin/experts/${encodeURIComponent(id)}/availability-events`,
    expertAvailabilityEventListResponseSchema,
  );
  return events;
}
