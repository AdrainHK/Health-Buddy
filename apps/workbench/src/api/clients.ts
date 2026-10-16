import {
  clientRecordResponseSchema,
  clientResponseSchema,
  healthHistoryItemResponseSchema,
  riskTierHistoryResponseSchema,
  riskTierResponseSchema,
  type ClientRecord,
  type ClientSummary,
  type CreateClientRequest,
  type CreateHealthHistoryItemRequest,
  type HealthHistoryItem,
  type RiskTierRecord,
  type SetRiskTierRequest,
  type UpdateClientRequest,
  type UpdateHealthHistoryItemRequest,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/** 统一客户档案（M2 规格 2.2）。后端受行级安全约束，看不到的客户返回 404 */
export async function getClientRecord(id: string, signal?: AbortSignal): Promise<ClientRecord> {
  const { record } = await apiRequest(
    `/clients/${id}/record`,
    clientRecordResponseSchema,
    signal ? { signal } : {},
  );
  return record;
}

/** 新建客户（Q13），只建在当前健管师名下 */
export async function createClient(body: CreateClientRequest): Promise<ClientSummary> {
  const { client } = await apiRequest('/clients', clientResponseSchema, { method: 'POST', body });
  return client;
}

export async function updateClient(id: string, body: UpdateClientRequest): Promise<ClientSummary> {
  const { client } = await apiRequest(`/clients/${id}`, clientResponseSchema, {
    method: 'PATCH',
    body,
  });
  return client;
}

export async function createHistoryItem(
  clientId: string,
  body: CreateHealthHistoryItemRequest,
): Promise<HealthHistoryItem> {
  const { item } = await apiRequest(
    `/clients/${clientId}/health-history`,
    healthHistoryItemResponseSchema,
    { method: 'POST', body },
  );
  return item;
}

export async function updateHistoryItem(
  clientId: string,
  itemId: string,
  body: UpdateHealthHistoryItemRequest,
): Promise<HealthHistoryItem> {
  const { item } = await apiRequest(
    `/clients/${clientId}/health-history/${itemId}`,
    healthHistoryItemResponseSchema,
    { method: 'PATCH', body },
  );
  return item;
}

export function deleteHistoryItem(clientId: string, itemId: string): Promise<void> {
  return apiRequest(`/clients/${clientId}/health-history/${itemId}`, null, { method: 'DELETE' });
}

/** 分层历史，从新到旧 */
export async function listRiskTiers(clientId: string): Promise<RiskTierRecord[]> {
  const { tiers } = await apiRequest(
    `/clients/${clientId}/risk-tiers`,
    riskTierHistoryResponseSchema,
  );
  return tiers;
}

export async function setRiskTier(
  clientId: string,
  body: SetRiskTierRequest,
): Promise<RiskTierRecord> {
  const { tier } = await apiRequest(`/clients/${clientId}/risk-tiers`, riskTierResponseSchema, {
    method: 'POST',
    body,
  });
  return tier;
}
