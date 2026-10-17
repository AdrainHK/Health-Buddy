import { defineConfig } from '@playwright/test';

/**
 * 工作台端到端测试（pnpm e2e）。接口在浏览器里用 page.route 模拟，不需要后端和数据库；
 * 只用合成数据。目前覆盖 M2 验收标准 25：手机宽度下档案和核对界面不横向滚动。
 */
const PORT = 4317;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
  },
  projects: [
    {
      // 规格 2.1：手机宽度（375px）
      name: 'mobile-375',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
