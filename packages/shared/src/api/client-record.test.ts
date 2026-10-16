import { describe, expect, it } from 'vitest';
import {
  createClientRequestSchema,
  createHealthHistoryItemRequestSchema,
  setRiskTierRequestSchema,
  updateClientRequestSchema,
  updateHealthHistoryItemRequestSchema,
} from './index.js';

describe('createClientRequestSchema', () => {
  it('accepts a name, gender and birth year, and trims the name', () => {
    const r = createClientRequestSchema.parse({
      displayName: '  合成客户  ',
      gender: 'female',
      birthYear: 1970,
    });
    expect(r).toEqual({ displayName: '合成客户', gender: 'female', birthYear: 1970 });
  });

  it('drops tenant fields and contact fields instead of accepting them', () => {
    const r = createClientRequestSchema.parse({
      displayName: '合成客户',
      operatorId: '0b9b8f3e-7a51-4c8e-9a43-1f0e0f2c6d11',
      managerId: '0b9b8f3e-7a51-4c8e-9a43-1f0e0f2c6d11',
      phone: '00000000000',
    });
    expect(r).toEqual({ displayName: '合成客户' });
  });

  it('rejects a blank or oversized name, unknown gender and impossible birth years', () => {
    const nextYear = new Date().getFullYear() + 1;
    for (const body of [
      { displayName: '   ' },
      { displayName: 'x'.repeat(51) },
      { displayName: 'x', gender: 'unknown' },
      { displayName: 'x', birthYear: 1899 },
      { displayName: 'x', birthYear: nextYear },
      { displayName: 'x', birthYear: 1970.5 },
    ]) {
      expect(createClientRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('updateClientRequestSchema', () => {
  it('needs at least one field and allows clearing gender and birth year', () => {
    expect(updateClientRequestSchema.safeParse({}).success).toBe(false);
    expect(updateClientRequestSchema.parse({ gender: null, birthYear: null })).toEqual({
      gender: null,
      birthYear: null,
    });
  });
});

describe('health history requests', () => {
  it('accepts the five categories only', () => {
    for (const category of [
      'past_history',
      'family_history',
      'medication',
      'allergy',
      'lifestyle',
    ]) {
      expect(
        createHealthHistoryItemRequestSchema.safeParse({ category, content: '合成记录' }).success,
      ).toBe(true);
    }
    expect(
      createHealthHistoryItemRequestSchema.safeParse({ category: 'diagnosis', content: 'x' })
        .success,
    ).toBe(false);
  });

  it('rejects blank or oversized content and malformed dates', () => {
    for (const body of [
      { category: 'allergy', content: ' ' },
      { category: 'allergy', content: 'x'.repeat(501) },
      { category: 'allergy', content: 'x', recordedOn: '2026/01/01' },
    ]) {
      expect(createHealthHistoryItemRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(updateHealthHistoryItemRequestSchema.safeParse({}).success).toBe(false);
    expect(updateHealthHistoryItemRequestSchema.parse({ recordedOn: null })).toEqual({
      recordedOn: null,
    });
  });
});

describe('setRiskTierRequestSchema', () => {
  it('requires a tier and a non-blank reason', () => {
    expect(setRiskTierRequestSchema.safeParse({ tier: 'high', reason: '合成理由' }).success).toBe(
      true,
    );
    expect(setRiskTierRequestSchema.safeParse({ tier: 'high' }).success).toBe(false);
    expect(setRiskTierRequestSchema.safeParse({ tier: 'high', reason: '  ' }).success).toBe(false);
    expect(setRiskTierRequestSchema.safeParse({ tier: 'none', reason: 'x' }).success).toBe(false);
    expect(
      setRiskTierRequestSchema.safeParse({ tier: 'low', reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});
