import {
  criticalThresholdListResponseSchema,
  criticalThresholdSchema,
  type CreateCriticalThresholdRequest,
  type CriticalThreshold,
  type UpdateCriticalThresholdRequest,
} from '@health-buddy/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const thresholdResponseSchema = z.object({ threshold: criticalThresholdSchema });

/** 危急指标阈值（M1 规格第五节之二）。读：所有后台角色；写：只有平台管理员，其他角色后端返回 404。 */
export async function listThresholds(): Promise<CriticalThreshold[]> {
  const { thresholds } = await apiRequest(
    '/critical-thresholds',
    criticalThresholdListResponseSchema,
  );
  return thresholds;
}

export async function createThreshold(
  body: CreateCriticalThresholdRequest,
): Promise<CriticalThreshold> {
  const { threshold } = await apiRequest('/critical-thresholds', thresholdResponseSchema, {
    method: 'POST',
    body,
  });
  return threshold;
}

export async function updateThreshold(
  id: string,
  body: UpdateCriticalThresholdRequest,
): Promise<CriticalThreshold> {
  const { threshold } = await apiRequest(
    `/critical-thresholds/${encodeURIComponent(id)}`,
    thresholdResponseSchema,
    { method: 'PATCH', body },
  );
  return threshold;
}

export async function resetThresholds(): Promise<CriticalThreshold[]> {
  const { thresholds } = await apiRequest(
    '/critical-thresholds/reset',
    criticalThresholdListResponseSchema,
    { method: 'POST' },
  );
  return thresholds;
}
