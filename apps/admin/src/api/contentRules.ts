import {
  contentRulesResponseSchema,
  type ContentRules,
  type ContentRulesResponse,
} from '@health-buddy/shared';
import { apiRequest } from './http';

/** 科普合规规则（M8 规格 2.3，Q3）：所有后台账号可读，只有平台能保存新版本 */
export function getContentRules(): Promise<ContentRulesResponse> {
  return apiRequest('/admin/content-rules', contentRulesResponseSchema);
}

export function saveContentRules(
  baseVersion: number,
  rules: ContentRules,
): Promise<ContentRulesResponse> {
  return apiRequest('/admin/content-rules', contentRulesResponseSchema, {
    method: 'PUT',
    body: { baseVersion, rules },
  });
}
