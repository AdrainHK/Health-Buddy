import type { SkillSummary, TaskStreamEvent } from '@health-buddy/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPane, type ComposerPrefill } from '../shell/ChatPane';
import { careIds, makeVisit } from '../test/careFixtures';
import {
  CLIENTS,
  NOW,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeTask,
  mockApi,
  setWideViewport,
  sseResponse,
} from '../test/mockApi';
import { makeTwin } from '../test/twinFixtures';

/** /随访话术、/随访记录在对话区（M5 规格 2.8、2.9）：勾选素材、关联随访。全部是合成数据 */

const A = ids.clientA;
const TASK = makeTask({ clientId: A });
const MSG_PATH = `/tasks/${ids.task}/messages`;
const MATERIAL_ID = 'a7000000-0000-4000-8000-000000000001';
const done: TaskStreamEvent = { type: 'done', messageId: ids.assistantMsg, reason: 'complete' };
const RECORD_SKILL: SkillSummary = {
  ...SKILL,
  id: 'visit-record',
  modes: ['craft'],
  clientFacing: false,
  allowsEmptyRequest: true,
  usesMaterials: true,
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => setWideViewport());

function routes(post: () => Response) {
  return mockApi({
    [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(TASK)),
    [`GET /clients/${A}/reports`]: () => json(200, { reports: [] }),
    [`GET /clients/${A}/report-uploads`]: () => json(200, { uploads: [] }),
    [`GET /clients/${A}/twin`]: () => json(200, makeTwin()),
    [`GET /clients/${A}/visit-materials`]: () =>
      json(200, {
        consentRecorded: true,
        materials: [
          {
            id: MATERIAL_ID,
            clientId: A,
            visitId: null,
            kind: 'paste',
            charCount: 12,
            consumedArtifactId: null,
            purgeAfter: NOW,
            purged: false,
            createdAt: '2026-10-15T08:00:00.000Z',
          },
        ],
      }),
    [`GET /visits?clientId=${A}`]: () => json(200, { visits: [makeVisit()] }),
    [`POST ${MSG_PATH}`]: post,
  });
}

const prefill: ComposerPrefill = {
  key: 1,
  taskId: ids.task,
  mode: 'craft',
  skillId: 'visit-record',
  visitId: careIds.visit1,
};

function renderPane() {
  return render(
    <ChatPane
      narrow={false}
      onOpenMenu={() => {}}
      resultsOpen
      onToggleResults={() => {}}
      task={TASK}
      skills={[SKILL, RECORD_SKILL]}
      clients={CLIENTS}
      prefill={prefill}
    />,
  );
}

describe('/随访记录在对话区', () => {
  it('“记录随访”预先选好技能和随访；勾选素材后发送带 materialRefs 和 visitId', async () => {
    const api = routes(() => sseResponse([done]));
    const user = userEvent.setup();
    renderPane();
    await user.click(await screen.findByRole('checkbox', { name: '整理这份（2026-10-15）' }));
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toMatchObject({
      mode: 'craft',
      skillId: 'visit-record',
      materialRefs: [MATERIAL_ID],
      visitId: careIds.visit1,
    });
  });

  it('没有勾选素材（409 no_materials）：提示先上传并勾选', async () => {
    routes(() => json(409, { error: 'conflict', reasons: ['no_materials'] }));
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('checkbox', { name: '整理这份（2026-10-15）' });
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请先上传随访素材');
  });
});
