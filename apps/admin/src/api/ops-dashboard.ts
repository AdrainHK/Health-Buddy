import { opsDashboardResponseSchema, type OpsDashboardResponse } from '@health-buddy/shared';
import { apiRequest } from './http';

/** 运营看板（M7 规格 2.6）：只有汇总数字 */
export function getOpsDashboard(days: number, operatorId?: string): Promise<OpsDashboardResponse> {
  const params = new URLSearchParams({ days: String(days) });
  if (operatorId) params.set('operatorId', operatorId);
  return apiRequest(`/admin/ops-dashboard?${params.toString()}`, opsDashboardResponseSchema);
}
