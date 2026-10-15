import type { Role } from '@health-buddy/shared';
import type { ColumnType, Generated } from 'kysely';

export type { Role };

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OperatorsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  brand_color: string | null;
  status: Generated<'active' | 'suspended'>;
  created_at: Timestamp;
}

export interface OrganizationsTable {
  id: Generated<string>;
  operator_id: string;
  name: string;
  created_at: Timestamp;
}

/** 应用角色读不到 password_hash 列，所以类型里不包含它。 */
export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  role: Role;
  operator_id: string | null;
  org_id: string | null;
  status: Generated<'active' | 'disabled'>;
  created_at: Timestamp;
  last_login_at: Date | null;
}

export interface ClientsTable {
  id: Generated<string>;
  operator_id: string;
  org_id: string | null;
  manager_id: string;
  display_name: string;
  gender: 'female' | 'male' | 'other' | null;
  birth_year: number | null;
  is_synthetic: Generated<boolean>;
  created_at: Timestamp;
}

export interface LlmUsageTable {
  id: Generated<string>;
  operator_id: string | null;
  user_id: string;
  route: string;
  provider: 'openai' | 'anthropic';
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | null;
  duration_ms: number;
  outcome: 'complete' | 'truncated' | 'refused' | 'error';
  error_type: string | null;
  created_at: Timestamp;
}

export interface HealthReportsTable {
  id: Generated<string>;
  client_id: string;
  report_date: ColumnType<Date, Date | string, Date | string>;
  title: string;
  source: 'synthetic' | 'upload' | 'manual';
  created_at: Timestamp;
}

export interface ReportIndicatorsTable {
  id: Generated<string>;
  report_id: string;
  client_id: string;
  code: string;
  /** numeric 列，pg 驱动返回字符串，避免精度丢失 */
  value: ColumnType<string, number | string, number | string>;
  unit: string;
}

export interface MonitoringReadingsTable {
  id: Generated<string>;
  client_id: string;
  metric: string;
  value: ColumnType<string, number | string, number | string>;
  unit: string;
  measured_at: Timestamp;
  source: 'synthetic' | 'device' | 'manual' | 'companion';
}

type Json<T> = ColumnType<T, string, string>;

/** 健管师本人的工作数据都带这三个租户字段 */
interface ManagerScoped {
  operator_id: string;
  org_id: string | null;
  manager_id: string;
}

export interface TasksTable extends ManagerScoped {
  id: Generated<string>;
  client_id: string | null;
  title: string;
  archived_at: Date | null;
  detached_reason: 'client_transferred' | 'client_deleted' | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskMessagesTable extends ManagerScoped {
  id: Generated<string>;
  task_id: string;
  role: 'manager' | 'assistant';
  mode: 'ask' | 'plan' | 'craft';
  content: Generated<string>;
  skill_id: string | null;
  client_refs: ColumnType<string[], string[] | undefined, string[]>;
  status: 'streaming' | 'complete' | 'stopped' | 'refused' | 'error';
  created_at: Timestamp;
}

export interface TaskStepsTable extends ManagerScoped {
  id: Generated<string>;
  message_id: string;
  seq: number;
  kind: 'read_client' | 'detect_critical' | 'run_skill' | 'answer';
  label_key: string;
  status: 'running' | 'done' | 'failed';
  started_at: Timestamp;
  finished_at: Date | null;
}

export interface TaskPlansTable extends ManagerScoped {
  id: Generated<string>;
  message_id: string;
  steps: Json<unknown[]>;
  status: 'proposed' | 'confirmed' | 'revised';
  created_at: Timestamp;
}

export interface ArtifactsTable extends ManagerScoped {
  id: Generated<string>;
  task_id: string;
  client_id: string | null;
  skill_id: string;
  kind: string;
  lineage_id: string;
  version: number;
  parent_id: string | null;
  status: 'draft' | 'approved' | 'returned' | 'voided';
  content: Json<{ professional: string; clientFacing: string }>;
  critical_flags: ColumnType<unknown[], string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ArtifactEventsTable extends ManagerScoped {
  id: Generated<string>;
  artifact_id: string;
  actor_id: string | null;
  action: 'created' | 'edited' | 'approved' | 'returned' | 'voided' | 'copied' | 'exported';
  reason: string | null;
  format: 'png' | 'pdf' | null;
  created_at: Timestamp;
}

interface CriticalRuleColumns {
  id: Generated<string>;
  metric: string;
  comparator: 'gte' | 'gt' | 'lte' | 'lt';
  value: ColumnType<string, number | string, number | string>;
  level: 'urgent' | 'attention';
  enabled: Generated<boolean>;
  updated_by: string | null;
  updated_at: Timestamp;
}

/** 全平台唯一的一套阈值，只有平台管理员能改（Q12） */
export type CriticalThresholdsTable = CriticalRuleColumns;

export interface CriticalThresholdEventsTable {
  id: Generated<string>;
  threshold_id: string;
  actor_id: string | null;
  action: 'created' | 'updated' | 'deleted';
  before: unknown;
  after: unknown;
  created_at: Timestamp;
}

export interface Database {
  operators: OperatorsTable;
  organizations: OrganizationsTable;
  users: UsersTable;
  clients: ClientsTable;
  llm_usage: LlmUsageTable;
  health_reports: HealthReportsTable;
  report_indicators: ReportIndicatorsTable;
  monitoring_readings: MonitoringReadingsTable;
  tasks: TasksTable;
  task_messages: TaskMessagesTable;
  task_steps: TaskStepsTable;
  task_plans: TaskPlansTable;
  artifacts: ArtifactsTable;
  artifact_events: ArtifactEventsTable;
  critical_thresholds: CriticalThresholdsTable;
  critical_threshold_events: CriticalThresholdEventsTable;
}
