import type { ResolvedSession } from '../auth/auth.repository.js';
import { notFound } from './api-error.js';

/**
 * 工作台只给健管师用（M1 规格第二节）。其他角色按“不存在”处理，不提示“无权限”；
 * 行级安全是第二道防线。
 */
export function requireManager(session: ResolvedSession): void {
  if (session.role !== 'manager') throw notFound();
}
