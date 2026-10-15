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
  /** 首次部署时创建平台管理员；已有平台管理员时忽略。 */
  PLATFORM_ADMIN_EMAIL: z.email().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  ownerDatabaseUrl: string;
  appDatabaseUrl: string;
  appDatabasePassword: string;
  workbenchDist: string | undefined;
  secureCookies: boolean;
  platformAdmin: { email: string; password: string } | undefined;
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
    secureCookies: env.NODE_ENV === 'production',
    platformAdmin:
      env.PLATFORM_ADMIN_EMAIL && env.PLATFORM_ADMIN_PASSWORD
        ? { email: env.PLATFORM_ADMIN_EMAIL, password: env.PLATFORM_ADMIN_PASSWORD }
        : undefined,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
