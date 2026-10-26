import { findBannedTerms } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import { EXPORT_SUMMARIES } from './artifacts.repository.js';

describe('导出文件名里的内容概括', () => {
  it('不含禁用词', () => {
    for (const summary of Object.values(EXPORT_SUMMARIES)) {
      expect(findBannedTerms(summary)).toEqual([]);
    }
  });
});
