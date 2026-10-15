import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const LLM_SDK_PATTERNS = [
  {
    group: ['openai', 'openai/*', '@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
    message: '大模型调用必须经过 @health-buddy/ai-engine 网关。',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: [
      'apps/workbench/**/*.{ts,tsx}',
      'apps/admin/**/*.{ts,tsx}',
      'packages/ui/**/*.{ts,tsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // 业务代码不直接调用厂商 SDK，一律经过 packages/ai-engine 的大模型网关。
    files: ['apps/**/*.{ts,tsx}', 'packages/!(ai-engine)/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: LLM_SDK_PATTERNS,
        },
      ],
    },
  },
  {
    // 红线 1：业务代码只能经过带租户上下文的仓储层访问数据库。
    // 原始 SQL 和 pg 驱动只允许出现在 db 目录和 auth.repository.ts（调用登录函数）里。
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/db/**', 'apps/server/src/auth/auth.repository.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'kysely',
              importNames: ['sql'],
              message: '业务代码用 Kysely 查询构造器并经过 withTenant，不写原始 SQL。',
            },
            { name: 'pg', message: '只能在 db 目录里直接使用数据库驱动。' },
          ],
          // 同一条规则后面的配置会覆盖前面的，所以这里重复一遍厂商 SDK 的限制
          patterns: LLM_SDK_PATTERNS,
        },
      ],
    },
  },
  {
    // 租户上下文只能由 withTenant 根据已验证的会话设置，其他地方出现 set_config 一律报错。
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/db/database.ts', 'apps/server/src/db/migrations/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/set_config/i], Literal[value=/set_config/i]',
          message: '租户上下文只能在 db/database.ts 的 withTenant 里设置。',
        },
      ],
    },
  },
);
