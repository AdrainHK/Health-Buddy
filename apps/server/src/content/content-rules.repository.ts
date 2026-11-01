import { Inject, Injectable } from '@nestjs/common';
import {
  contentRulesSchema,
  type ContentRulesResponse,
  type SaveContentRulesRequest,
} from '@health-buddy/shared';
import { conflict, forbidden } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { adminSaveContentRules } from '../db/content-rules.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';

/** 科普合规规则（M8 规格 2.3、3.3，Q3）。读按行级安全，写只经数据库函数 */
@Injectable()
export class ContentRulesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  get(ctx: TenantContext): Promise<ContentRulesResponse> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('content_rules')
        .select(['version', 'rules', 'created_at'])
        .orderBy('version', 'desc')
        .limit(50)
        .execute();
      const latest = rows[0];
      if (!latest) throw forbidden();
      return {
        version: latest.version,
        rules: contentRulesSchema.parse(latest.rules),
        createdAt: latest.created_at.toISOString(),
        history: rows.map((r) => ({ version: r.version, createdAt: r.created_at.toISOString() })),
      };
    });
  }

  async save(ctx: TenantContext, input: SaveContentRulesRequest): Promise<ContentRulesResponse> {
    try {
      await withTenant(this.db, ctx, (trx) =>
        adminSaveContentRules(trx, input.baseVersion, input.rules),
      );
    } catch (err) {
      const code = dbErrorCode(err);
      // 别人已经存了新版本
      if (code === 'HB004') throw conflict({ reasons: ['rules_changed'] });
      if (code === '42501') throw forbidden();
      throw err;
    }
    return this.get(ctx);
  }
}
