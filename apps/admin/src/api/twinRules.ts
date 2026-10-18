import {
  twinRulesResponseSchema,
  twinStatsResponseSchema,
  twinStatusRuleResponseSchema,
  type CreateTwinStatusRuleRequest,
  type TwinRulesResponse,
  type TwinStatsQuery,
  type TwinStatsResponse,
  type TwinStatusRuleRecord,
  type UpdateTwinStatusRuleRequest,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/**
 * 孪生状态规则（M4 规格 2.10）。读：所有后台角色；写：只有平台管理员，其他角色后端返回 403。
 * 修改后所有客户在后台按新规则重算，这里不等待。
 */
export function listTwinRules(): Promise<TwinRulesResponse> {
  return apiRequest('/twin-status-rules', twinRulesResponseSchema);
}

export async function createTwinRule(
  body: CreateTwinStatusRuleRequest,
): Promise<TwinStatusRuleRecord> {
  const { rule } = await apiRequest('/admin/twin-status-rules', twinStatusRuleResponseSchema, {
    method: 'POST',
    body,
  });
  return rule;
}

export async function updateTwinRule(
  id: string,
  body: UpdateTwinStatusRuleRequest,
): Promise<TwinStatusRuleRecord> {
  const { rule } = await apiRequest(
    `/admin/twin-status-rules/${encodeURIComponent(id)}`,
    twinStatusRuleResponseSchema,
    { method: 'PATCH', body },
  );
  return rule;
}

export function resetTwinRules(): Promise<TwinRulesResponse> {
  return apiRequest('/admin/twin-status-rules/reset', twinRulesResponseSchema, {
    method: 'POST',
  });
}

/**
 * 孪生统计（M4 规格 7.4 GET /api/twin-stats）。运营商只拿到本协会，平台管理员看全部或按协会筛选；
 * 健管师、机构管理员后端返回 403。只有汇总数字，不含健管师、客户 id。
 */
export function getTwinStats(query: TwinStatsQuery = {}): Promise<TwinStatsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const text = params.toString();
  return apiRequest(`/twin-stats${text ? `?${text}` : ''}`, twinStatsResponseSchema);
}
