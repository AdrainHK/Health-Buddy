import type { ResolvedSession } from '../auth/auth.repository.js';
import { notFound } from './api-error.js';

/**
 * 工作台只给健管师用（M1 规格第二节）。其他角色按“不存在”处理，不提示“无权限”；
 * 行级安全是第二道防线。
 */
export function requireManager(session: ResolvedSession): void {
  if (session.role !== 'manager') throw notFound();
}

/** 能看专家库的角色：健管师和三级后台账号。客户（M6 起）不在其中 */
const EXPERT_VIEWER_ROLES: ReadonlySet<string> = new Set([
  'manager',
  'org_admin',
  'operator_admin',
  'platform_admin',
]);

/**
 * 专家只面向健管师和后台账号（M3 规格 7.2 第 2 条）。显式拒绝其余角色（包括以后加入的客户角色），
 * 不依赖“客户角色还不存在”；按“不存在”处理。
 */
export function requireExpertViewer(session: Pick<ResolvedSession, 'role'>): void {
  if (!EXPERT_VIEWER_ROLES.has(session.role as string)) throw notFound();
}
