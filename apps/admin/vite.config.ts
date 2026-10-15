import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 后台和工作台由同一个后端提供：工作台在 /，后台在 /admin/。
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5174,
    // 开发时把接口转给本地后端。保持 Host 不变，后端的同源检查才能通过。
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
});
