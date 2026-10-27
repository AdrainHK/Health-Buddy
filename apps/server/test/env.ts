import { loadGatewayConfig } from '@health-buddy/ai-engine';
import { deriveAppDatabaseUrl, type AppConfig } from '../src/config.js';

/** 测试库连接串（所有者）。CI 和本地都用一个专门的测试库，每次运行前重建。 */
export const TEST_OWNER_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/hb_test';

/** 测试专用的应用角色密码，不是任何环境的真实密钥。 */
export const TEST_APP_PASSWORD = 'test-only-app-password-0000';

export const TEST_APP_URL = deriveAppDatabaseUrl(TEST_OWNER_URL, TEST_APP_PASSWORD);

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    port: 0,
    ownerDatabaseUrl: TEST_OWNER_URL,
    appDatabaseUrl: TEST_APP_URL,
    appDatabasePassword: TEST_APP_PASSWORD,
    workbenchDist: undefined,
    adminDist: undefined,
    secureCookies: false,
    platformAdmin: undefined,
    // 测试里不配置任何密钥，大模型调用一律用模拟厂商
    llm: loadGatewayConfig({}),
    // 测试默认不配置对象存储和 Redis；报告上传的测试用内存实现替换
    storage: undefined,
    redisUrl: undefined,
    incompleteStorageVars: [],
    // 专家默认按正式环境处理（关闭预览）；专家相关的测试单独打开
    expertsPreview: false,
    planLibraryPreview: false,
    // 测试专用的素材加密密钥，不是任何环境的真实密钥
    visitMaterialKey: Buffer.alloc(32, 7),
    ...overrides,
  };
}
