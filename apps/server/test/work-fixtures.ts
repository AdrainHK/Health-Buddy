import { DISCLAIMER } from '@health-buddy/shared';
import type { CriticalFlag } from '@health-buddy/shared';
import type { ownerDb } from './fixtures.js';

type Owner = ReturnType<typeof ownerDb>;

export interface Scope {
  operatorId: string;
  orgId: string;
  managerId: string;
}

export const CLEAN_CLIENT_TEXT = `您最近一个月的血压比较平稳，继续保持规律作息。\n\n${DISCLAIMER}`;

/** 以所有者身份建一个任务（全部是虚构数据） */
export async function insertTask(db: Owner, s: Scope, clientId: string | null = null) {
  const row = await db
    .insertInto('tasks')
    .values({
      operator_id: s.operatorId,
      org_id: s.orgId,
      manager_id: s.managerId,
      client_id: clientId,
      title: '测试任务',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id as string;
}

/** 以所有者身份建一份草稿产物，模拟技能生成的结果 */
export async function insertDraft(
  db: Owner,
  s: Scope,
  taskId: string,
  options: {
    clientId?: string | null;
    clientFacing?: string;
    criticalFlags?: CriticalFlag[];
  } = {},
) {
  const id = crypto.randomUUID();
  await db
    .insertInto('artifacts')
    .values({
      id,
      operator_id: s.operatorId,
      org_id: s.orgId,
      manager_id: s.managerId,
      task_id: taskId,
      client_id: options.clientId ?? null,
      skill_id: 'client-recent-summary',
      kind: 'recent_summary',
      lineage_id: id,
      version: 1,
      status: 'draft',
      content: JSON.stringify({
        professional: '该客户近 30 天收缩压平稳。',
        clientFacing: options.clientFacing ?? CLEAN_CLIENT_TEXT,
      }),
      critical_flags: JSON.stringify(options.criticalFlags ?? []),
    })
    .execute();
  return id;
}

export const SBP_FLAG: CriticalFlag = {
  metric: 'sbp',
  value: 185,
  unit: 'mmHg',
  observedOn: '2026-10-01',
  source: 'monitoring',
  rule: { comparator: 'gte', value: 180, level: 'urgent' },
};
