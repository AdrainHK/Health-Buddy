import type { TaskStreamEvent } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPane } from '../shell/ChatPane';
import { EXERCISE, RECIPE } from '../test/careFixtures';
import {
  CLIENTS,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeTask,
  mockApi,
  setWideViewport,
  sseResponse,
} from '../test/mockApi';

/** @方案库条目（M5 规格 2.11）：只在问一问里列出，第一次打开 @ 列表时才读取。全部是合成数据 */

const TASK = makeTask();
const MSG_PATH = `/tasks/${ids.task}/messages`;
const done: TaskStreamEvent = { type: 'done', messageId: ids.assistantMsg, reason: 'complete' };

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => setWideViewport());

function routes() {
  return mockApi({
    [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(TASK)),
    'GET /plan-library/recipes': () => json(200, { items: [RECIPE] }),
    'GET /plan-library/exercises': () => json(200, { items: [EXERCISE] }),
    [`POST ${MSG_PATH}`]: () => sseResponse([done]),
  });
}

function renderPane() {
  return render(
    <ChatPane
      narrow={false}
      onOpenMenu={() => {}}
      resultsOpen
      onToggleResults={() => {}}
      task={TASK}
      skills={[SKILL]}
      clients={CLIENTS}
    />,
  );
}

describe('@方案库条目', () => {
  it('问一问里 @ 列表有“方案库”组；选中后发送带 libraryRefs；列表只读一次', async () => {
    const api = routes();
    const user = userEvent.setup();
    renderPane();
    const box = await screen.findByRole('textbox');
    await user.click(screen.getByRole('radio', { name: '问一问' }));
    expect(api.callsTo('GET', '/plan-library/recipes')).toHaveLength(0);
    await user.type(box, '@合成');
    const list = screen.getByRole('listbox');
    expect(await within(list).findByText('方案库')).toBeInTheDocument();
    expect(
      within(list).getByRole('option', { name: /合成燕麦粥.*食谱 · 早餐/ }),
    ).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: /合成快走.*运动 · 有氧/ }));
    expect(screen.getByRole('button', { name: '移除方案库条目 合成快走' })).toBeInTheDocument();
    await user.type(box, '@');
    await user.keyboard('{Escape}');
    await user.type(box, '适合这位客户吗');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toMatchObject({
      mode: 'ask',
      libraryRefs: [{ type: 'exercise', id: EXERCISE.id }],
    });
    expect(api.callsTo('GET', '/plan-library/recipes')).toHaveLength(1);
  });

  it('切到做一做时提示切回问一问，不发送', async () => {
    const api = routes();
    const user = userEvent.setup();
    renderPane();
    const box = await screen.findByRole('textbox');
    await user.click(screen.getByRole('radio', { name: '问一问' }));
    await user.type(box, '@合成燕麦');
    await user.click(await screen.findByRole('option', { name: /合成燕麦粥/ }));
    await user.click(screen.getByRole('radio', { name: '做一做' }));
    expect(screen.getByRole('alert')).toHaveTextContent('@方案库条目 需要在问一问模式下使用');
    await user.type(box, '怎么样');
    await user.keyboard('{Enter}');
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(0);
  });
});
