import { Inject, Injectable } from '@nestjs/common';
import {
  LIBRARY_STATUS_TRANSITIONS,
  type AdminLibraryListQuery,
  type Exercise,
  type ExerciseContent,
  type GoalParam,
  type GoalTemplate,
  type GoalTemplateContent,
  type LibraryItemEvent,
  type LibraryItemStatus,
  type LibraryItemType,
  type LibraryStatusRequest,
  type Recipe,
  type RecipeContent,
} from '@health-buddy/shared';
import { type ExpressionBuilder, type Selectable } from 'kysely';
import { badRequest, conflict } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import type {
  PlanGoalTemplatesTable,
  PlanLibraryExercisesTable,
  PlanLibraryRecipesTable,
} from '../db/types.js';

/**
 * 方案库（M5 规格 2.4、2.12、6.4）：平台级数据，没有租户列。
 * - 读：健管师、机构管理员、运营商只能看到已发布的条目（行级安全同样限制），预览环境
 *   （PLAN_LIBRARY_PREVIEW=true）另含待审定的；平台管理员在后台能看到全部状态。
 * - 写：只有平台管理员（行级安全是第二道防线）。内容只能在草稿状态下修改，版本号和修改记录
 *   由数据库触发器维护，这里不单独记。
 * 库条目不是客户数据，可以出现原文；日志里仍只记 id 和状态。
 */

export type AnyContent = RecipeContent | ExerciseContent | GoalTemplateContent;
export type AdminItem = Recipe | Exercise | GoalTemplate;
type ManagerItem<T extends AdminItem> = Omit<
  T,
  'status' | 'reviewedByLabel' | 'reviewedOn' | 'updatedByName' | 'updatedAt'
>;

export interface RecipeFilters {
  meal?: string | undefined;
  tags?: string[] | undefined;
  q?: string | undefined;
}
export interface ExerciseFilters {
  category?: string | undefined;
  intensity?: string | undefined;
  q?: string | undefined;
}
export interface GoalTemplateFilters {
  section?: string | undefined;
}

/** 内容改动的冲突：版本号不对（别人改过）、不是草稿、状态流转不允许 */
export type LibraryConflict = 'version_mismatch' | 'not_draft' | 'invalid_transition';

/** 名称搜索：转义 LIKE 的通配符 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 审定日期用文本取出：date 列不经过 JS Date，避免时区把日期挪一天 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 三张库表共用，只用到 reviewed_on 列
const reviewedOnText = (eb: ExpressionBuilder<any, any>) =>
  eb
    .fn<string | null>('to_char', [eb.ref('reviewed_on'), eb.val('YYYY-MM-DD')])
    .as('reviewed_on_text');

@Injectable()
export class PlanLibraryRepository {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 只读事务：预览环境下打开开关，行级安全才放行待审定的条目 */
  private read<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.db, ctx, fn, { planLibraryPreview: this.config.planLibraryPreview });
  }

  /** 健管师和方案能用的状态：已发布；预览环境含待审定 */
  private usableStatuses(): LibraryItemStatus[] {
    return this.config.planLibraryPreview ? ['published', 'review'] : ['published'];
  }

  // ---------- 健管师（和后台只读浏览）看到的列表和详情 ----------

  listRecipes(ctx: TenantContext, f: RecipeFilters): Promise<ManagerItem<Recipe>[]> {
    return this.read(ctx, async (trx) => {
      let q = trx
        .selectFrom('plan_library_recipes')
        .selectAll()
        .select(reviewedOnText)
        .where('status', 'in', this.usableStatuses());
      const meal = f.meal;
      if (meal) q = q.where((eb) => eb(eb.val(meal), '=', eb.fn.any('meal_types')));
      const tags = f.tags;
      // eb.val 把数组作为一个参数传（否则 kysely 会展开成元组）
      if (tags?.length) q = q.where((eb) => eb('tags', '@>', eb.val(tags)));
      if (f.q) q = q.where('name', 'ilike', likePattern(f.q));
      const rows = await q.orderBy('code').execute();
      return rows.map((r) => managerView(toRecipe(r)));
    });
  }

  listExercises(ctx: TenantContext, f: ExerciseFilters): Promise<ManagerItem<Exercise>[]> {
    return this.read(ctx, async (trx) => {
      let q = trx
        .selectFrom('plan_library_exercises')
        .selectAll()
        .select(reviewedOnText)
        .where('status', 'in', this.usableStatuses());
      if (f.category) q = q.where('category', '=', f.category as Exercise['category']);
      if (f.intensity) q = q.where('intensity', '=', f.intensity as Exercise['intensity']);
      if (f.q) q = q.where('name', 'ilike', likePattern(f.q));
      const rows = await q.orderBy('code').execute();
      return rows.map((r) => managerView(toExercise(r)));
    });
  }

  listGoalTemplates(
    ctx: TenantContext,
    f: GoalTemplateFilters,
  ): Promise<ManagerItem<GoalTemplate>[]> {
    return this.read(ctx, async (trx) => {
      let q = trx
        .selectFrom('plan_goal_templates')
        .selectAll()
        .select(reviewedOnText)
        .where('status', 'in', this.usableStatuses());
      if (f.section) q = q.where('section', '=', f.section as GoalTemplate['section']);
      const rows = await q.orderBy('section').orderBy('code').execute();
      return rows.map((r) => managerView(toGoalTemplate(r)));
    });
  }

  /** 条目详情：只有能用的状态，停用、草稿的返回 undefined（404） */
  findUsable(
    ctx: TenantContext,
    type: LibraryItemType,
    id: string,
  ): Promise<ManagerItem<AdminItem> | undefined> {
    return this.read(ctx, async (trx) => {
      const item = await findIn(trx, type, id);
      if (!item || !this.usableStatuses().includes(item.status)) return undefined;
      return managerView(item);
    });
  }

  // ---------- 后台 ----------

  /** 后台列表：平台管理员看到全部状态；协会、机构管理员由行级安全限制为已发布（预览含待审定） */
  listAdmin(
    ctx: TenantContext,
    type: LibraryItemType,
    f: AdminLibraryListQuery,
  ): Promise<AdminItem[]> {
    return this.read(ctx, async (trx) => {
      const items = await listAllIn(trx, type);
      // 协会、机构管理员除了行级安全，代码里也只放行能用的状态
      const allowed =
        ctx.role === 'platform_admin' ? null : (this.usableStatuses() as LibraryItemStatus[]);
      return items.filter(
        (i) =>
          (!allowed || allowed.includes(i.status)) &&
          (!f.status || i.status === f.status) &&
          (!f.q || itemName(i).toLowerCase().includes(f.q.toLowerCase())),
      );
    });
  }

  findAdmin(ctx: TenantContext, type: LibraryItemType, id: string): Promise<AdminItem | undefined> {
    return this.read(ctx, (trx) => findIn(trx, type, id));
  }

  create(ctx: TenantContext, type: LibraryItemType, content: AnyContent): Promise<AdminItem> {
    return this.write(ctx, async (trx) => {
      const id = await insertIn(trx, type, content, ctx.userId);
      const item = await findIn(trx, type, id);
      if (!item) throw new Error('library item vanished after insert');
      return item;
    });
  }

  /**
   * 整条替换内容（code 不变），只能改草稿；version 必须是当前版本。找不到返回 undefined，
   * 冲突返回冲突类型。
   */
  update(
    ctx: TenantContext,
    type: LibraryItemType,
    id: string,
    version: number,
    content: AnyContent,
  ): Promise<AdminItem | LibraryConflict | undefined> {
    return this.write(ctx, async (trx) => {
      const current = await lockIn(trx, type, id);
      if (!current) return undefined;
      if (current.version !== version) return 'version_mismatch';
      if (current.status !== 'draft') return 'not_draft';
      if (current.code !== content.code) throw badRequest();
      await updateIn(trx, type, id, content, ctx.userId);
      return (await findIn(trx, type, id)) ?? undefined;
    });
  }

  /** 状态流转（草稿 → 待审定 → 已发布 → 已停用，可退回草稿）；发布要填审定人和日期 */
  setStatus(
    ctx: TenantContext,
    type: LibraryItemType,
    id: string,
    req: LibraryStatusRequest,
    beforePublish: (item: AdminItem) => void,
  ): Promise<AdminItem | LibraryConflict | undefined> {
    return this.write(ctx, async (trx) => {
      const current = await lockIn(trx, type, id);
      if (!current) return undefined;
      if (current.version !== req.version) return 'version_mismatch';
      if (!LIBRARY_STATUS_TRANSITIONS[current.status].includes(req.status)) {
        return 'invalid_transition';
      }
      if (req.status === 'published') beforePublish(current);
      const set = {
        status: req.status,
        reviewed_by_label: req.status === 'published' ? (req.reviewedByLabel ?? null) : null,
        reviewed_on: req.status === 'published' ? (req.reviewedOn ?? null) : null,
        updated_by: ctx.userId,
      };
      // 停用时保留发布时的审定信息（已停用的条目以前是谁审定的）
      if (req.status === 'retired') {
        await updateTable(trx, type, id, { status: set.status, updated_by: set.updated_by });
      } else {
        await updateTable(trx, type, id, set);
      }
      return (await findIn(trx, type, id)) ?? undefined;
    });
  }

  /** 修改记录（只有平台管理员能看，行级安全同样限制），新的在前 */
  events(ctx: TenantContext, type: LibraryItemType, id: string): Promise<LibraryItemEvent[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('plan_library_events as e')
        .leftJoin('users as u', 'u.id', 'e.actor_id')
        .select(['e.id', 'e.action', 'e.before', 'e.after', 'e.created_at', 'u.display_name'])
        .where('e.item_type', '=', type)
        .where('e.item_id', '=', id)
        .orderBy('e.created_at', 'desc')
        .orderBy('e.id', 'desc')
        .limit(200)
        .execute();
      return rows.map((r) => {
        const after = (r.after ?? {}) as Record<string, unknown>;
        const before = (r.before ?? null) as Record<string, unknown> | null;
        return {
          id: String(r.id),
          action: r.action,
          actorName: r.display_name ?? null,
          status: after.status as LibraryItemStatus,
          version: Number(after.version),
          changes: before ? diffRows(before, after) : [],
          createdAt: r.created_at.toISOString(),
        };
      });
    });
  }

  /** 重复的 code 409；数据库 check 和触发器兜底的形状错误 400 */
  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      const code = dbErrorCode(err);
      if (code === '23505') throw conflict({ reasons: ['duplicate_code'] });
      if (code === '23514' || code === '22023' || code === '22P02' || code === '22007') {
        throw badRequest();
      }
      throw err;
    }
  }
}

// ---------- 行和条目的转换 ----------

type RecipeRow = Selectable<PlanLibraryRecipesTable> & { reviewed_on_text: string | null };
type ExerciseRow = Selectable<PlanLibraryExercisesTable> & { reviewed_on_text: string | null };
type GoalRow = Selectable<PlanGoalTemplatesTable> & { reviewed_on_text: string | null };

function meta(
  r: (RecipeRow | ExerciseRow | GoalRow) & { updated_by_name?: string | null },
): Pick<
  Recipe,
  'id' | 'status' | 'version' | 'reviewedByLabel' | 'reviewedOn' | 'updatedByName' | 'updatedAt'
> {
  return {
    id: r.id,
    status: r.status,
    version: r.version,
    reviewedByLabel: r.reviewed_by_label,
    reviewedOn: r.reviewed_on_text,
    updatedByName: r.updated_by_name ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

function toRecipe(r: RecipeRow & { updated_by_name?: string | null }): Recipe {
  return {
    code: r.code,
    name: r.name,
    mealTypes: r.meal_types as Recipe['mealTypes'],
    ingredients: r.ingredients as Recipe['ingredients'],
    steps: r.steps as string[],
    nutritionPerServing: (r.nutrition_per_serving ?? null) as Recipe['nutritionPerServing'],
    nutritionBasis: r.nutrition_basis,
    tags: r.tags as Recipe['tags'],
    allergens: r.allergens as Recipe['allergens'],
    sourceNote: r.source_note,
    ...meta(r),
  };
}

function toExercise(r: ExerciseRow & { updated_by_name?: string | null }): Exercise {
  return {
    code: r.code,
    name: r.name,
    category: r.category,
    intensity: r.intensity,
    setting: r.setting as Exercise['setting'],
    equipment: r.equipment,
    steps: r.steps as string[],
    keyPoints: r.key_points as string[],
    commonMistakes: r.common_mistakes as string[],
    managerCautions: r.manager_cautions,
    met: r.met === null ? null : Number(r.met),
    sourceNote: r.source_note,
    ...meta(r),
  };
}

function toGoalTemplate(r: GoalRow & { updated_by_name?: string | null }): GoalTemplate {
  return {
    code: r.code,
    section: r.section,
    text: r.text,
    params: r.params as GoalParam[],
    metric: r.metric,
    metricParam: r.metric_param,
    sourceNote: r.source_note,
    ...meta(r),
  };
}

function managerView<T extends AdminItem>(item: T): ManagerItem<T> {
  const { status, reviewedByLabel, reviewedOn, updatedByName, updatedAt, ...rest } = item;
  void status;
  void reviewedByLabel;
  void reviewedOn;
  void updatedByName;
  void updatedAt;
  return rest as ManagerItem<T>;
}

function itemName(i: AdminItem): string {
  return 'name' in i ? i.name : i.text;
}

async function findIn(
  trx: TenantTransaction,
  type: LibraryItemType,
  id: string,
): Promise<AdminItem | undefined> {
  return (await selectIn(trx, type, id))[0];
}

function listAllIn(trx: TenantTransaction, type: LibraryItemType): Promise<AdminItem[]> {
  return selectIn(trx, type, undefined);
}

/** 带最后修改人显示名（看不到用户行的角色为 null） */
async function selectIn(
  trx: TenantTransaction,
  type: LibraryItemType,
  id: string | undefined,
): Promise<AdminItem[]> {
  switch (type) {
    case 'recipe': {
      let q = trx
        .selectFrom('plan_library_recipes as t')
        .leftJoin('users as u', 'u.id', 't.updated_by')
        .selectAll('t')
        .select(['u.display_name as updated_by_name', reviewedOnText]);
      if (id) q = q.where('t.id', '=', id);
      return (await q.orderBy('t.code').execute()).map(toRecipe);
    }
    case 'exercise': {
      let q = trx
        .selectFrom('plan_library_exercises as t')
        .leftJoin('users as u', 'u.id', 't.updated_by')
        .selectAll('t')
        .select(['u.display_name as updated_by_name', reviewedOnText]);
      if (id) q = q.where('t.id', '=', id);
      return (await q.orderBy('t.category').orderBy('t.code').execute()).map(toExercise);
    }
    case 'goal_template': {
      let q = trx
        .selectFrom('plan_goal_templates as t')
        .leftJoin('users as u', 'u.id', 't.updated_by')
        .selectAll('t')
        .select(['u.display_name as updated_by_name', reviewedOnText]);
      if (id) q = q.where('t.id', '=', id);
      return (await q.orderBy('t.section').orderBy('t.code').execute()).map(toGoalTemplate);
    }
  }
}

const TABLES = {
  recipe: 'plan_library_recipes',
  exercise: 'plan_library_exercises',
  goal_template: 'plan_goal_templates',
} as const;

/** 先加行锁，再取整条（版本、状态、code，以及发布前内容检查要用的全部字段） */
async function lockIn(
  trx: TenantTransaction,
  type: LibraryItemType,
  id: string,
): Promise<AdminItem | undefined> {
  // 三张表结构里都有 id 列；kysely 的联合表类型在这里帮不上忙
  const row = await trx
    .selectFrom(TABLES[type] as 'plan_library_recipes')
    .select('id')
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  return row ? findIn(trx, type, id) : undefined;
}

function contentColumns(type: LibraryItemType, content: AnyContent): Record<string, unknown> {
  switch (type) {
    case 'recipe': {
      const r = content as RecipeContent;
      return {
        name: r.name,
        meal_types: r.mealTypes,
        ingredients: JSON.stringify(r.ingredients),
        steps: JSON.stringify(r.steps),
        nutrition_per_serving: r.nutritionPerServing ? JSON.stringify(r.nutritionPerServing) : null,
        nutrition_basis: r.nutritionBasis,
        tags: r.tags,
        allergens: r.allergens,
        source_note: r.sourceNote,
      };
    }
    case 'exercise': {
      const e = content as ExerciseContent;
      return {
        name: e.name,
        category: e.category,
        intensity: e.intensity,
        setting: e.setting,
        equipment: e.equipment,
        steps: JSON.stringify(e.steps),
        key_points: JSON.stringify(e.keyPoints),
        common_mistakes: JSON.stringify(e.commonMistakes),
        manager_cautions: e.managerCautions,
        met: e.met,
        source_note: e.sourceNote,
      };
    }
    case 'goal_template': {
      const g = content as GoalTemplateContent;
      return {
        section: g.section,
        text: g.text,
        params: JSON.stringify(g.params),
        metric: g.metric,
        metric_param: g.metricParam,
        source_note: g.sourceNote,
      };
    }
  }
}

async function insertIn(
  trx: TenantTransaction,
  type: LibraryItemType,
  content: AnyContent,
  userId: string,
): Promise<string> {
  const values = { code: content.code, ...contentColumns(type, content), updated_by: userId };
  // 三张表的列由 contentColumns 按类型给出；kysely 的联合表类型在这里帮不上忙
  const row = await trx
    .insertInto(TABLES[type] as 'plan_library_recipes')
    .values(values as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function updateIn(
  trx: TenantTransaction,
  type: LibraryItemType,
  id: string,
  content: AnyContent,
  userId: string,
): Promise<void> {
  await updateTable(trx, type, id, { ...contentColumns(type, content), updated_by: userId });
}

async function updateTable(
  trx: TenantTransaction,
  type: LibraryItemType,
  id: string,
  set: Record<string, unknown>,
): Promise<void> {
  await trx
    .updateTable(TABLES[type] as 'plan_library_recipes')
    .set(set as never)
    .where('id', '=', id)
    .execute();
}

// ---------- 修改记录的差异 ----------

/** 不列进差异的元数据列 */
const META_COLUMNS = new Set(['id', 'code', 'version', 'updated_by', 'updated_at']);

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** 改前改后有变化的列（内容、状态、审定信息），字段名用接口里的写法 */
export function diffRows(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { field: string; before: unknown; after: unknown }[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const k of [...keys].sort()) {
    if (META_COLUMNS.has(k)) continue;
    const b = before[k] ?? null;
    const a = after[k] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ field: camel(k), before: b, after: a });
  }
  return out;
}
