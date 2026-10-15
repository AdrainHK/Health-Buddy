import type { Kysely } from 'kysely';
import * as m0001 from './0001-init.js';

export interface Migration {
  name: string;
  up: (db: Kysely<unknown>) => Promise<void>;
}

/** 按顺序列出全部迁移。已发布的迁移不能修改，只能追加新的。 */
export const MIGRATIONS: readonly Migration[] = [{ name: '0001-init', up: m0001.up }];
