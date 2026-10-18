import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import './src/i18n';

// 工作台把当前任务和产物记在地址栏（刷新后恢复）；每个用例从干净的地址开始
afterEach(() => {
  window.history.replaceState(null, '', '/');
});
