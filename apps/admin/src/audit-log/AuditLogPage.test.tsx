import type { AuditLogEntry } from '@health-buddy/shared';
import { render, screen, within } from '@testing-library/react';
import { App } from '../App';
import { json, makeThresholds, mockApi, USERS } from '../test/mockApi';

const ENTRY: AuditLogEntry = {
  id: '1',
  operatorId: '33333333-3333-4333-8333-333333333333',
  actorId: '11111111-1111-4111-8111-111111111111',
  actorRole: 'platform_admin',
  objectType: 'operator',
  objectId: '33333333-3333-4333-8333-333333333333',
  action: 'updated',
  before: { seat_limit: 10 },
  after: { seat_limit: 20 },
  createdAt: '2026-10-31T03:00:00.000Z',
};

describe('操作记录（M7 规格 2.7）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('协会管理员看到本协会的记录：动作、改动，能导出 CSV', async () => {
    window.location.hash = '#audit-log';
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const path = `/admin/audit-log?from=${from}&to=${today}`;
    const api = mockApi(USERS.operator_admin, {
      'GET /critical-thresholds': () => json(200, { thresholds: makeThresholds() }),
      [`GET ${path}`]: () => json(200, { entries: [ENTRY], truncated: false }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: '操作记录' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('本协会');
    const row = (await screen.findByRole('rowheader', { name: '修改' })).closest('tr')!;
    expect(within(row).getByText('平台管理员')).toBeInTheDocument();
    expect(row).toHaveTextContent('席位数：20');
    expect(screen.getByRole('link', { name: /导出 CSV/ })).toHaveAttribute(
      'href',
      `/api/admin/audit-log/export?from=${from}&to=${today}`,
    );
    expect(api.callsTo('GET', path)).toHaveLength(1);
  });
});
