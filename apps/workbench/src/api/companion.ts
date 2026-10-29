import {
  checkinListResponseSchema,
  checkinPlanListResponseSchema,
  checkinPlanResponseSchema,
  companionOverviewSchema,
  companionScriptSchema,
  type BindCompanionDeviceRequest,
  type Checkin,
  type CheckinPlan,
  type CreateCheckinPlanRequest,
  type UpdateCheckinPlanRequest,
  type CompanionOverview,
  type CompanionScript,
  type RecordCompanionConsentRequest,
  type UpdateCompanionSettingsRequest,
} from '@health-buddy/shared';
import { apiRequest } from './http';
import { browserTimeZone } from './twin';

/**
 * 伴侣“福宝”（M6 规格 2.1、2.8）：设备、线下告知和同意、伴侣设置。
 * 只给服务这位客户的健管师；别人的客户一律 404。激活码只在绑定请求里出现。
 */

const opts = (signal?: AbortSignal) => (signal ? { signal } : {});
const base = (clientId: string) => `/clients/${encodeURIComponent(clientId)}/companion`;
const tz = () => {
  const zone = browserTimeZone();
  return zone ? `?tz=${encodeURIComponent(zone)}` : '';
};

export function getCompanion(clientId: string, signal?: AbortSignal): Promise<CompanionOverview> {
  return apiRequest(base(clientId), companionOverviewSchema, opts(signal));
}

export function updateCompanionSettings(
  clientId: string,
  body: UpdateCompanionSettingsRequest,
): Promise<CompanionOverview> {
  return apiRequest(base(clientId), companionOverviewSchema, { method: 'PATCH', body });
}

export function recordCompanionConsent(
  clientId: string,
  body: RecordCompanionConsentRequest,
): Promise<CompanionOverview> {
  return apiRequest(`${base(clientId)}/consents${tz()}`, companionOverviewSchema, {
    method: 'POST',
    body,
  });
}

export function revokeCompanionConsent(
  clientId: string,
  revokedOn: string,
): Promise<CompanionOverview> {
  return apiRequest(`${base(clientId)}/consents/revoke${tz()}`, companionOverviewSchema, {
    method: 'POST',
    body: { revokedOn },
  });
}

export function bindCompanionDevice(
  clientId: string,
  body: BindCompanionDeviceRequest,
): Promise<CompanionOverview> {
  return apiRequest(`${base(clientId)}/device`, companionOverviewSchema, {
    method: 'POST',
    body,
  });
}

export function unbindCompanionDevice(clientId: string): Promise<CompanionOverview> {
  return apiRequest(`${base(clientId)}/device`, companionOverviewSchema, { method: 'DELETE' });
}

export function setCompanionPaused(clientId: string, paused: boolean): Promise<CompanionOverview> {
  return apiRequest(`${base(clientId)}/${paused ? 'pause' : 'resume'}`, companionOverviewSchema, {
    method: 'POST',
  });
}

/** 当前的线下告知书模板（打印用）；平台还没有发布时 404 */
export function getCompanionNotice(signal?: AbortSignal): Promise<CompanionScript> {
  return apiRequest('/companion/notice', companionScriptSchema, opts(signal));
}

// ---------- 打卡计划和近 30 天的打卡（规格 2.3、2.8） ----------

const plansUrl = (clientId: string) => `/clients/${encodeURIComponent(clientId)}/checkin-plans`;

export async function listCheckinPlans(
  clientId: string,
  signal?: AbortSignal,
): Promise<CheckinPlan[]> {
  const { plans } = await apiRequest(
    plansUrl(clientId),
    checkinPlanListResponseSchema,
    opts(signal),
  );
  return plans;
}

export async function createCheckinPlan(
  clientId: string,
  body: CreateCheckinPlanRequest,
): Promise<CheckinPlan> {
  const { plan } = await apiRequest(plansUrl(clientId), checkinPlanResponseSchema, {
    method: 'POST',
    body,
  });
  return plan;
}

export async function updateCheckinPlan(
  clientId: string,
  planId: string,
  body: UpdateCheckinPlanRequest,
): Promise<CheckinPlan> {
  const { plan } = await apiRequest(
    `${plansUrl(clientId)}/${encodeURIComponent(planId)}`,
    checkinPlanResponseSchema,
    { method: 'PATCH', body },
  );
  return plan;
}

export async function listCheckins(clientId: string, signal?: AbortSignal): Promise<Checkin[]> {
  const { checkins } = await apiRequest(
    `/clients/${encodeURIComponent(clientId)}/checkins`,
    checkinListResponseSchema,
    opts(signal),
  );
  return checkins;
}
