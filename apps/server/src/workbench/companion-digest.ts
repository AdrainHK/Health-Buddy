import {
  COMPANION_HANDOFF_OVERDUE_MS,
  type CheckinKind,
  type CheckinMetric,
  type CompanionHandoffCategory,
  type ObservationCategory,
} from '@health-buddy/shared';
import {
  COMPANION_DIGEST_DAYS,
  COMPANION_DIGEST_EXAMPLES,
  previewText,
  redactIdentifiers,
  type CompanionDigest,
} from '@health-buddy/skills';
import type { TenantContext, TenantTransaction } from '../db/database.js';
import { localDate } from '../twin/time-zone.js';

const DAY_MS = 86_400_000;

/**
 * 读伴侣“福宝”近 14 天的信息（M6 规格 2.7、2.8、Q25），/随访话术、问一问、“伴侣跟进”计划共用。
 * 只读服务这位客户的健管师本人的行（行级安全之外再按 manager_id 过滤）；机构管理员、运营商、平台
 * 看不到明细（Q28），返回 null。客户没有绑定设备、近 14 天也没有任何伴侣数据时返回 null（没有开通）；
 * 客户撤回同意后同样返回 null。
 * 原句、转交原话先按格式去掉电话和证件号；客户姓名由调用方再去掉。
 */
export async function loadCompanionDigest(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
  now = new Date(),
): Promise<CompanionDigest | null> {
  if (ctx.role !== 'manager') return null;
  // 客户撤回同意后不再读福宝的信息（产品负责人 2026-10-30 确认），数据删除前的 7 天里同样按没有开通处理
  const consent = await trx
    .selectFrom('companion_consents')
    .select('action')
    .where('client_id', '=', clientId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (consent?.action === 'revoke') return null;
  const since = new Date(now.getTime() - COMPANION_DIGEST_DAYS * DAY_MS);
  const sinceDay = localDate(since, 'Asia/Shanghai');

  const device = await trx
    .selectFrom('companion_devices')
    .select('id')
    .where('client_id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .executeTakeFirst();

  const observations = await trx
    .selectFrom('companion_observations')
    .select(['category', 'polarity', 'text'])
    .where('client_id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .where('status', '<>', 'dismissed')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(200)
    .execute();

  const checkins = await trx
    .selectFrom('checkins as c')
    .innerJoin('checkin_plans as p', 'p.id', 'c.plan_id')
    .select(['p.kind', 'p.metric', 'c.status'])
    .where('c.client_id', '=', clientId)
    .where('c.manager_id', '=', ctx.userId)
    .where('c.due_on', '>=', new Date(`${sinceDay}T00:00:00Z`))
    .execute();

  const handoffs = await trx
    .selectFrom('companion_handoffs')
    .select(['category', 'question', 'created_at'])
    .where('client_id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .where('status', '=', 'open')
    .orderBy('created_at', 'desc')
    .limit(10)
    .execute();

  if (!device && !observations.length && !checkins.length && !handoffs.length) return null;

  const byCategory = new Map<ObservationCategory, CompanionDigest['observations'][number]>();
  for (const o of observations) {
    const category = o.category as ObservationCategory;
    const entry = byCategory.get(category) ?? { category, count: 0, negative: 0, examples: [] };
    entry.count += 1;
    if (o.polarity === 'negative') entry.negative += 1;
    if (entry.examples.length < COMPANION_DIGEST_EXAMPLES) {
      entry.examples.push(redactIdentifiers(o.text));
    }
    byCategory.set(category, entry);
  }

  const byPlan = new Map<string, CompanionDigest['checkins'][number]>();
  for (const c of checkins) {
    const key = `${c.kind}:${c.metric ?? ''}`;
    const entry = byPlan.get(key) ?? {
      kind: c.kind as CheckinKind,
      metric: (c.metric ?? null) as CheckinMetric | null,
      done: 0,
      partial: 0,
      missed: 0,
      noResponse: 0,
    };
    if (c.status === 'done') entry.done += 1;
    else if (c.status === 'partial') entry.partial += 1;
    else if (c.status === 'missed') entry.missed += 1;
    else if (c.status === 'no_response') entry.noResponse += 1;
    byPlan.set(key, entry);
  }

  return {
    days: COMPANION_DIGEST_DAYS,
    observations: [...byCategory.values()],
    checkins: [...byPlan.values()],
    openHandoffs: handoffs.map((h) => ({
      category: h.category as CompanionHandoffCategory,
      createdOn: localDate(h.created_at, 'Asia/Shanghai'),
      preview: previewText(redactIdentifiers(h.question)),
      overdue: now.getTime() - h.created_at.getTime() > COMPANION_HANDOFF_OVERDUE_MS,
    })),
  };
}
