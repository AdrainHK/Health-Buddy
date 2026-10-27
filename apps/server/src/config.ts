import { loadGatewayConfig, type GatewayConfig } from '@health-buddy/ai-engine';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** 数据库所有者连接串，只用于迁移。 */
  DATABASE_URL: z.url(),
  /** 应用角色 hb_app 的密码。应用运行时用这个受行级安全约束的角色连接数据库。 */
  APP_DATABASE_PASSWORD: z.string().min(16, 'APP_DATABASE_PASSWORD 至少 16 位'),
  /** 工作台前端构建产物目录；设置后由后端一并提供静态页面。 */
  WORKBENCH_DIST: z.string().optional(),
  /** 后台（apps/admin）前端构建产物目录；设置后由后端在 /admin/ 下提供页面。 */
  ADMIN_DIST: z.string().optional(),
  /** 首次部署时创建平台管理员；已有平台管理员时忽略。 */
  PLATFORM_ADMIN_EMAIL: z.email().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
  /**
   * 报告原件的对象存储（S3 兼容，M2 Q5）。S3_BUCKET、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY
   * 都设置了才启用；没设置时上传和查看原件返回“未配置”，其他功能照常。
   */
  S3_ENDPOINT: z.preprocess(emptyAsUnset, z.url().optional()),
  S3_REGION: z.preprocess(emptyAsUnset, z.string().min(1).default('us-east-1')),
  S3_BUCKET: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
  S3_ACCESS_KEY_ID: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
  /** MinIO 等需要路径风格的地址时设为 true */
  S3_FORCE_PATH_STYLE: z.preprocess(emptyAsUnset, z.enum(['true', 'false']).default('false')),
  /** 报告识别队列（BullMQ）用的 Redis。没设置时上传和重新识别返回“未配置” */
  REDIS_URL: z.preprocess(emptyAsUnset, z.url().optional()),
  /**
   * 专家预览开关（M3 规格 Q1、Q2）：知识来源和医学顾问签字确认前，专家只在预览环境试用。
   * 默认关闭：正式环境不开放专家中心和自动调用，/体检解读 保持 M2 的行为。
   */
  EXPERTS_PREVIEW: z.preprocess(emptyAsUnset, z.enum(['true', 'false']).default('false')),
  /**
   * 方案库预览开关（M5 规格 2.4、4.1）：种子条目经营养、运动顾问审定前状态为“待审定”，
   * 只在预览环境可用。默认关闭：正式环境只能看到和引用已发布的条目。
   */
  PLAN_LIBRARY_PREVIEW: z.preprocess(emptyAsUnset, z.enum(['true', 'false']).default('false')),
});

/** 空字符串按“没有配置”处理：部署平台里留空的变量会以空字符串传进来 */
function emptyAsUnset(v: unknown): unknown {
  return v === '' ? undefined : v;
}

export interface StorageConfig {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  ownerDatabaseUrl: string;
  appDatabaseUrl: string;
  appDatabasePassword: string;
  workbenchDist: string | undefined;
  adminDist: string | undefined;
  secureCookies: boolean;
  platformAdmin: { email: string; password: string } | undefined;
  /** 大模型网关配置（厂商密钥、默认型号、按用途覆盖） */
  llm: GatewayConfig;
  /** 报告原件的对象存储；没有配置时为空 */
  storage: StorageConfig | undefined;
  /** 报告识别队列的 Redis 地址；没有配置时为空 */
  redisUrl: string | undefined;
  /** 只配了一部分的对象存储变量名（不含值），启动时提示 */
  incompleteStorageVars: string[];
  /** 专家预览开关：打开时 review 状态的专家可用（来源待确认） */
  expertsPreview: boolean;
  /** 方案库预览开关：打开时待审定的库条目可用（顾问审定前） */
  planLibraryPreview: boolean;
}

export const APP_DB_ROLE = 'hb_app';

/** 用所有者连接串推导出应用角色的连接串：换掉用户名和密码，其余不变。 */
export function deriveAppDatabaseUrl(ownerUrl: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_DB_ROLE;
  url.password = password;
  return url.toString();
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // 只列出出错的变量名和原因，不打印变量值，避免把密钥写进日志。
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`环境变量配置有误：\n${problems.join('\n')}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    ownerDatabaseUrl: env.DATABASE_URL,
    appDatabaseUrl: deriveAppDatabaseUrl(env.DATABASE_URL, env.APP_DATABASE_PASSWORD),
    appDatabasePassword: env.APP_DATABASE_PASSWORD,
    workbenchDist: env.WORKBENCH_DIST,
    adminDist: env.ADMIN_DIST,
    secureCookies: env.NODE_ENV === 'production',
    platformAdmin:
      env.PLATFORM_ADMIN_EMAIL && env.PLATFORM_ADMIN_PASSWORD
        ? { email: env.PLATFORM_ADMIN_EMAIL, password: env.PLATFORM_ADMIN_PASSWORD }
        : undefined,
    llm: loadGatewayConfig(source),
    ...storageConfig(env),
    redisUrl: env.REDIS_URL,
    expertsPreview: env.EXPERTS_PREVIEW === 'true',
    planLibraryPreview: env.PLAN_LIBRARY_PREVIEW === 'true',
  };
}

const REQUIRED_STORAGE_VARS = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

function storageConfig(env: Env): Pick<AppConfig, 'storage' | 'incompleteStorageVars'> {
  const missing = REQUIRED_STORAGE_VARS.filter((name) => !env[name]);
  if (missing.length === REQUIRED_STORAGE_VARS.length) {
    return { storage: undefined, incompleteStorageVars: [] };
  }
  if (missing.length || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    return { storage: undefined, incompleteStorageVars: [...missing] };
  }
  return {
    storage: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    },
    incompleteStorageVars: [],
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
