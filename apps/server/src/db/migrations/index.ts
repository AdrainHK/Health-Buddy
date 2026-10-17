import type { Kysely } from 'kysely';
import * as m0001 from './0001-init.js';
import * as m0002 from './0002-llm-usage.js';
import * as m0003 from './0003-health-data.js';
import * as m0004 from './0004-workbench.js';
import * as m0005 from './0005-critical-thresholds.js';
import * as m0006 from './0006-platform-thresholds.js';
import * as m0007 from './0007-detach-lock-order.js';
import * as m0008 from './0008-client-record.js';
import * as m0009 from './0009-report-upload.js';
import * as m0010 from './0010-interpretation.js';
import * as m0011 from './0011-upload-identity-confirm.js';

export interface Migration {
  name: string;
  up: (db: Kysely<unknown>) => Promise<void>;
}

/** 按顺序列出全部迁移。已发布的迁移不能修改，只能追加新的。 */
export const MIGRATIONS: readonly Migration[] = [
  { name: '0001-init', up: m0001.up },
  { name: '0002-llm-usage', up: m0002.up },
  { name: '0003-health-data', up: m0003.up },
  { name: '0004-workbench', up: m0004.up },
  { name: '0005-critical-thresholds', up: m0005.up },
  { name: '0006-platform-thresholds', up: m0006.up },
  { name: '0007-detach-lock-order', up: m0007.up },
  { name: '0008-client-record', up: m0008.up },
  { name: '0009-report-upload', up: m0009.up },
  { name: '0010-interpretation', up: m0010.up },
  { name: '0011-upload-identity-confirm', up: m0011.up },
];
