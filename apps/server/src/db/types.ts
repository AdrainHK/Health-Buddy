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

export interface Database {
  operators: OperatorsTable;
  organizations: OrganizationsTable;
  users: UsersTable;
  clients: ClientsTable;
  llm_usage: LlmUsageTable;
}
