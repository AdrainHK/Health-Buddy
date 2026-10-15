import { Inject, Injectable } from '@nestjs/common';
import type { UsageRecord } from '@health-buddy/ai-engine';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';

/** 大模型调用计量。以发起调用的用户身份写入，行级安全保证不能替别人记账。 */
@Injectable()
export class UsageRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(ctx: TenantContext, r: UsageRecord): Promise<void> {
    await withTenant(this.db, ctx, (trx) =>
      trx
        .insertInto('llm_usage')
        .values({
          operator_id: ctx.operatorId,
          user_id: ctx.userId,
          route: r.route,
          provider: r.provider,
          model: r.model,
          input_tokens: r.inputTokens,
          output_tokens: r.outputTokens,
          cost_usd: r.costUsd === null ? null : String(r.costUsd),
          duration_ms: r.durationMs,
          outcome: r.outcome,
          error_type: r.errorType ?? null,
        })
        .execute(),
    );
  }
}
