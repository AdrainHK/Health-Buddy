import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './pricing.js';

describe('estimateCostUsd', () => {
  it('prices the GPT-6 models per million tokens', () => {
    expect(estimateCostUsd('gpt-6-astra', 1_000_000, 1_000_000)).toBe(60);
    expect(estimateCostUsd('gpt-6.1-sol', 1_000_000, 1_000_000)).toBe(12);
    expect(estimateCostUsd('gpt-6-luna', 1_000_000, 1_000_000)).toBe(0.6);
  });

  it('prices a dated snapshot like its base model', () => {
    expect(estimateCostUsd('gpt-6-astra-2026-09-01', 1000, 1000)).toBe(
      estimateCostUsd('gpt-6-astra', 1000, 1000),
    );
  });

  it('returns null for an unknown model', () => {
    expect(estimateCostUsd('some-new-model', 1000, 1000)).toBeNull();
  });
});
