import { describe, expect, it } from 'vitest';
import {
  approveArtifactRequestSchema,
  createCriticalThresholdRequestSchema,
  sendMessageRequestSchema,
  taskStreamEventSchema,
  updateCriticalThresholdRequestSchema,
  updateTaskRequestSchema,
} from './index.js';

const uuid = '0b9b8f3e-7a51-4c8e-9a43-1f0e0f2c6d11';
const other = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

describe('sendMessageRequestSchema', () => {
  it('accepts a craft message with a skill and one client', () => {
    const r = sendMessageRequestSchema.safeParse({
      mode: 'craft',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
      clientRefs: [uuid],
    });
    expect(r.success).toBe(true);
  });

  it('defaults clientRefs to an empty list', () => {
    const r = sendMessageRequestSchema.parse({ mode: 'ask', content: '你好' });
    expect(r.clientRefs).toEqual([]);
  });

  it('rejects a skill in ask mode', () => {
    const r = sendMessageRequestSchema.safeParse({ mode: 'ask', content: 'x', skillId: 's' });
    expect(r.success).toBe(false);
  });

  it('rejects more than one client, blank or oversized content', () => {
    expect(
      sendMessageRequestSchema.safeParse({ mode: 'craft', content: 'x', clientRefs: [uuid, other] })
        .success,
    ).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ mode: 'craft', content: '   ' }).success).toBe(
      false,
    );
    expect(
      sendMessageRequestSchema.safeParse({ mode: 'craft', content: 'a'.repeat(4001) }).success,
    ).toBe(false);
  });
});

describe('updateTaskRequestSchema', () => {
  it('requires at least one field', () => {
    expect(updateTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ archived: true }).success).toBe(true);
  });
});

describe('approveArtifactRequestSchema', () => {
  it('requires a version and defaults the acknowledgement to false', () => {
    expect(approveArtifactRequestSchema.safeParse({}).success).toBe(false);
    expect(approveArtifactRequestSchema.parse({ version: 2 }).acknowledgedCritical).toBe(false);
  });
});

describe('taskStreamEventSchema', () => {
  it('only allows known error kinds, never free text', () => {
    expect(taskStreamEventSchema.safeParse({ type: 'error', kind: 'timeout' }).success).toBe(true);
    expect(
      taskStreamEventSchema.safeParse({ type: 'error', kind: 'Incorrect API key provided' })
        .success,
    ).toBe(false);
  });
});

describe('critical threshold requests', () => {
  const rule = { metric: 'sbp', comparator: 'gte', value: 180, level: 'urgent', enabled: true };

  it('accepts a rule inside the bounds', () => {
    expect(createCriticalThresholdRequestSchema.safeParse(rule).success).toBe(true);
  });

  it('rejects an obvious typo, an unknown metric and an unknown level', () => {
    expect(createCriticalThresholdRequestSchema.safeParse({ ...rule, value: 1800 }).success).toBe(
      false,
    );
    expect(
      createCriticalThresholdRequestSchema.safeParse({ ...rule, metric: 'mood' }).success,
    ).toBe(false);
    expect(createCriticalThresholdRequestSchema.safeParse({ ...rule, level: 'red' }).success).toBe(
      false,
    );
  });

  it('requires something to update', () => {
    expect(updateCriticalThresholdRequestSchema.safeParse({}).success).toBe(false);
    expect(updateCriticalThresholdRequestSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});
