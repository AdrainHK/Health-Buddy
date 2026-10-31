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
import * as m0012 from './0012-experts.js';
import * as m0013 from './0013-consultation-signals.js';
import * as m0014 from './0014-expert-usage-stats.js';
import * as m0015 from './0015-expert-reconsult.js';
import * as m0016 from './0016-client-twin.js';
import * as m0017 from './0017-twin-compute.js';
import * as m0018 from './0018-twin-ai.js';
import * as m0019 from './0019-task-title-source.js';
import * as m0020 from './0020-plan-followup.js';
import * as m0021 from './0021-sesame-allergen.js';
import * as m0022 from './0022-plan-stats.js';
import * as m0023 from './0023-screenshot-material.js';
import * as m0024 from './0024-companion-devices.js';
import * as m0025 from './0025-companion-deliveries.js';
import * as m0026 from './0026-companion-voice.js';
import * as m0027 from './0027-companion-dialogue.js';
import * as m0028 from './0028-companion-checkins.js';
import * as m0029 from './0029-companion-inbox.js';
import * as m0030 from './0030-handoff-reply.js';
import * as m0031 from './0031-twin-mental.js';
import * as m0032 from './0032-account-provisioning.js';
import * as m0033 from './0033-operator-accounts.js';

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
  { name: '0012-experts', up: m0012.up },
  { name: '0013-consultation-signals', up: m0013.up },
  { name: '0014-expert-usage-stats', up: m0014.up },
  { name: '0015-expert-reconsult', up: m0015.up },
  { name: '0016-client-twin', up: m0016.up },
  { name: '0017-twin-compute', up: m0017.up },
  { name: '0018-twin-ai', up: m0018.up },
  { name: '0019-task-title-source', up: m0019.up },
  { name: '0020-plan-followup', up: m0020.up },
  { name: '0021-sesame-allergen', up: m0021.up },
  { name: '0022-plan-stats', up: m0022.up },
  { name: '0023-screenshot-material', up: m0023.up },
  { name: '0024-companion-devices', up: m0024.up },
  { name: '0025-companion-deliveries', up: m0025.up },
  { name: '0026-companion-voice', up: m0026.up },
  { name: '0027-companion-dialogue', up: m0027.up },
  { name: '0028-companion-checkins', up: m0028.up },
  { name: '0029-companion-inbox', up: m0029.up },
  { name: '0030-handoff-reply', up: m0030.up },
  { name: '0031-twin-mental', up: m0031.up },
  { name: '0032-account-provisioning', up: m0032.up },
  { name: '0033-operator-accounts', up: m0033.up },
];
