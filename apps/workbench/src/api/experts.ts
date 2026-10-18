import {
  expertConsultationListResponseSchema,
  expertConsultationSchema,
  expertDetailSchema,
  expertListResponseSchema,
  type ExpertConsultation,
  type ExpertDetail,
  type ExpertFeedbackRequest,
  type ExpertSummary,
  type ReconsultRequest,
} from '@health-buddy/shared';
import { z } from 'zod';
import { apiRequest } from './http';
import { streamRequest, type StreamOptions } from './stream';

/**
 * 专家中心接口（M3 规格 6.4）。专家意见只给健管师看，这里没有任何发给客户的入口（Q9）。
 */

const detailResponseSchema = z.object({ expert: expertDetailSchema });
const consultationResponseSchema = z.object({ consultation: expertConsultationSchema });

/** 当前账号可用的专家（专家库、@ 列表）。专家预览没开时是空列表 */
export async function listExperts(signal?: AbortSignal): Promise<ExpertSummary[]> {
  const { experts } = await apiRequest(
    '/experts',
    expertListResponseSchema,
    signal ? { signal } : {},
  );
  return experts;
}

/** 专家详情：擅长、不负责、来源清单、条目卡片、本人使用次数 */
export async function getExpert(id: string, signal?: AbortSignal): Promise<ExpertDetail> {
  const { expert } = await apiRequest(
    `/experts/${encodeURIComponent(id)}`,
    detailResponseSchema,
    signal ? { signal } : {},
  );
  return expert;
}

/** 任务里的专家调用（专家标签） */
export async function listTaskConsultations(
  taskId: string,
  signal?: AbortSignal,
): Promise<ExpertConsultation[]> {
  const { consultations } = await apiRequest(
    `/tasks/${encodeURIComponent(taskId)}/expert-consultations`,
    expertConsultationListResponseSchema,
    signal ? { signal } : {},
  );
  return consultations;
}

/** 一次专家调用的详情 */
export async function getConsultation(
  id: string,
  signal?: AbortSignal,
): Promise<ExpertConsultation> {
  const { consultation } = await apiRequest(
    `/expert-consultations/${encodeURIComponent(id)}`,
    consultationResponseSchema,
    signal ? { signal } : {},
  );
  return consultation;
}

/** 有用/没用（Q14）：只收类别，不收自由文字 */
export function setExpertFeedback(callId: string, body: ExpertFeedbackRequest): Promise<void> {
  return apiRequest(`/expert-calls/${encodeURIComponent(callId)}/feedback`, null, {
    method: 'PUT',
    body,
  });
}

/**
 * 重新请专家（SSE）：按原来的问题和报告再请一次，生成新的调用记录，计入今天的专家调用次数。
 * 不传 forced、excluded 时沿用原来的选择
 */
export function reconsultExperts(
  consultationId: string,
  body: ReconsultRequest,
  options: Omit<StreamOptions, 'body'>,
): Promise<void> {
  return streamRequest(`/expert-consultations/${encodeURIComponent(consultationId)}/reconsult`, {
    ...options,
    body,
  });
}

/** 补请因数量上限没请的专家（SSE，规格 2.6） */
export function addConsultationExpert(
  consultationId: string,
  expertId: string,
  options: Omit<StreamOptions, 'body'>,
): Promise<void> {
  return streamRequest(`/expert-consultations/${encodeURIComponent(consultationId)}/add-expert`, {
    ...options,
    body: { expertId },
  });
}
