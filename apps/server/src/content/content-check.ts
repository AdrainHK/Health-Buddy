import {
  checkPopsciContent,
  contentRulesSchema,
  hasForbiddenHits,
  hasReviewHits,
  popsciContentSchema,
  type ContentCheckHit,
  type ContentCheckResult,
  type ContentRules,
} from '@health-buddy/shared';
import type { TenantTransaction } from '../db/database.js';

/**
 * 科普产物的合规检查（M8 规格 2.3）：读当前版本的词表，用 shared 的确定性检查器检查，
 * 结果写进 content_compliance_results。内容指纹由数据库按产物当前内容填写，
 * 内容或命中项变了数据库会清空“已核对”。
 */

export async function currentContentRules(
  trx: TenantTransaction,
): Promise<{ version: number; rules: ContentRules }> {
  const row = await trx
    .selectFrom('content_rules')
    .select(['version', 'rules'])
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  return { version: row.version, rules: contentRulesSchema.parse(row.rules) };
}

/** 检查并保存；structured 不合规（不是科普内容）时按全部禁止处理，不能确认 */
export async function runContentCheck(
  trx: TenantTransaction,
  artifact: { id: string; structured: unknown },
): Promise<ContentCheckHit[]> {
  // 租户字段跟产物一致（按行级安全读得到的才是本人的产物）
  const scope = await trx
    .selectFrom('artifacts')
    .select(['operator_id', 'org_id', 'manager_id'])
    .where('id', '=', artifact.id)
    .executeTakeFirstOrThrow();
  const { version, rules } = await currentContentRules(trx);
  const parsed = popsciContentSchema.safeParse(artifact.structured);
  const hits: ContentCheckHit[] = parsed.success
    ? checkPopsciContent(parsed.data, rules)
    : [
        {
          ruleId: 'builtin_structure',
          category: 'forbid',
          term: '',
          reason: '内容结构不完整，请重新生成',
          location: { field: 'title', index: null, item: null },
        },
      ];
  const values = {
    rules_version: version,
    hits: JSON.stringify(hits),
  };
  await trx
    .insertInto('content_compliance_results')
    .values({
      artifact_id: artifact.id,
      ...scope,
      ...values,
    })
    .onConflict((oc) => oc.column('artifact_id').doUpdateSet(values))
    .execute();
  return hits;
}

export async function loadContentCheck(
  trx: TenantTransaction,
  artifactId: string,
): Promise<ContentCheckResult | null> {
  const row = await trx
    .selectFrom('content_compliance_results')
    .select(['rules_version', 'hits', 'checked_at', 'acked_by', 'acked_at'])
    .where('artifact_id', '=', artifactId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    rulesVersion: row.rules_version,
    hits: row.hits as ContentCheckHit[],
    checkedAt: row.checked_at.toISOString(),
    ackedBy: row.acked_by,
    ackedAt: row.acked_at?.toISOString() ?? null,
  };
}

/** 确认前的合规原因：禁止类没消除 → content_check_failed；需要人工判断的没核对 → content_check_pending */
export function contentCheckReasons(
  check: Pick<ContentCheckResult, 'hits' | 'ackedAt'> | null,
): ('content_check_failed' | 'content_check_pending')[] {
  if (!check || hasForbiddenHits(check.hits)) return ['content_check_failed'];
  if (hasReviewHits(check.hits) && check.ackedAt === null) return ['content_check_pending'];
  return [];
}
