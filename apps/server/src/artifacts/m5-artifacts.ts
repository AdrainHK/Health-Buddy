import { EXPERTS } from '@health-buddy/experts';
import {
  allergenConflicts,
  carePlanStructuredSchema,
  findBannedTerms,
  handoffReplyStructuredSchema,
  validateGoalParams,
  visitRecordStructuredSchema,
  visitScheduleStructuredSchema,
  type ApproveRejection,
  type CarePlanStructured,
  type GoalParam,
  POPSCI_KINDS,
  isPopsciKind,
  popsciContentSchema,
} from '@health-buddy/shared';
import {
  findClientDrugIssues,
  findClientTwinTerms,
  findExpertMentions,
} from '@health-buddy/skills';
import { badRequest } from '../common/api-error.js';
import type { TenantContext, TenantTransaction } from '../db/database.js';
import { dateInRange } from '../care/visits.repository.js';
import { managerTimeZone } from '../care/common.js';
import { localDate } from '../twin/time-zone.js';

/**
 * M5 的四种产物（规格 2.3、2.7、2.8、2.9、6.3）：
 * - care_plan 有通俗版；visit_schedule、visit_script、visit_record 只有专业版（没有复制和导出）。
 * - care_plan、visit_schedule、visit_record 确认时要写 care_plans、visits、visit_records，
 *   只能经数据库的确认函数（5.4 第 1 条）；这里在调用函数之前做全部可以说清原因的检查。
 * - structured 只能在 care_plan、visit_schedule、visit_record 草稿上由健管师修改（替换库条目、改参数、
 *   改日程、补填随访日期和方式）。
 */

type RejectReason = ApproveRejection['reasons'][number];

export const M5_WRITING_KINDS = ['care_plan', 'visit_schedule', 'visit_record'] as const;
export type M5WritingKind = (typeof M5_WRITING_KINDS)[number];

export function isM5WritingKind(kind: string): kind is M5WritingKind {
  return (M5_WRITING_KINDS as readonly string[]).includes(kind);
}

/** 只有专业版的 M5 产物：不查通俗版，也不能复制、导出 */
// M6 /转交回复 同样只有专业版：回复原文在 structured.reply，审核后由福宝念给客户（规格 2.9）
const PROFESSIONAL_ONLY_KINDS = new Set([
  'visit_schedule',
  'visit_script',
  'visit_record',
  'handoff_reply',
  // M8 科普：文章、PPT、社群稿的结构化内容（规格 3.1）
  ...POPSCI_KINDS,
]);

export function professionalOnlyKind(kind: string): boolean {
  return PROFESSIONAL_ONLY_KINDS.has(kind);
}

/** 健管师能改 structured 的产物（随访记录：素材里看不出日期、方式时由健管师补填，2.9 第 4 条） */
const EDITABLE_STRUCTURED = new Set([
  'care_plan',
  'visit_schedule',
  'visit_record',
  'handoff_reply',
  // M8 科普：文章、PPT、社群稿的结构化内容（规格 3.1）
  ...POPSCI_KINDS,
]);

const EXPERT_NAMES = EXPERTS.map((e) => e.meta.name);

/**
 * 校验健管师改过的 structured（PATCH /api/artifacts/:id）：形状、库条目已发布、目标参数在模板范围内、
 * 日程日期在今天到 6 个月后、随访记录的日期不在今天之后。不合格 → 400。返回要存的结构化内容。
 */
export async function validateEditedStructured(
  trx: TenantTransaction,
  ctx: TenantContext,
  kind: string,
  structured: unknown,
  current: unknown = null,
): Promise<unknown> {
  if (!EDITABLE_STRUCTURED.has(kind)) throw badRequest();
  // 科普：形状、长度上限，类型不能换（规格 3.1）；合规检查在保存后做
  if (isPopsciKind(kind)) {
    const parsed = popsciContentSchema.safeParse(structured);
    if (!parsed.success || parsed.data.kind !== kind) throw badRequest();
    return parsed.data;
  }
  // /转交回复：只能改回复原文（≤ 150 字），对应的转交不能换
  if (kind === 'handoff_reply') {
    const parsed = handoffReplyStructuredSchema.safeParse(structured);
    const before = handoffReplyStructuredSchema.safeParse(current);
    if (!parsed.success || !before.success || parsed.data.handoffId !== before.data.handoffId) {
      throw badRequest();
    }
    return parsed.data;
  }
  if (kind === 'visit_record') {
    const parsed = visitRecordStructuredSchema.safeParse(structured);
    if (!parsed.success) throw badRequest();
    if (parsed.data.visitDate) {
      const today = localDate(new Date(), await managerTimeZone(trx, ctx, 'Asia/Shanghai'));
      if (parsed.data.visitDate > today) throw badRequest();
    }
    return parsed.data;
  }
  if (kind === 'visit_schedule') {
    const parsed = visitScheduleStructuredSchema.safeParse(structured);
    if (!parsed.success) throw badRequest();
    const today = localDate(new Date(), await managerTimeZone(trx, ctx, 'Asia/Shanghai'));
    if (parsed.data.rows.some((r) => !dateInRange(r.dueDate, today))) throw badRequest();
    return parsed.data;
  }
  const parsed = carePlanStructuredSchema.safeParse(structured);
  if (!parsed.success) throw badRequest();
  const problems = await carePlanLibraryProblems(trx, parsed.data);
  if (problems.length) throw badRequest();
  return parsed.data;
}

/** 方案引用的库条目和目标参数的问题（以健管师身份查，只认已发布的条目） */
async function carePlanLibraryProblems(
  trx: TenantTransaction,
  s: CarePlanStructured,
): Promise<RejectReason[]> {
  const reasons = new Set<RejectReason>();
  const recipeIds = [...new Set(s.recipes.map((r) => r.recipeId))];
  const exerciseIds = [...new Set(s.exercises.map((e) => e.exerciseId))];
  const goals = s.sections.flatMap((x) => x.goals);
  const templateIds = [...new Set(goals.map((g) => g.templateId))];
  const published = async (
    table: 'plan_library_recipes' | 'plan_library_exercises' | 'plan_goal_templates',
    ids: string[],
  ) =>
    ids.length
      ? (
          await trx
            .selectFrom(table as 'plan_library_recipes')
            .select('id')
            .where('id', 'in', ids)
            .where('status', '=', 'published')
            .execute()
        ).length
      : 0;
  if ((await published('plan_library_recipes', recipeIds)) !== recipeIds.length) {
    reasons.add('library_item_unavailable');
  }
  if ((await published('plan_library_exercises', exerciseIds)) !== exerciseIds.length) {
    reasons.add('library_item_unavailable');
  }
  const templates = templateIds.length
    ? await trx
        .selectFrom('plan_goal_templates')
        .select(['id', 'params'])
        .where('id', 'in', templateIds)
        .where('status', '=', 'published')
        .execute()
    : [];
  if (templates.length !== templateIds.length) reasons.add('library_item_unavailable');
  const byId = new Map(templates.map((t) => [t.id, t.params as GoalParam[]]));
  for (const g of goals) {
    const params = byId.get(g.templateId);
    if (params && validateGoalParams(params, g.params).length) {
      reasons.add('goal_param_out_of_range');
    }
  }
  return [...reasons];
}

/**
 * 方案确认前的 M5 检查（2.3 审核）：通俗版不能有药名或用药建议、孪生颜色和预测、专家名称；
 * 引用的库条目必须已发布、目标参数在范围内；用到的食谱和过敏史有匹配时必须勾选“已核对过敏原”。
 */
export async function carePlanApproveReasons(
  trx: TenantTransaction,
  row: { client_id: string | null; structured: unknown; content: { clientFacing: string } },
  acknowledgedAllergens: boolean,
): Promise<RejectReason[]> {
  const parsed = carePlanStructuredSchema.safeParse(row.structured);
  // 每一部分的通俗版文字也是给客户的（以后渲染和伴侣读取用），和整份通俗版一起查
  const sectionTexts = parsed.success ? parsed.data.sections.map((x) => x.clientFacing) : [];
  const reasons = new Set<RejectReason>(clientPlanTextReasons(row.content.clientFacing));
  for (const t of sectionTexts) {
    for (const r of clientPlanTextReasons(t)) reasons.add(r);
    if (findBannedTerms(t).length) reasons.add('banned_terms');
  }
  if (!parsed.success) {
    // 结构化内容读不出来（不应发生）：不误报成库条目问题
    reasons.add('schedule_mismatch');
    return [...reasons];
  }
  for (const r of await carePlanLibraryProblems(trx, parsed.data)) reasons.add(r);
  if (!acknowledgedAllergens && row.client_id) {
    const recipeIds = [...new Set(parsed.data.recipes.map((r) => r.recipeId))];
    if (recipeIds.length) {
      const recipes = await trx
        .selectFrom('plan_library_recipes')
        .select(['id', 'allergens'])
        .where('id', 'in', recipeIds)
        .execute();
      const history = await trx
        .selectFrom('client_health_history')
        .select('content')
        .where('client_id', '=', row.client_id)
        .where('category', '=', 'allergy')
        .where('deleted_at', 'is', null)
        .execute();
      const conflicts = allergenConflicts(
        history.map((h) => h.content),
        recipes.map((r) => ({ id: r.id, allergens: r.allergens as never })),
      );
      if (conflicts.length) reasons.add('allergens_not_acknowledged');
    }
  }
  return [...reasons];
}

/**
 * 方案通俗版文字的 M5 检查（规格 2.3）：药名、用药建议和保健品，孪生颜色和预测，专家名称。
 * 复制和导出前也再查一遍（已审核内容数据库层不能改，那里是多一道保险）。
 */
export function clientPlanTextReasons(text: string): RejectReason[] {
  const reasons: RejectReason[] = [];
  if (findClientDrugIssues(text).length) reasons.push('drug_in_client_text');
  if (findClientTwinTerms(text).length) reasons.push('twin_in_client_text');
  if (findExpertMentions(text, EXPERT_NAMES).length) reasons.push('expert_in_client_text');
  return reasons;
}

/** 随访计划确认前：日期不早于今天、不超过 6 个月后、不重复 */
export async function scheduleApproveReasons(
  trx: TenantTransaction,
  ctx: TenantContext,
  structured: unknown,
): Promise<RejectReason[]> {
  const parsed = visitScheduleStructuredSchema.safeParse(structured);
  if (!parsed.success) return ['schedule_mismatch'];
  const today = localDate(new Date(), await managerTimeZone(trx, ctx, 'Asia/Shanghai'));
  return parsed.data.rows.every((r) => dateInRange(r.dueDate, today)) ? [] : ['schedule_mismatch'];
}

/** 随访记录确认前：必须有随访日期和方式，日期不能在今天之后 */
export async function recordApproveReasons(
  trx: TenantTransaction,
  ctx: TenantContext,
  structured: unknown,
): Promise<RejectReason[]> {
  const parsed = visitRecordStructuredSchema.safeParse(structured);
  if (!parsed.success || !parsed.data.visitDate || !parsed.data.method) {
    return ['record_incomplete'];
  }
  const today = localDate(new Date(), await managerTimeZone(trx, ctx, 'Asia/Shanghai'));
  return parsed.data.visitDate > today ? ['record_incomplete'] : [];
}
