import { z } from 'zod';
import { artifactStatusSchema } from './artifacts.js';

/**
 * 工作台首页（M8 规格 2.4、3.2、3.3）。首页不新建表、不调用模型；
 * 伴侣预警、今日跟进、今日随访沿用现有接口，这里只补“待审核草稿”和“快捷入口”的排序。
 * 只有 id、标题、时间和数量，不含产物正文。
 */

/** 每个分区默认显示的条数 */
export const HOME_SECTION_LIMIT = 5;
/** “查看全部”时最多列出的待审核草稿 */
export const HOME_DRAFTS_MAX = 50;
/** 快捷入口：技能和专家的个数（Q8） */
export const HOME_SHORTCUT_SKILLS = 6;
export const HOME_SHORTCUT_EXPERTS = 3;
/** 快捷入口按最近多少天的使用次数排序（Q8） */
export const HOME_USAGE_DAYS = 30;
/** 没有使用记录时的默认技能顺序（Q8）；没上线的技能前端跳过 */
export const HOME_DEFAULT_SKILLS = [
  'report-interpretation',
  'care-plan',
  'visit-script',
  'popsci-article',
  'lecture-deck',
  'client-recent-summary',
] as const;

export const homeDraftSchema = z.object({
  artifactId: z.uuid(),
  taskId: z.uuid(),
  taskTitle: z.string(),
  /** 客户姓名由前端按健管师本人的客户列表显示，和侧栏一致 */
  clientId: z.uuid().nullable(),
  skillId: z.string(),
  version: z.number().int().positive(),
  status: artifactStatusSchema,
  hasCriticalFlags: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type HomeDraft = z.infer<typeof homeDraftSchema>;

export const homeResponseSchema = z.object({
  /** 状态为草稿的产物，按生成时间从早到晚，最早的排最前；最多 HOME_DRAFTS_MAX 条 */
  drafts: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(homeDraftSchema).max(HOME_DRAFTS_MAX),
  }),
  /** 本人最近 HOME_USAGE_DAYS 天用过的技能和专家，按次数从多到少；没用过的不列，前端用默认顺序补齐 */
  usage: z.object({
    skills: z.array(z.string()),
    experts: z.array(z.string()),
  }),
});
export type HomeResponse = z.infer<typeof homeResponseSchema>;

/**
 * 快捷入口的顺序：先按使用次数，再按默认顺序补齐，只保留 available 里有的，最多 limit 个。
 */
export function orderShortcuts(
  used: readonly string[],
  defaults: readonly string[],
  available: readonly string[],
  limit: number,
): string[] {
  const ok = new Set(available);
  const out: string[] = [];
  for (const id of [...used, ...defaults, ...available]) {
    if (out.length >= limit) break;
    if (ok.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
