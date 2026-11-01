import { z } from 'zod';
import { contentCheckCategorySchema } from './popsci.js';

/**
 * 科普合规规则（M8 规格 2.3，Q3）：平台在后台维护，按版本记录；只用于科普，不改原有禁用词表。
 * 规则只能是词表（不接受正则，避免误配和回溯过慢）；原有禁用词、药名、看不见的格式字符、
 * 数字和引用是内置检查，不能在后台关掉（见 content/popsci-check.ts）。
 */

export const CONTENT_RULE_GROUPS_MAX = 30;
export const CONTENT_RULE_TERMS_MAX = 200;
export const CONTENT_RULE_TERM_MAX = 20;

const visible = (v: string) => !/[\p{Cf}\p{Cc}͏︀-️]/u.test(v);

export const contentRuleGroupSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  category: contentCheckCategorySchema,
  label: z.string().trim().min(1).max(30).refine(visible),
  reason: z.string().trim().min(1).max(80).refine(visible),
  terms: z
    .array(z.string().trim().min(1).max(CONTENT_RULE_TERM_MAX).refine(visible))
    .min(1)
    .max(CONTENT_RULE_TERMS_MAX),
  /**
   * 前面紧挨着否定词（不、别、勿、没、无、非、未、莫）时不算命中，
   * 例如“不能代替药物”“不要擅自停药”“不能保证”。
   */
  negatable: z.boolean(),
});
export type ContentRuleGroup = z.infer<typeof contentRuleGroupSchema>;

export const contentRulesSchema = z
  .array(contentRuleGroupSchema)
  .min(1)
  .max(CONTENT_RULE_GROUPS_MAX)
  .refine((groups) => new Set(groups.map((g) => g.id)).size === groups.length, {
    message: 'duplicate_group_id',
  })
  .refine((groups) => groups.every((g) => !g.id.startsWith('builtin_')), {
    message: 'reserved_group_id',
  });
export type ContentRules = z.infer<typeof contentRulesSchema>;

export const contentRulesResponseSchema = z.object({
  version: z.number().int().positive(),
  rules: contentRulesSchema,
  createdAt: z.iso.datetime(),
  /** 历史版本（新的在前），只有版本号和时间 */
  history: z.array(z.object({ version: z.number().int().positive(), createdAt: z.iso.datetime() })),
});
export type ContentRulesResponse = z.infer<typeof contentRulesResponseSchema>;

export const saveContentRulesRequestSchema = z.object({
  /** 编辑时看到的版本；别人已经存了新版本时返回 409 */
  baseVersion: z.number().int().positive(),
  rules: contentRulesSchema,
});
export type SaveContentRulesRequest = z.infer<typeof saveContentRulesRequestSchema>;
