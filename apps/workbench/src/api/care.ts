import {
  adherenceResponseSchema,
  carePlanListResponseSchema,
  carePlanResponseSchema,
  exerciseListResponseSchema,
  goalTemplateListResponseSchema,
  recipeListResponseSchema,
  todayVisitsResponseSchema,
  visitListResponseSchema,
  visitRecordListResponseSchema,
  visitRecordResponseSchema,
  visitResponseSchema,
  type AdherenceResponse,
  type CarePlan,
  type CarePlanListResponse,
  type CarePlanSummary,
  type CreateVisitRequest,
  type EndCarePlanRequest,
  type ExerciseCategory,
  type ExerciseManagerView,
  type GoalTemplateManagerView,
  type LibraryTag,
  type MealType,
  type PlanSection,
  type RecipeManagerView,
  type TodayVisitsResponse,
  type UpdateVisitRequest,
  type Visit,
  type VisitRecord,
  type VisitRecordSummary,
  type VisitStatus,
} from '@health-buddy/shared';
import { z } from 'zod';
import { apiRequest } from './http';
import { browserTimeZone } from './twin';

/**
 * 方案、随访、随访记录和方案库（M5 规格 2.4、2.6、2.7、6.4）。
 * 都是读后端算好的结果，不调用大模型；别人的客户、方案、随访、记录一律 404。
 */

const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

function query(params: Record<string, string | readonly string[] | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) search.append(k, item);
    else if (typeof v === 'string' && v) search.set(k, v);
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

const tzQuery = () => query({ tz: browserTimeZone() });

// ---------- 方案 ----------

export function listCarePlans(
  clientId: string,
  signal?: AbortSignal,
): Promise<CarePlanListResponse> {
  return apiRequest(`/clients/${clientId}/care-plans`, carePlanListResponseSchema, opts(signal));
}

export async function getCarePlan(id: string, signal?: AbortSignal): Promise<CarePlan> {
  const { plan } = await apiRequest(`/care-plans/${id}`, carePlanResponseSchema, opts(signal));
  return plan;
}

/** 结束方案（原因必填）；已结束、已被替代 → 409 */
export async function endCarePlan(id: string, body: EndCarePlanRequest): Promise<CarePlanSummary> {
  const { plan } = await apiRequest(
    `/care-plans/${id}/end`,
    z.object({ plan: carePlanResponseSchema.shape.plan.omit({ snapshot: true }) }),
    { method: 'POST', body },
  );
  return plan;
}

/** 当前方案的执行情况；没有生效方案时为 null */
export async function getAdherence(
  clientId: string,
  signal?: AbortSignal,
): Promise<AdherenceResponse | null> {
  const { adherence } = await apiRequest(
    `/clients/${clientId}/care-plans/current/adherence${tzQuery()}`,
    z.object({ adherence: adherenceResponseSchema.nullable() }),
    opts(signal),
  );
  return adherence;
}

// ---------- 随访 ----------

export function getTodayVisits(signal?: AbortSignal): Promise<TodayVisitsResponse> {
  return apiRequest(`/visits/today${tzQuery()}`, todayVisitsResponseSchema, opts(signal));
}

export async function listVisits(
  options: { clientId: string; status?: VisitStatus; from?: string },
  signal?: AbortSignal,
): Promise<Visit[]> {
  const { visits } = await apiRequest(
    `/visits${query({ clientId: options.clientId, status: options.status, from: options.from })}`,
    visitListResponseSchema,
    opts(signal),
  );
  return visits;
}

/** 加一次随访（可以从跟进项发起） */
export async function createVisit(clientId: string, body: CreateVisitRequest): Promise<Visit> {
  const { visit } = await apiRequest(
    `/clients/${clientId}/visits${tzQuery()}`,
    visitResponseSchema,
    { method: 'POST', body },
  );
  return visit;
}

/** 完成、未联系上、改期、取消；已处理的随访 → 409 */
export async function updateVisit(id: string, body: UpdateVisitRequest): Promise<Visit> {
  const { visit } = await apiRequest(`/visits/${id}${tzQuery()}`, visitResponseSchema, {
    method: 'PATCH',
    body,
  });
  return visit;
}

// ---------- 随访记录 ----------

export async function listVisitRecords(
  clientId: string,
  signal?: AbortSignal,
): Promise<VisitRecordSummary[]> {
  const { records } = await apiRequest(
    `/clients/${clientId}/visit-records`,
    visitRecordListResponseSchema,
    opts(signal),
  );
  return records;
}

export async function getVisitRecord(id: string, signal?: AbortSignal): Promise<VisitRecord> {
  const { record } = await apiRequest(
    `/visit-records/${id}`,
    visitRecordResponseSchema,
    opts(signal),
  );
  return record;
}

/** 补充说明（记录确认后只能追加） */
export async function addVisitRecordAddendum(id: string, text: string): Promise<VisitRecord> {
  const { record } = await apiRequest(`/visit-records/${id}/addenda`, visitRecordResponseSchema, {
    method: 'POST',
    body: { text },
  });
  return record;
}

// ---------- 方案库（只读，只有已发布的条目） ----------

export async function listRecipes(
  filters: { meal?: MealType | null; tags?: readonly LibraryTag[]; q?: string | null },
  signal?: AbortSignal,
): Promise<RecipeManagerView[]> {
  const { items } = await apiRequest(
    `/plan-library/recipes${query({ meal: filters.meal, tags: filters.tags, q: filters.q?.trim() })}`,
    recipeListResponseSchema,
    opts(signal),
  );
  return items;
}

export async function listExercises(
  filters: {
    category?: ExerciseCategory | null;
    intensity?: 'low' | 'moderate' | null;
    q?: string | null;
  },
  signal?: AbortSignal,
): Promise<ExerciseManagerView[]> {
  const { items } = await apiRequest(
    `/plan-library/exercises${query({
      category: filters.category,
      intensity: filters.intensity,
      q: filters.q?.trim(),
    })}`,
    exerciseListResponseSchema,
    opts(signal),
  );
  return items;
}

export async function listGoalTemplates(
  filters: { section?: PlanSection | null } = {},
  signal?: AbortSignal,
): Promise<GoalTemplateManagerView[]> {
  const { items } = await apiRequest(
    `/plan-library/goal-templates${query({ section: filters.section })}`,
    goalTemplateListResponseSchema,
    opts(signal),
  );
  return items;
}
