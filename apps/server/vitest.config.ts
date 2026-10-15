import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest 依赖装饰器元数据做依赖注入，esbuild 不生成，所以测试用 swc 编译。
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    // 集成测试共用一个测试库，按文件串行执行，避免互相干扰。
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
