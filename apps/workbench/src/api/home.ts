import { homeResponseSchema, type HomeResponse } from '@health-buddy/shared';
import { apiRequest } from './http';

/** 首页的待审核草稿和快捷入口排序（M8 规格 2.4） */
export function getHome(signal?: AbortSignal): Promise<HomeResponse> {
  return apiRequest('/home', homeResponseSchema, signal ? { signal } : {});
}
