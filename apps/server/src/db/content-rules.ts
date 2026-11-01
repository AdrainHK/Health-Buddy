import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/** M8 科普合规规则（迁移 0037）。函数开头校验调用者是平台、写操作记录；这里只负责传参 */
export async function adminSaveContentRules(
  trx: TenantTransaction,
  baseVersion: number,
  rules: unknown,
): Promise<number> {
  const { rows } = await sql<{ version: number }>`
    select admin_save_content_rules(${baseVersion}::integer, ${JSON.stringify(rules)}::jsonb) as version
  `.execute(trx);
  return rows[0]!.version;
}
