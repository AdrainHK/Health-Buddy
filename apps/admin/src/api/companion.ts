import {
  companionScriptHistoryResponseSchema,
  companionScriptListResponseSchema,
  companionScriptSchema,
  deviceBatchListResponseSchema,
  deviceBatchSchema,
  type CompanionScript,
  type CompanionScriptKind,
  type DeviceBatch,
  type ImportDeviceBatchRequest,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/**
 * 伴侣“福宝”的平台维护（M6 规格 2.10）：固定话术、线下告知书模板、出厂设备批次。
 * 只有平台管理员；其他角色后端返回 403。设备密钥和激活码只在导入请求里出现。
 */

export async function listCompanionScripts(): Promise<CompanionScript[]> {
  const { scripts } = await apiRequest(
    '/admin/companion/scripts',
    companionScriptListResponseSchema,
  );
  return scripts;
}

export async function listCompanionScriptVersions(
  kind: CompanionScriptKind,
): Promise<CompanionScript[]> {
  const { versions } = await apiRequest(
    `/admin/companion/scripts/${kind}/versions`,
    companionScriptHistoryResponseSchema,
  );
  return versions;
}

export function saveCompanionScript(
  kind: CompanionScriptKind,
  text: string,
): Promise<CompanionScript> {
  return apiRequest(`/admin/companion/scripts/${kind}`, companionScriptSchema, {
    method: 'PUT',
    body: { text },
  });
}

export async function listDeviceBatches(): Promise<DeviceBatch[]> {
  const { batches } = await apiRequest(
    '/admin/companion/device-batches',
    deviceBatchListResponseSchema,
  );
  return batches;
}

export function importDeviceBatch(body: ImportDeviceBatchRequest): Promise<DeviceBatch> {
  return apiRequest('/admin/companion/device-batches', deviceBatchSchema, {
    method: 'POST',
    body,
  });
}
