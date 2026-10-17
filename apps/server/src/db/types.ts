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

/**
 * 档案数据的租户列由触发器从客户行填写（0008），插入时可以不给。
 * 应用写入时仍按当前上下文给出，和触发器的结果一致。
 */
interface ClientScoped {
  operator_id: Generated<string>;
  org_id: Generated<string | null>;
  manager_id: Generated<string>;
}

type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;
/** 可为空的 numeric 列，pg 驱动返回字符串，避免精度丢失 */
type NullableNumeric = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;

export interface HealthReportsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  report_date: ColumnType<Date, Date | string, Date | string>;
  title: string;
  source: 'synthetic' | 'upload' | 'manual';
  created_at: Timestamp;
  /** 核对后写入的报告来自哪次上传（M2）；合成数据为空 */
  upload_id: Nullable<string>;
  institution: Nullable<string>;
  verified_by: Nullable<string>;
  verified_at: Nullable<Date>;
}

export type AbnormalColumn = 'high' | 'low' | 'normal' | 'no_reference';

export interface ReportIndicatorsTable extends ClientScoped {
  id: Generated<string>;
  report_id: string;
  client_id: string;
  /** 未收录指标（Q10）为空 */
  code: string | null;
  /** 目录指标必有；未收录指标读不出数字时为空 */
  value: NullableNumeric;
  unit: string;
  raw_name: Nullable<string>;
  original_value: Nullable<string>;
  original_unit: Nullable<string>;
  ref_low: NullableNumeric;
  ref_high: NullableNumeric;
  ref_text: Nullable<string>;
  abnormal: ColumnType<AbnormalColumn, AbnormalColumn | undefined, AbnormalColumn>;
  superseded_by: Nullable<string>;
  created_at: Timestamp;
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
  report_refs: ColumnType<string[], string[] | undefined, string[]>;
  status: 'streaming' | 'complete' | 'stopped' | 'refused' | 'error';
  created_at: Timestamp;
}

export interface TaskStepsTable extends ManagerScoped {
  id: Generated<string>;
  message_id: string;
  seq: number;
  kind:
    'read_client' | 'read_report' | 'compare_reports' | 'detect_critical' | 'run_skill' | 'answer';
  label_key: string;
  label_date: ColumnType<string | null, string | null | undefined, string | null>;
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
  source_report_id: ColumnType<string | null, string | null | undefined, string | null>;
  risk_tier_suggestion: ColumnType<
    { tier: 'high' | 'medium' | 'low'; reason: string } | null,
    string | null | undefined,
    string | null
  >;
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

export interface ClientHealthHistoryTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  category: 'past_history' | 'family_history' | 'medication' | 'allergy' | 'lifestyle';
  content: string;
  recorded_on: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** 分层历史，只能追加；最新一条就是当前分层 */
export interface ClientRiskTiersTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  tier: 'high' | 'medium' | 'low';
  reason: string;
  source: ColumnType<'manual' | 'artifact', 'manual' | 'artifact' | undefined, never>;
  source_artifact_id: ColumnType<string | null, string | null | undefined, string | null>;
  set_by: string;
  set_at: Timestamp;
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

export type UploadStatusColumn =
  'queued' | 'processing' | 'needs_review' | 'verified' | 'failed' | 'discarded';
export type FailureCategoryColumn =
  'not_a_report' | 'unreadable' | 'refused' | 'timeout' | 'too_large' | 'error' | 'transferred';

/** 一次上传就是一条识别记录（M2 规格 3.2） */
export interface ReportUploadsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  task_id: string | null;
  status: Generated<UploadStatusColumn>;
  failure_category: Nullable<FailureCategoryColumn>;
  attempts: Generated<number>;
  claimed_attempt: Generated<number>;
  quota_refunded_attempt: Generated<number>;
  version: Generated<number>;
  page_count: number;
  progress_page: Generated<number>;
  report_date: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  institution: Nullable<string>;
  report_id: Nullable<string>;
  uploaded_by: string;
  requested_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  verified_by: Nullable<string>;
  verified_at: Nullable<Date>;
  critical_acknowledged: Generated<boolean>;
  /** 健管师确认报告上的姓名是本客户（姓名本身不读取、不保存） */
  identity_confirmed_by: Nullable<string>;
  identity_confirmed_at: Nullable<Date>;
}

export interface ReportFilesTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  upload_id: string;
  seq: number;
  storage_key: string;
  mime_type: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/heic';
  size_bytes: number;
  page_count: number;
  sha256: string;
  original_name: string;
  created_at: Timestamp;
  purged_at: Nullable<Date>;
}

export type ExtractedFlagColumn =
  | 'unreadable'
  | 'out_of_bounds'
  | 'unit_converted'
  | 'unit_unknown'
  | 'unmapped'
  | 'conflict'
  | 'duplicate';

export interface ExtractedValuesTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  upload_id: string;
  seq: number;
  raw_name: string;
  code: string | null;
  raw_value: string;
  raw_unit: string | null;
  value: NullableNumeric;
  unit: string | null;
  ref_low: NullableNumeric;
  ref_high: NullableNumeric;
  ref_text: string | null;
  page: number | null;
  source_snippet: string | null;
  flags: ColumnType<
    ExtractedFlagColumn[],
    ExtractedFlagColumn[] | undefined,
    ExtractedFlagColumn[]
  >;
  review_status: ColumnType<
    'pending' | 'checked' | 'edited' | 'deleted' | 'added',
    'pending' | 'checked' | 'edited' | 'deleted' | 'added' | undefined,
    'pending' | 'checked' | 'edited' | 'deleted' | 'added'
  >;
  checked_by: Nullable<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ReportEventAction =
  | 'uploaded'
  | 'extraction_started'
  | 'extraction_failed'
  | 'extraction_done'
  | 'value_edited'
  | 'value_added'
  | 'value_deleted'
  | 'value_checked'
  | 'verified'
  | 'discarded'
  | 'corrected'
  | 'file_viewed'
  | 'file_purged'
  | 'transferred';

/** 识别和核对的操作记录：只记谁、什么时候、对哪一项做了什么，不记数值和原文 */
export interface ReportEventsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  upload_id: string | null;
  report_id: Nullable<string>;
  actor_id: string | null;
  action: ReportEventAction;
  extracted_value_id: Nullable<string>;
  indicator_id: Nullable<string>;
  file_id: Nullable<string>;
  created_at: Timestamp;
  /** 'confirm_all'：由“确认所有数据”一键记下 */
  via: Nullable<'confirm_all'>;
}

export interface ReportExtractionQuotaTable {
  manager_id: string;
  operator_id: string;
  day: ColumnType<Date, Date | string, Date | string>;
  pages: number;
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
  client_health_history: ClientHealthHistoryTable;
  client_risk_tiers: ClientRiskTiersTable;
  report_uploads: ReportUploadsTable;
  report_files: ReportFilesTable;
  extracted_values: ExtractedValuesTable;
  report_events: ReportEventsTable;
  report_extraction_quota: ReportExtractionQuotaTable;
  tasks: TasksTable;
  task_messages: TaskMessagesTable;
  task_steps: TaskStepsTable;
  task_plans: TaskPlansTable;
  artifacts: ArtifactsTable;
  artifact_events: ArtifactEventsTable;
  critical_thresholds: CriticalThresholdsTable;
  critical_threshold_events: CriticalThresholdEventsTable;
}
