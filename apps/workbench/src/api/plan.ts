import { myPlanResponseSchema, type MyPlan } from '@health-buddy/shared';
import { apiRequest } from './http';

/** 健管师自己的套餐、到期日和本月用量（M7 规格 2.5 第 5 条） */
export async function fetchMyPlan(): Promise<MyPlan> {
  return (await apiRequest('/me/plan', myPlanResponseSchema)).plan;
}
