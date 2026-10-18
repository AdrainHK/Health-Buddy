import { describe, expect, it } from 'vitest';
import { requireExpertViewer, requireManager } from './manager-only.js';

describe('role guards', () => {
  it('denies the client role (and any unknown role) on expert endpoints with 404', () => {
    for (const role of ['client', 'guest', '']) {
      expect(() => requireExpertViewer({ role } as never)).toThrow();
    }
    for (const role of ['manager', 'org_admin', 'operator_admin', 'platform_admin']) {
      expect(() => requireExpertViewer({ role } as never)).not.toThrow();
    }
  });

  it('keeps the workbench manager-only', () => {
    expect(() => requireManager({ role: 'client' } as never)).toThrow();
    expect(() => requireManager({ role: 'org_admin' } as never)).toThrow();
  });
});
