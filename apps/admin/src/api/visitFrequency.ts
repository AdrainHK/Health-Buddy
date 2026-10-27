import {
  visitFrequencyRuleEventListResponseSchema,
  visitFrequencyRulesResponseSchema,
  type VisitFrequencyRuleEvent,
  type VisitFrequencyRules,
  type VisitFrequencyRulesResponse,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/**
 * 随访频次规则（M5 规格 2.12、Q18）。读：所有后台角色；改和修改记录：只有平台管理员，
 * 其他角色后端返回 403。改规则不改已经写入的随访日期。
 */
export function getVisitFrequencyRules(): Promise<VisitFrequencyRulesResponse> {
  return apiRequest('/visit-frequency-rules', visitFrequencyRulesResponseSchema);
}

export function updateVisitFrequencyRules(
  rules: VisitFrequencyRules,
): Promise<VisitFrequencyRulesResponse> {
  return apiRequest('/admin/visit-frequency-rules', visitFrequencyRulesResponseSchema, {
    method: 'PATCH',
    body: rules,
  });
}

export async function listVisitFrequencyEvents(): Promise<VisitFrequencyRuleEvent[]> {
  const { events } = await apiRequest(
    '/admin/visit-frequency-rules/events',
    visitFrequencyRuleEventListResponseSchema,
  );
  return events;
}
