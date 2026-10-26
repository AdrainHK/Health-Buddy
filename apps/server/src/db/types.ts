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
  /** 健管师的时区（M4 Q13）；只能经 user_set_timezone 修改 */
  timezone: ColumnType<string | null, string | null | undefined, never>;
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
  /** 专家、路由、汇总调用的专家 id（M3 规格 3.7） */
  expert_id: ColumnType<string | null, string | null | undefined, never>;
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

/** 租户列由触发器从客户行填写（M4 迁移 0016） */
export interface MonitoringReadingsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  metric: string;
  value: ColumnType<string, number | string, number | string>;
  unit: string;
  measured_at: Timestamp;
  source: 'synthetic' | 'device' | 'manual' | 'companion';
  /** 手动录入的健管师（Q29）；其余来源为空 */
  created_by: Nullable<string>;
  /** 写入时间（0017），由触发器填写 */
  created_at: ColumnType<Date, undefined, never>;
}

type Json<T> = ColumnType<T, string, string>;

/** 健管师本人的工作数据都带这三个租户字段 */
interface ManagerScoped {
  operator_id: string;
  org_id: string | null;
  manager_id: string;
}

export type TaskTitleSource = 'default' | 'auto_text' | 'auto_skill' | 'manual';

export interface TasksTable extends ManagerScoped {
  id: Generated<string>;
  client_id: string | null;
  title: string;
  /** 标题的来历（0019）：default、auto_text、auto_skill 会按对话内容自动生成，manual 不再自动改 */
  title_source: ColumnType<TaskTitleSource, TaskTitleSource | undefined, TaskTitleSource>;
  archived_at: Date | null;
  detached_reason: 'client_transferred' | 'client_deleted' | null;
  /** 专家中心发起的任务绑定的专家（M3） */
  expert_id: ColumnType<string | null, string | null | undefined, never>;
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
  expert_refs: ColumnType<string[], string[] | undefined, never>;
  excluded_experts: ColumnType<string[], string[] | undefined, never>;
  /** @ 引用的孪生项（迁移 0018），JSON 数组：{kind, code}，最多 3 个 */
  twin_refs: ColumnType<unknown, string | undefined, never>;
  /** @ 引用的库条目（迁移 0020），JSON 数组：{type, id}，最多 3 个 */
  library_refs: ColumnType<unknown, string | undefined, never>;
  /** @ 引用的随访素材（迁移 0020），最多 3 份 */
  material_refs: ColumnType<string[], string[] | undefined, string[]>;
  plan_options: ColumnType<unknown, string | null | undefined, never>;
  status: 'streaming' | 'complete' | 'stopped' | 'refused' | 'error';
  created_at: Timestamp;
}

export interface TaskStepsTable extends ManagerScoped {
  id: Generated<string>;
  message_id: string;
  seq: number;
  kind:
    | 'read_client'
    | 'read_report'
    | 'compare_reports'
    | 'detect_critical'
    | 'run_skill'
    | 'answer'
    | 'route_experts'
    | 'consult_experts'
    | 'consult_expert'
    | 'synthesize_experts'
    | 'read_twin'
    | 'compute_forecast'
    | 'read_care_plan'
    | 'select_library_items'
    | 'schedule_visits'
    | 'read_visit_materials'
    | 'read_visit_records';
  label_key: string;
  expert_ids: ColumnType<string[], string[] | undefined, never>;
  label_date: ColumnType<string | null, string | null | undefined, string | null>;
  label_time: ColumnType<Date | null, Date | null | undefined, never>;
  consultation_id: ColumnType<string | null, string | null | undefined, never>;
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
  consultation_id: ColumnType<string | null, string | null | undefined, never>;
  emergency_signal: ColumnType<boolean, boolean | undefined, never>;
  crisis_signal: ColumnType<boolean, boolean | undefined, never>;
  risk_tier_suggestion: ColumnType<
    { tier: 'high' | 'medium' | 'low'; reason: string } | null,
    string | null | undefined,
    string | null
  >;
  /** 按 kind 的结构化内容（迁移 0020） */
  structured: ColumnType<unknown, string | null | undefined, string | null>;
  /** /方案生成 的选项（迁移 0020），生成后不能改 */
  plan_options: ColumnType<unknown, string | null | undefined, never>;
  visit_id: ColumnType<string | null, string | null | undefined, never>;
  material_ids: ColumnType<string[] | null, string[] | null | undefined, never>;
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

type JsonColumn<T> = ColumnType<T, string | undefined, string>;
type NullableJson<T> = ColumnType<T | null, string | null | undefined, string | null>;

/** 一次“请专家”（M3 规格 6.2）。终态之后不能修改（触发器） */
export interface ExpertConsultationsTable extends ManagerScoped {
  id: Generated<string>;
  task_id: string;
  message_id: string;
  client_id: ColumnType<string | null, string | null | undefined, never>;
  report_id: ColumnType<string | null, string | null | undefined, never>;
  trigger: 'expert_center' | 'mention' | 'skill_auto' | 'plan' | 'twin';
  routing: JsonColumn<unknown>;
  status: 'running' | 'done' | 'partial' | 'failed' | 'stopped';
  synthesis: NullableJson<unknown>;
  synthesis_status: Nullable<'skipped' | 'done' | 'failed'>;
  /** 心理危机 / 疑似急症信号：关键词、各位专家和汇总合并，只能从 false 变成 true */
  crisis_signal: Generated<boolean>;
  emergency_signal: Generated<boolean>;
  reused_from: ColumnType<string | null, string | null | undefined, never>;
  /** 由哪次调用派生：重新请专家、补请专家（迁移 0015） */
  origin_id: ColumnType<string | null, string | null | undefined, never>;
  origin_kind: ColumnType<
    'reconsult' | 'add_expert' | null,
    'reconsult' | 'add_expert' | null | undefined,
    never
  >;
  /** 这次调用回答的健管师消息；请求里和专家有关的部分（只有专家 id） */
  request_message_id: ColumnType<string | null, string | null | undefined, never>;
  request_key: ColumnType<string | null, string | null | undefined, never>;
  /** “请专家看看”关联的跟进项和孪生项（迁移 0018） */
  follow_up_item_id: ColumnType<string | null, string | null | undefined, never>;
  twin_refs: ColumnType<unknown, string | null | undefined, never>;
  created_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/** 每位专家的一次调用。opinion 含健康信息，只存数据库，不进日志 */
export interface ExpertCallsTable extends ManagerScoped {
  id: Generated<string>;
  consultation_id: string;
  expert_id: string;
  expert_version: string;
  sources_version: string;
  selected_reason: 'manager' | 'rule' | 'model';
  status: 'running' | 'done' | 'failed' | 'timeout' | 'refused' | 'stopped';
  failure_category: Nullable<'timeout' | 'refused' | 'invalid_output' | 'provider_error'>;
  opinion: NullableJson<unknown>;
  removed_findings: ColumnType<number, number | undefined, number>;
  provider: Nullable<'openai' | 'anthropic'>;
  model: Nullable<string>;
  input_tokens: ColumnType<number, number | undefined, number>;
  output_tokens: ColumnType<number, number | undefined, number>;
  started_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface ExpertFeedbackTable extends ManagerScoped {
  id: Generated<string>;
  expert_call_id: string;
  rating: 'useful' | 'not_useful';
  reason: Nullable<'inaccurate' | 'too_general' | 'out_of_scope' | 'bad_citation' | 'other'>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** 平台级上下架开关（Q11） */
export interface ExpertAvailabilityTable {
  expert_id: string;
  enabled: boolean;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ExpertAvailabilityEventsTable {
  id: Generated<string>;
  expert_id: string;
  actor_id: string | null;
  action: 'paused' | 'resumed';
  created_at: Timestamp;
}

// ---------- M4 客户数字孪生（0016） ----------

/** 只能追加的列：插入后不能修改 */
type Insertable<T> = ColumnType<T, T, never>;
type InsertableNullable<T> = ColumnType<T | null, T | null | undefined, never>;

export interface TwinStatusRulesTable {
  id: Generated<string>;
  domain: 'metabolic' | 'cardiovascular' | 'sleep' | 'weight';
  metric: string;
  source: 'report' | 'monitoring';
  method: 'critical' | 'out_of_reference' | 'threshold';
  comparator: 'gte' | 'gt' | 'lte' | 'lt' | null;
  value: NullableNumeric;
  unit: string | null;
  window_days: number | null;
  level: 'red' | 'yellow';
  enabled: Generated<boolean>;
  updated_by: string | null;
  updated_at: Timestamp;
}

export interface TwinRulesVersionTable {
  id: Generated<boolean>;
  version: number;
  updated_at: Date;
}

export interface TwinStatusRuleEventsTable {
  id: Generated<string>;
  rule_id: string;
  actor_id: string | null;
  action: 'created' | 'updated' | 'deleted' | 'reset';
  before: unknown;
  after: unknown;
  rules_version: number;
  created_at: Timestamp;
}

/** 状态历史：只能追加 */
export interface TwinStatusHistoryTable extends ClientScoped {
  id: Generated<string>;
  client_id: Insertable<string>;
  domain: Insertable<'metabolic' | 'cardiovascular' | 'sleep' | 'weight'>;
  level: Insertable<'red' | 'yellow' | 'green' | 'unknown'>;
  origin: Insertable<'computed' | 'manual' | 'manual_cleared'>;
  basis: ColumnType<unknown, string, never>;
  rules_version: Insertable<number>;
  reason: InsertableNullable<string>;
  manual_expires: InsertableNullable<'next_data' | 'never'>;
  trigger: Insertable<
    | 'report_verified'
    | 'correction'
    | 'monitoring'
    | 'rules_changed'
    | 'thresholds_changed'
    | 'manual'
    | 'seed'
    | 'backfill'
  >;
  set_by: InsertableNullable<string>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** 预测：只能追加，只放行 superseded_at 从空变为有值 */
export interface TwinForecastsTable extends ClientScoped {
  id: Generated<string>;
  client_id: Insertable<string>;
  metric: Insertable<string>;
  source: Insertable<'report' | 'monitoring'>;
  method_version: Insertable<string>;
  horizon_months: InsertableNullable<3 | 6>;
  points: ColumnType<unknown, string, never>;
  basis: ColumnType<unknown, string | null | undefined, never>;
  fit: ColumnType<unknown, string | null | undefined, never>;
  interval_level: ColumnType<string, number | string | undefined, never>;
  n_points: Insertable<number>;
  span_days: Insertable<number>;
  uncertainty: InsertableNullable<'normal' | 'high'>;
  status: Insertable<'ok' | 'insufficient_data'>;
  insufficient_reason: InsertableNullable<'not_forecastable' | 'too_few_points' | 'span_too_short'>;
  points_needed: InsertableNullable<number>;
  computed_at: ColumnType<Date, Date | string | undefined, never>;
  superseded_at: ColumnType<Date | null, undefined, Date | string>;
}

export interface FollowUpItemsTable extends ClientScoped {
  id: Generated<string>;
  client_id: Insertable<string>;
  kind: Insertable<'critical' | 'status_red' | 'status_worsened' | 'forecast_deviation'>;
  severity: 1 | 2 | 3 | 4;
  domain: InsertableNullable<'metabolic' | 'cardiovascular' | 'sleep' | 'weight'>;
  metric: InsertableNullable<string>;
  basis: Json<unknown>;
  source_ref: Json<unknown>;
  dedupe_key: Insertable<string>;
  status: ColumnType<
    'open' | 'done' | 'snoozed' | 'dismissed',
    'open' | undefined,
    'open' | 'done' | 'snoozed' | 'dismissed'
  >;
  snooze_until: Nullable<Date>;
  resolution: Nullable<'called' | 'recheck_arranged' | 'referred' | 'plan_adjusted' | 'other'>;
  dismiss_reason: Nullable<'data_error' | 'known' | 'under_care' | 'other'>;
  note: Nullable<string>;
  first_triggered_at: ColumnType<Date, undefined, never>;
  last_triggered_at: ColumnType<Date, undefined, Date | string>;
  resolved_by: Nullable<string>;
  resolved_at: Nullable<Date>;
  created_at: ColumnType<Date, undefined, never>;
}

/** 跟进项的处理记录：只能追加；应用只能直接写 consulted */
export interface FollowUpEventsTable extends ClientScoped {
  id: Generated<string>;
  client_id: Insertable<string>;
  item_id: Insertable<string>;
  actor_id: InsertableNullable<string>;
  action: Insertable<
    'created' | 'retriggered' | 'done' | 'snoozed' | 'dismissed' | 'reopened' | 'consulted'
  >;
  created_at: ColumnType<Date, undefined, never>;
}

/** 每位客户的计算状态（0017）：请求重算和算完的时间 */
export interface TwinComputeStateTable extends ClientScoped {
  client_id: Insertable<string>;
  requested_at: Nullable<Date>;
  computed_at: Nullable<Date>;
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
  expert_consultations: ExpertConsultationsTable;
  expert_calls: ExpertCallsTable;
  expert_feedback: ExpertFeedbackTable;
  expert_availability: ExpertAvailabilityTable;
  expert_availability_events: ExpertAvailabilityEventsTable;
  twin_status_rules: TwinStatusRulesTable;
  twin_rules_version: TwinRulesVersionTable;
  twin_status_rule_events: TwinStatusRuleEventsTable;
  twin_status_history: TwinStatusHistoryTable;
  twin_forecasts: TwinForecastsTable;
  follow_up_items: FollowUpItemsTable;
  follow_up_events: FollowUpEventsTable;
  twin_compute_state: TwinComputeStateTable;
  plan_library_recipes: PlanLibraryRecipesTable;
  plan_library_exercises: PlanLibraryExercisesTable;
  plan_goal_templates: PlanGoalTemplatesTable;
  plan_library_events: PlanLibraryEventsTable;
  visit_frequency_rules: VisitFrequencyRulesTable;
  visit_frequency_config: VisitFrequencyConfigTable;
  visit_frequency_version: VisitFrequencyVersionTable;
  visit_frequency_rule_events: VisitFrequencyRuleEventsTable;
  care_plans: CarePlansTable;
  visits: VisitsTable;
  client_record_consents: ClientRecordConsentsTable;
  visit_materials: VisitMaterialsTable;
  visit_records: VisitRecordsTable;
  visit_record_addenda: VisitRecordAddendaTable;
  visit_events: VisitEventsTable;
}

// ---------- M5 方案和随访（迁移 0020） ----------

type LibraryStatus = 'draft' | 'review' | 'published' | 'retired';

interface LibraryItemColumns {
  id: Generated<string>;
  code: ColumnType<string, string, never>;
  source_note: string;
  status: ColumnType<LibraryStatus, LibraryStatus | undefined, LibraryStatus>;
  /** 内容改动时由触发器加一 */
  version: ColumnType<number, number | undefined, never>;
  reviewed_by_label: Nullable<string>;
  reviewed_on: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  updated_by: Nullable<string>;
  updated_at: ColumnType<Date, undefined, never>;
}

export interface PlanLibraryRecipesTable extends LibraryItemColumns {
  name: string;
  meal_types: string[];
  ingredients: Json<unknown[]>;
  steps: Json<unknown[]>;
  nutrition_per_serving: ColumnType<unknown, string | null | undefined, string | null>;
  nutrition_basis: Nullable<string>;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  allergens: string[];
}

export interface PlanLibraryExercisesTable extends LibraryItemColumns {
  name: string;
  category: 'aerobic' | 'strength' | 'flexibility' | 'balance' | 'relaxation';
  intensity: 'low' | 'moderate';
  setting: string[];
  equipment: ColumnType<string[], string[] | undefined, string[]>;
  steps: Json<unknown[]>;
  key_points: Json<unknown[]>;
  common_mistakes: ColumnType<unknown[], string | undefined, string>;
  manager_cautions: string;
  met: NullableNumeric;
}

export interface PlanGoalTemplatesTable extends LibraryItemColumns {
  section: 'diet' | 'exercise' | 'routine' | 'mind';
  text: string;
  params: ColumnType<unknown[], string | undefined, string>;
  metric: Nullable<'steps' | 'sleep_hours'>;
  metric_param: Nullable<string>;
}

export interface PlanLibraryEventsTable {
  id: Generated<string>;
  item_type: 'recipe' | 'exercise' | 'goal_template';
  item_id: string;
  actor_id: string | null;
  action: 'created' | 'updated' | 'status_changed';
  before: unknown;
  after: unknown;
  created_at: Timestamp;
}

export type VisitMethodColumn = 'phone' | 'wechat' | 'in_person' | 'video';

export interface VisitFrequencyRulesTable {
  risk_tier: ColumnType<'high' | 'medium' | 'low' | 'none', never, never>;
  interval_days: ColumnType<number, never, number>;
  default_method: ColumnType<VisitMethodColumn, never, VisitMethodColumn>;
  updated_by: ColumnType<string | null, never, string | null>;
  updated_at: ColumnType<Date, never, never>;
}

export interface VisitFrequencyConfigTable {
  id: ColumnType<boolean, never, never>;
  first_visit_within_days: ColumnType<number, never, number>;
  updated_by: ColumnType<string | null, never, string | null>;
  updated_at: ColumnType<Date, never, never>;
}

export interface VisitFrequencyVersionTable {
  id: ColumnType<boolean, never, never>;
  version: ColumnType<number, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface VisitFrequencyRuleEventsTable {
  id: Generated<string>;
  actor_id: string | null;
  before: unknown;
  after: unknown;
  rules_version: number;
  created_at: Timestamp;
}

/** 只经 approve_care_plan 写入；应用只能把生效方案结束 */
export interface CarePlansTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  artifact_id: string | null;
  lineage_id: string;
  sections: string[];
  snapshot: unknown;
  cycle_weeks: number;
  start_date: Date;
  review_date: Date;
  status: 'active' | 'ended' | 'superseded';
  end_reason: Nullable<'cycle_completed' | 'client_paused' | 'needs_medical_review' | 'other'>;
  approved_by: string;
  approved_at: Timestamp;
  ended_by: Nullable<string>;
  ended_at: Nullable<Date>;
}

export type VisitStatusColumn =
  'planned' | 'done' | 'missed' | 'cancelled' | 'superseded' | 'pending_plan';

export interface VisitsTable extends ClientScoped {
  id: Generated<string>;
  client_id: ColumnType<string, string, never>;
  due_date: ColumnType<Date, Date | string, Date | string>;
  method: VisitMethodColumn;
  purpose: ColumnType<
    'routine' | 'plan_review' | 'follow_up' | 'adhoc',
    'routine' | 'follow_up' | 'adhoc',
    never
  >;
  focus: Nullable<string>;
  origin: ColumnType<'schedule' | 'plan_review' | 'manual', 'manual', never>;
  source_artifact_id: ColumnType<string | null, undefined, never>;
  care_plan_id: ColumnType<string | null, undefined, never>;
  follow_up_item_id: ColumnType<string | null, string | null | undefined, never>;
  status: ColumnType<VisitStatusColumn, 'planned' | undefined, VisitStatusColumn>;
  cancel_reason: Nullable<'client_paused' | 'contacted_elsewhere' | 'duplicate' | 'other'>;
  note: Nullable<string>;
  record_id: Nullable<string>;
  rescheduled_from: ColumnType<Date | null, undefined, Date | string | null>;
  done_at: ColumnType<Date | null, undefined, Date | string | null>;
  created_by: ColumnType<string | null, string, never>;
  created_at: ColumnType<Date, undefined, never>;
}

export interface ClientRecordConsentsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  kind: 'visit_material';
  confirmed_by: string;
  confirmed_at: ColumnType<Date, undefined, never>;
}

/** 原文由后端加密后存入，只给上传的健管师读；到期或客户转出后删除 */
export interface VisitMaterialsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  visit_id: ColumnType<string | null, string | null | undefined, never>;
  kind: 'paste' | 'txt';
  text_encrypted: ColumnType<Buffer | null, Buffer, never>;
  char_count: number;
  uploaded_by: string;
  consumed_artifact_id: ColumnType<string | null, undefined, never>;
  purge_after: ColumnType<Date, undefined, never>;
  purged_at: ColumnType<Date | null, undefined, never>;
  created_at: ColumnType<Date, undefined, never>;
}

/** 只经 approve_visit_record 写入，只能追加 */
export interface VisitRecordsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  visit_id: string | null;
  artifact_id: string | null;
  visit_date: Date;
  method: VisitMethodColumn;
  snapshot: unknown;
  approved_by: string;
  approved_at: Timestamp;
}

export interface VisitRecordAddendaTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  record_id: string;
  text: string;
  created_by: string;
  created_at: ColumnType<Date, undefined, never>;
}

export interface VisitEventsTable extends ClientScoped {
  id: Generated<string>;
  client_id: string;
  visit_id: string;
  actor_id: string | null;
  action:
    'created' | 'rescheduled' | 'done' | 'missed' | 'cancelled' | 'superseded' | 'plan_activated';
  created_at: Timestamp;
}
