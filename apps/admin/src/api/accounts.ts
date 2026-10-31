import {
  accountListResponseSchema,
  accountResponseSchema,
  auditLogResponseSchema,
  inviteResponseSchema,
  operatorListResponseSchema,
  operatorResponseSchema,
  type AccountSummary,
  type AuditLogQuery,
  type AuditLogResponse,
  type CreateOperatorRequest,
  type InviteAccountRequest,
  type InviteResponse,
  type OperatorSummary,
  type UpdateOperatorRequest,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/**
 * 协会和账号开通（M7 规格 2.1、2.4、2.7）。开通、停用、恢复只有平台管理员；
 * 审计日志平台看全部、协会管理员看本协会。邀请链接只在开通和重发邀请的响应里出现一次。
 */
export async function listOperators(): Promise<OperatorSummary[]> {
  return (await apiRequest('/admin/operators', operatorListResponseSchema)).operators;
}

export async function createOperator(body: CreateOperatorRequest): Promise<OperatorSummary> {
  return (await apiRequest('/admin/operators', operatorResponseSchema, { method: 'POST', body }))
    .operator;
}

export async function updateOperator(
  id: string,
  body: UpdateOperatorRequest,
): Promise<OperatorSummary> {
  return (
    await apiRequest(`/admin/operators/${encodeURIComponent(id)}`, operatorResponseSchema, {
      method: 'PATCH',
      body,
    })
  ).operator;
}

export async function setOperatorSuspended(
  id: string,
  suspend: boolean,
  reason?: string,
): Promise<OperatorSummary> {
  const path = `/admin/operators/${encodeURIComponent(id)}/${suspend ? 'suspend' : 'resume'}`;
  return (
    await apiRequest(path, operatorResponseSchema, {
      method: 'POST',
      body: suspend ? { reason } : {},
    })
  ).operator;
}

export async function listOperatorAccounts(id: string): Promise<AccountSummary[]> {
  return (
    await apiRequest(
      `/admin/operators/${encodeURIComponent(id)}/accounts`,
      accountListResponseSchema,
    )
  ).accounts;
}

export function inviteOperatorAdmin(
  operatorId: string,
  body: InviteAccountRequest,
): Promise<InviteResponse> {
  return apiRequest(
    `/admin/operators/${encodeURIComponent(operatorId)}/accounts`,
    inviteResponseSchema,
    { method: 'POST', body },
  );
}

export function reinviteAccount(id: string): Promise<InviteResponse> {
  return apiRequest(`/admin/accounts/${encodeURIComponent(id)}/reinvite`, inviteResponseSchema, {
    method: 'POST',
  });
}

export async function setAccountSuspended(id: string, suspend: boolean): Promise<AccountSummary> {
  return (
    await apiRequest(
      `/admin/accounts/${encodeURIComponent(id)}/${suspend ? 'suspend' : 'resume'}`,
      accountResponseSchema,
      { method: 'POST' },
    )
  ).account;
}

function auditQuery(q: AuditLogQuery): string {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.operatorId) params.set('operatorId', q.operatorId);
  if (q.objectType) params.set('objectType', q.objectType);
  return params.toString();
}

export function listAuditLog(q: AuditLogQuery): Promise<AuditLogResponse> {
  return apiRequest(`/admin/audit-log?${auditQuery(q)}`, auditLogResponseSchema);
}

/** 导出 CSV：同源下载，浏览器带 Cookie */
export function auditLogExportUrl(q: AuditLogQuery): string {
  return `/api/admin/audit-log/export?${auditQuery(q)}`;
}

/** 后端只返回路径（同一个域名），这里拼上当前地址给管理员复制 */
export function inviteLink(path: string): string {
  return `${window.location.origin}${path}`;
}
