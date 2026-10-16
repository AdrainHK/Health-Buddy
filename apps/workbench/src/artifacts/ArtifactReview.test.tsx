import type { ArtifactDetailResponse, CriticalFlag, Task } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultsPanel, type ResultsPanelProps } from '../shell/ResultsPanel';
import {
  NOW,
  SYNTHETIC_DISCLAIMER,
  emptyDetail,
  ids,
  json,
  makeArtifactDetail,
  makeArtifactSummary,
  makeTask,
  mockApi,
  sseResponse,
} from '../test/mockApi';

/** 产物预览和审核栏。只用合成数据。 */

const TASK_PATH = `/tasks/${ids.task}`;
const ART_PATH = `/artifacts/${ids.artifact}`;

const CRITICAL: CriticalFlag = {
  metric: 'sbp',
  value: 185,
  unit: 'mmHg',
  observedOn: '2026-10-10',
  source: 'monitoring',
  rule: { comparator: 'gte', value: 180, level: 'urgent' },
};

function taskDetail(detail: ArtifactDetailResponse, task: Task = makeTask()) {
  const { id, taskId, skillId, version, status, hasCriticalFlags, createdAt } = detail.artifact;
  return {
    ...emptyDetail(task),
    artifacts: [{ id, taskId, skillId, version, status, hasCriticalFlags, createdAt }],
  };
}

function renderPanel(props: Partial<ResultsPanelProps> = {}) {
  const all: ResultsPanelProps = {
    mode: 'docked',
    open: true,
    onClose: () => {},
    task: makeTask(),
    refreshKey: `${ids.task}:0`,
    ...props,
  };
  const view = render(<ResultsPanel {...all} />);
  return {
    ...view,
    rerenderWith: (next: Partial<ResultsPanelProps>) =>
      view.rerender(<ResultsPanel {...all} {...next} />),
  };
}

/** 渲染结果区，点开列表里的第 1 版 */
async function openArtifact(
  user: ReturnType<typeof userEvent.setup>,
  props: Partial<ResultsPanelProps> = {},
) {
  const view = renderPanel(props);
  await user.click(await screen.findByRole('button', { name: /第 1 版/ }));
  await screen.findByRole('heading', { name: /第 1 版/ });
  return view;
}

const reviewBar = () => screen.getByRole('region', { name: '审核' });
const button = (name: string | RegExp) => within(reviewBar()).getByRole('button', { name });
const queryButton = (name: string | RegExp) => within(reviewBar()).queryByRole('button', { name });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('artifact list', () => {
  it('lists every version of the task with its status and opens the preview', async () => {
    const draft = makeArtifactDetail({ id: ids.artifact2, version: 2, createdAt: NOW });
    mockApi({
      [`GET ${TASK_PATH}`]: () =>
        json(200, {
          ...emptyDetail(),
          artifacts: [
            makeArtifactSummary({
              status: 'returned',
              createdAt: '2026-10-15T07:00:00.000Z',
            }),
            makeArtifactSummary({ id: ids.artifact2, version: 2, hasCriticalFlags: true }),
          ],
        }),
      [`GET /artifacts/${ids.artifact2}`]: () => json(200, draft),
    });
    const user = userEvent.setup();
    renderPanel();

    const list = await screen.findByRole('list', { name: '本任务的产物' });
    const items = within(list).getAllByRole('button');
    expect(items[0]).toHaveTextContent('客户近况小结 · 第 2 版');
    expect(items[0]).toHaveTextContent('草稿');
    expect(items[0]).toHaveTextContent('含危急指标');
    expect(items[1]).toHaveTextContent('第 1 版');
    expect(items[1]).toHaveTextContent('已退回');

    await user.click(items[0]!);
    expect(await screen.findByRole('heading', { name: /第 2 版/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '通俗版内容' })).toHaveValue(
      draft.artifact.content.clientFacing,
    );
    await user.click(screen.getByRole('tab', { name: '专业版' }));
    expect(screen.getByText('合成专业版')).toBeInTheDocument();
  });

  it('opens the newest artifact when a draft is generated in the same task', async () => {
    let artifacts = [makeArtifactSummary({ status: 'returned' })];
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, { ...emptyDetail(), artifacts }),
      [`GET /artifacts/${ids.artifact2}`]: () =>
        json(200, makeArtifactDetail({ id: ids.artifact2, version: 2 })),
    });
    const view = renderPanel();
    await screen.findByRole('button', { name: /第 1 版/ });

    artifacts = [
      ...artifacts,
      makeArtifactSummary({ id: ids.artifact2, version: 2, createdAt: '2026-10-15T09:00:00.000Z' }),
    ];
    view.rerenderWith({ refreshKey: `${ids.task}:1` });
    expect(await screen.findByRole('heading', { name: /第 2 版/ })).toBeInTheDocument();
  });

  it('does not switch away from unsaved edits when a newer artifact is generated', async () => {
    let artifacts = [makeArtifactSummary()];
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, { ...emptyDetail(), artifacts }),
      [`GET ${ART_PATH}`]: () => json(200, makeArtifactDetail()),
      [`GET /artifacts/${ids.artifact2}`]: () =>
        json(200, makeArtifactDetail({ id: ids.artifact2, version: 2 })),
    });
    const user = userEvent.setup();
    const view = await openArtifact(user);
    const editor = screen.getByRole('textbox', { name: '通俗版内容' });
    await user.type(editor, '补充一句');

    artifacts = [
      ...artifacts,
      makeArtifactSummary({ id: ids.artifact2, version: 2, createdAt: '2026-10-15T09:00:00.000Z' }),
    ];
    view.rerenderWith({ refreshKey: `${ids.task}:1` });
    const notice = await within(reviewBar()).findByText(/已生成新的版本/);
    expect(notice.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: /第 1 版/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '通俗版内容' })).toHaveValue(
      makeArtifactDetail().artifact.content.clientFacing + '补充一句',
    );

    await user.click(button('打开新版本'));
    expect(await screen.findByRole('heading', { name: /第 2 版/ })).toBeInTheDocument();
  });
});

describe('review bar on a draft', () => {
  it('keeps approve disabled until the critical values are acknowledged', async () => {
    const detail = makeArtifactDetail({ hasCriticalFlags: true, criticalFlags: [CRITICAL] });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`POST ${ART_PATH}/approve`]: () =>
        json(200, makeArtifactDetail({ ...detail.artifact, status: 'approved' })),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    const critical = within(reviewBar()).getByRole('group', { name: '危急指标' });
    expect(critical).toHaveTextContent('收缩压 185 mmHg');
    expect(critical).toHaveTextContent('需尽快就医');
    expect(button('确认')).toBeDisabled();
    expect(reviewBar()).toHaveTextContent('请先勾选“已知悉”危急指标');

    // 危急指标只在审核栏，不出现在通俗版里
    expect(screen.getByRole('tabpanel', { name: '通俗版' })).not.toHaveTextContent('185');

    await user.click(within(critical).getByRole('checkbox', { name: /已知悉/ }));
    expect(button('确认')).toBeEnabled();
    await user.click(button('确认'));

    await waitFor(() => expect(api.callsTo('POST', `${ART_PATH}/approve`)).toHaveLength(1));
    expect(api.callsTo('POST', `${ART_PATH}/approve`)[0]?.body).toEqual({
      version: 1,
      contentHash: 'hash-1',
      acknowledgedCritical: true,
    });
    expect(await screen.findByRole('button', { name: '复制通俗版' })).toBeInTheDocument();
  });

  it('disables approve and marks banned terms in the client text', async () => {
    const clientFacing = `合成通俗版：坚持锻炼可以根治。\n\n${SYNTHETIC_DISCLAIMER}`;
    const detail = makeArtifactDetail({
      content: { professional: '合成专业版', clientFacing },
    });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(button('确认')).toBeDisabled();
    expect(reviewBar()).toHaveTextContent('通俗版含禁用词');
    const marks = screen.getByRole('list', { name: '需要注意的位置' });
    expect(marks).toHaveTextContent('禁用词“根治”');
    expect(within(marks).getByText('根治', { selector: 'mark' })).toHaveAttribute(
      'data-kind',
      'banned',
    );

    // 中间插空格也能查出来；改掉之后，保存前仍不能确认
    const editor = screen.getByRole('textbox', { name: '通俗版内容' });
    await user.clear(editor);
    await user.type(editor, `合成通俗版：可以筛 查。${SYNTHETIC_DISCLAIMER}`);
    expect(screen.getByRole('list', { name: '需要注意的位置' })).toHaveTextContent('禁用词“筛查”');
    expect(button('确认')).toBeDisabled();

    await user.clear(editor);
    await user.type(editor, `合成通俗版：继续保持。${SYNTHETIC_DISCLAIMER}`);
    expect(screen.queryByRole('list', { name: '需要注意的位置' })).not.toBeInTheDocument();
    expect(button('确认')).toBeDisabled();
    expect(reviewBar()).toHaveTextContent('有未保存的修改，保存后才能确认');
    expect(api.callsTo('POST', `${ART_PATH}/approve`)).toHaveLength(0);
  });

  it('shows every reason of a 409 rejection and marks the critical value', async () => {
    const clientFacing = `合成通俗版：最近一次收缩压 185，请注意休息。`;
    const detail = makeArtifactDetail({
      content: { professional: '合成专业版', clientFacing },
      hasCriticalFlags: false,
    });
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`POST ${ART_PATH}/approve`]: () =>
        json(409, {
          error: 'conflict',
          reasons: ['missing_disclaimer', 'critical_value_in_client_text'],
          criticalValueMentions: [{ metric: 'sbp', index: clientFacing.indexOf('185') }],
        }),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    await user.click(button('确认'));
    const alert = await within(reviewBar()).findByRole('alert');
    expect(alert).toHaveTextContent('无法确认');
    const reasons = within(alert).getAllByRole('listitem');
    expect(reasons.map((li) => li.textContent)).toEqual([
      '通俗版缺少免责声明',
      '通俗版里出现了危急指标的数值，请删去标出的位置',
    ]);
    const marks = screen.getByRole('list', { name: '需要注意的位置' });
    expect(marks).toHaveTextContent('危急指标数值（收缩压）');
    expect(within(marks).getByText('185', { selector: 'mark' })).toHaveAttribute(
      'data-kind',
      'critical',
    );
  });

  it('reloads and tells the user when the version or content hash is stale', async () => {
    let loads = 0;
    const fresh = makeArtifactDetail({
      contentHash: 'hash-2',
      content: {
        professional: '合成专业版',
        clientFacing: `合成通俗版：另一个窗口改过的内容。\n\n${SYNTHETIC_DISCLAIMER}`,
      },
    });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(fresh)),
      [`GET ${ART_PATH}`]: () => json(200, loads++ === 0 ? makeArtifactDetail() : fresh),
      [`PATCH ${ART_PATH}`]: () => json(409, { error: 'conflict', reasons: ['not_latest_draft'] }),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    const editor = screen.getByRole('textbox', { name: '通俗版内容' });
    await user.type(editor, '补充一句');
    await user.click(button('保存修改'));

    // 本地有未保存的修改：重新加载后不覆盖，提示有更新的内容，由健管师选择
    const newer = await within(reviewBar()).findByText(/这份草稿已在别处更新/);
    expect(newer.closest('[role="alert"]')).not.toBeNull();
    expect(api.callsTo('PATCH', ART_PATH)[0]?.body).toMatchObject({
      version: 1,
      contentHash: 'hash-1',
    });
    expect(api.callsTo('GET', ART_PATH).length).toBeGreaterThanOrEqual(2);
    const local = makeArtifactDetail().artifact.content.clientFacing + '补充一句';
    expect(screen.getByRole('textbox', { name: '通俗版内容' })).toHaveValue(local);
    expect(button('保存修改')).toBeDisabled();
    expect(button('确认')).toBeDisabled();

    await user.click(button('载入最新内容'));
    expect(screen.getByRole('textbox', { name: '通俗版内容' })).toHaveValue(
      fresh.artifact.content.clientFacing,
    );
    expect(within(reviewBar()).queryByText(/这份草稿已在别处更新/)).not.toBeInTheDocument();
  });

  it('reloads silently when there are no local edits', async () => {
    let loads = 0;
    const fresh = makeArtifactDetail({
      contentHash: 'hash-2',
      content: {
        professional: '合成专业版',
        clientFacing: `合成通俗版：另一个窗口改过的内容。\n\n${SYNTHETIC_DISCLAIMER}`,
      },
    });
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(fresh)),
      [`GET ${ART_PATH}`]: () => json(200, loads++ === 0 ? makeArtifactDetail() : fresh),
      [`POST ${ART_PATH}/approve`]: () =>
        json(409, { error: 'conflict', reasons: ['not_latest_draft'] }),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    await user.click(button('确认'));
    expect(await within(reviewBar()).findByRole('status')).toHaveTextContent(
      '内容已在别处修改，已刷新',
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '通俗版内容' })).toHaveValue(
        fresh.artifact.content.clientFacing,
      ),
    );
    expect(within(reviewBar()).queryByText(/这份草稿已在别处更新/)).not.toBeInTheDocument();
  });

  it('keeps local edits on request and saves them against the newer version', async () => {
    let loads = 0;
    const fresh = makeArtifactDetail({
      contentHash: 'hash-2',
      content: {
        professional: '合成专业版',
        clientFacing: `合成通俗版：另一个窗口改过的内容。\n\n${SYNTHETIC_DISCLAIMER}`,
      },
    });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(fresh)),
      [`GET ${ART_PATH}`]: () => json(200, loads++ === 0 ? makeArtifactDetail() : fresh),
      [`PATCH ${ART_PATH}`]: (call) => {
        const body = call.body as { contentHash: string; content: { clientFacing: string } };
        if (body.contentHash !== 'hash-2') {
          return json(409, { error: 'conflict', reasons: ['not_latest_draft'] });
        }
        return json(
          200,
          makeArtifactDetail({
            contentHash: 'hash-3',
            content: { professional: '合成专业版', clientFacing: body.content.clientFacing },
          }),
        );
      },
    });
    const user = userEvent.setup();
    await openArtifact(user);

    await user.type(screen.getByRole('textbox', { name: '通俗版内容' }), '补充一句');
    await user.click(button('保存修改'));
    await within(reviewBar()).findByText(/这份草稿已在别处更新/);

    await user.click(button('保留我的修改'));
    expect(button('保存修改')).toBeEnabled();
    await user.click(button('保存修改'));
    expect(await within(reviewBar()).findByRole('status')).toHaveTextContent('已保存');
    const patches = api.callsTo('PATCH', ART_PATH);
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).toMatchObject({ contentHash: 'hash-2' });
    expect(screen.getByRole('textbox', { name: '通俗版内容' })).toHaveValue(
      makeArtifactDetail().artifact.content.clientFacing + '补充一句',
    );
    expect(within(reviewBar()).queryByText(/这份草稿已在别处更新/)).not.toBeInTheDocument();
  });

  it('marks critical values from the detail hints as soon as the draft opens', async () => {
    const clientFacing = `合成通俗版：最近一次收缩压 185，请注意休息。\n\n${SYNTHETIC_DISCLAIMER}`;
    const detail = makeArtifactDetail(
      {
        content: { professional: '合成专业版', clientFacing },
        criticalFlags: [CRITICAL],
        hasCriticalFlags: true,
      },
      {
        hints: {
          judgementHints: [],
          criticalValueMentions: [{ metric: 'sbp', index: clientFacing.indexOf('185') }],
          riskTierMentions: [],
        },
      },
    );
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(screen.getByText(/通俗版里出现了危急指标的数值（已标出）/)).toHaveAttribute(
      'role',
      'alert',
    );
    const marks = screen.getByRole('list', { name: '需要注意的位置' });
    expect(marks).toHaveTextContent('危急指标数值（收缩压）');
    expect(within(marks).getByText('185', { selector: 'mark' })).toHaveAttribute(
      'data-kind',
      'critical',
    );
    // 勾选“已知悉”也不能确认：数值要先删掉
    await user.click(screen.getByRole('checkbox', { name: /已知悉/ }));
    expect(button('确认')).toBeDisabled();
    expect(reviewBar()).toHaveTextContent('通俗版含危急指标数值，删去并保存后才能确认');
    expect(api.callsTo('POST', `${ART_PATH}/approve`)).toHaveLength(0);

    // 删掉数值后标记消失
    const editor = screen.getByRole('textbox', { name: '通俗版内容' });
    await user.clear(editor);
    await user.type(editor, `合成通俗版：最近血压偏高，请注意休息。\n\n${SYNTHETIC_DISCLAIMER}`);
    expect(screen.queryByText(/通俗版里出现了危急指标的数值（已标出）/)).not.toBeInTheDocument();
  });

  it('requires a reason before returning, then streams the rewrite and opens the new version', async () => {
    const detail = makeArtifactDetail();
    const next = makeArtifactDetail({ id: ids.artifact2, version: 2, parentId: ids.artifact });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`GET /artifacts/${ids.artifact2}`]: () => json(200, next),
      [`POST ${ART_PATH}/return`]: () =>
        sseResponse([
          {
            type: 'step',
            step: {
              id: ids.step1,
              messageId: ids.assistantMsg,
              seq: 0,
              kind: 'run_skill',
              labelKey: 'steps.runSkill',
              status: 'done',
              startedAt: NOW,
              finishedAt: NOW,
            },
          },
          {
            type: 'artifact',
            artifact: makeArtifactSummary({ id: ids.artifact2, version: 2 }),
          },
          { type: 'done', messageId: ids.assistantMsg, reason: 'complete' },
        ]),
    });
    const user = userEvent.setup();
    const onConversationChanged = vi.fn();
    await openArtifact(user, { onConversationChanged });

    await user.click(button('退回重写'));
    const form = within(reviewBar()).getByRole('group', { name: '退回重写' });
    const submit = within(form).getByRole('button', { name: '退回并重写' });
    expect(submit).toBeDisabled();
    const reason = within(form).getByRole('textbox', { name: /退回原因/ });
    expect(reason).toBeRequired();
    await user.type(reason, '   ');
    expect(submit).toBeDisabled();
    await user.click(form.ownerDocument.body);
    expect(within(form).getByRole('alert')).toHaveTextContent('请填写退回原因');
    expect(api.callsTo('POST', `${ART_PATH}/return`)).toHaveLength(0);

    await user.type(reason, '语气再温和一些');
    await user.click(submit);

    expect(await screen.findByRole('heading', { name: /第 2 版/ })).toBeInTheDocument();
    expect(api.callsTo('POST', `${ART_PATH}/return`)[0]?.body).toEqual({
      reason: '语气再温和一些',
    });
    // 退回重写在对话里多了一轮，通知对话区重新加载
    expect(onConversationChanged).toHaveBeenCalledTimes(1);
  });

  it('offers no copy or export on a draft, in either view', async () => {
    const detail = makeArtifactDetail();
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    for (const name of ['复制通俗版', '导出图片', '导出 PDF', '基于此版修改']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('tab', { name: '专业版' }));
    expect(screen.queryByRole('button', { name: /复制|导出/ })).not.toBeInTheDocument();
    expect(button('确认')).toBeInTheDocument();
  });
});

describe('review bar on an approved artifact', () => {
  const approved = () =>
    makeArtifactDetail({ status: 'approved', hasCriticalFlags: true, criticalFlags: [CRITICAL] });

  it('copies the client text from the server and exports files', async () => {
    const detail = approved();
    const filename = '客户近况小结-2026-10-15.pdf';
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`POST ${ART_PATH}/copy`]: () =>
        json(200, { text: `合成通俗版\n\n${SYNTHETIC_DISCLAIMER}\n\n— Health Buddy` }),
      [`POST ${ART_PATH}/export`]: () =>
        new Response('%PDF-synthetic', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="export.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          },
        }),
    });
    const createObjectURL = vi.fn(() => 'blob:synthetic');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(queryButton('确认')).not.toBeInTheDocument();
    expect(queryButton('保存修改')).not.toBeInTheDocument();
    // 危急指标仍在审核栏提示，但不提供勾选和复制
    expect(within(reviewBar()).queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(button('复制通俗版'));
    expect(await within(reviewBar()).findByRole('status')).toHaveTextContent('已复制通俗版');
    await expect(navigator.clipboard.readText()).resolves.toContain('Health Buddy');

    await user.click(button('导出 PDF'));
    await waitFor(() => expect(clicked).toEqual([filename]));
    expect(api.callsTo('POST', `${ART_PATH}/export`)[0]?.body).toEqual({ format: 'pdf' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    expect(button('导出图片')).toBeEnabled();
    expect(button('基于此版修改')).toBeEnabled();
    // 专业版没有任何复制或导出入口（审核栏里的按钮只作用于通俗版）
    await user.click(screen.getByRole('tab', { name: '专业版' }));
    expect(
      within(screen.getByRole('tabpanel', { name: '专业版' })).queryByRole('button'),
    ).not.toBeInTheDocument();
  });

  it('creates a new draft from the approved version', async () => {
    const detail = approved();
    const draft = makeArtifactDetail({ id: ids.artifact2, version: 2, parentId: ids.artifact });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`POST ${ART_PATH}/revise`]: () => json(200, draft),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    await user.click(button('基于此版修改'));
    expect(await screen.findByRole('heading', { name: /第 2 版/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '通俗版内容' })).toBeInTheDocument();
    expect(api.callsTo('POST', `${ART_PATH}/revise`)).toHaveLength(1);
  });
});

describe('体检解读和面谈提纲（M2 规格 2.5、2.7、2.8）', () => {
  const REPORT_ID = '90000000-0000-4000-8000-0000000000a1';
  const interpretation = (overrides: Partial<ArtifactDetailResponse['artifact']> = {}) =>
    makeArtifactDetail(
      {
        skillId: 'report-interpretation',
        sourceReportId: REPORT_ID,
        hasCriticalFlags: true,
        criticalFlags: [{ ...CRITICAL, source: 'report', observedOn: '2026-09-12' }],
        riskTierSuggestion: { tier: 'medium', reason: '合成依据：空腹血糖高于参考范围' },
        ...overrides,
      },
      { sourceReport: { id: REPORT_ID, reportDate: '2026-09-12', correctedSince: true } },
    );

  it('审核栏先提示电话联系客户；勾选“采用建议分层”后随确认一起提交', async () => {
    const detail = interpretation();
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`POST ${ART_PATH}/approve`]: () => json(200, interpretation({ status: 'approved' })),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(await screen.findByRole('heading', { name: /体检解读/ })).toBeInTheDocument();
    const critical = within(reviewBar()).getByRole('group', { name: '危急指标' });
    expect(critical).toHaveTextContent('本报告有危急指标，请先电话联系客户');
    expect(screen.getByRole('note')).toHaveTextContent('2026-09-12');
    expect(screen.getByRole('note')).toHaveTextContent('建议重新生成');

    const tier = within(reviewBar()).getByRole('group', { name: /AI 建议分层：中/ });
    expect(tier).toHaveTextContent('合成依据：空腹血糖高于参考范围');
    // 建议分层不出现在通俗版里
    expect(screen.getByRole('tabpanel', { name: '通俗版' })).not.toHaveTextContent('建议分层');

    await user.click(within(critical).getByRole('checkbox', { name: /已知悉/ }));
    await user.click(within(tier).getByRole('checkbox', { name: /采用建议分层/ }));
    await user.click(button('确认'));
    await waitFor(() => expect(api.callsTo('POST', `${ART_PATH}/approve`)).toHaveLength(1));
    expect(api.callsTo('POST', `${ART_PATH}/approve`)[0]?.body).toEqual({
      version: 1,
      contentHash: 'hash-1',
      acknowledgedCritical: true,
      adoptRiskTier: true,
    });
    // 已审核后只显示建议，不再提供勾选
    await screen.findByRole('button', { name: '复制通俗版' });
    expect(
      within(within(reviewBar()).getByRole('group', { name: /AI 建议分层/ })).queryByRole(
        'checkbox',
      ),
    ).not.toBeInTheDocument();
  });

  it('通俗版里的风险分层字样被标出，确认按钮禁用', async () => {
    const clientFacing = `您好，您属于中风险人群，建议多走动。\n\n${SYNTHETIC_DISCLAIMER}`;
    const detail = makeArtifactDetail(
      { skillId: 'report-interpretation', content: { professional: '合成', clientFacing } },
      {
        hints: {
          judgementHints: [],
          criticalValueMentions: [],
          riskTierMentions: [{ text: '中风险人群', index: clientFacing.indexOf('中风险') }],
        },
      },
    );
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(button('确认')).toBeDisabled();
    expect(reviewBar()).toHaveTextContent('通俗版含风险分层字样');
    const marks = screen.getByRole('list', { name: '需要注意的位置' });
    expect(marks).toHaveTextContent('风险分层字样“中风险人群”');
    expect(within(marks).getByText('中风险人群', { selector: 'mark' })).toHaveAttribute(
      'data-kind',
      'riskTier',
    );
  });

  it('面谈提纲只有专业版：可以编辑和确认，确认后没有复制和导出', async () => {
    const professional = '## 面谈提纲\n- 平时早餐一般吃什么？';
    const detail = makeArtifactDetail({
      skillId: 'interview-outline',
      clientFacing: false,
      sourceReportId: REPORT_ID,
      content: { professional, clientFacing: '' },
    });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
      [`PATCH ${ART_PATH}`]: () =>
        json(
          200,
          makeArtifactDetail({
            ...detail.artifact,
            contentHash: 'hash-2',
            content: { professional: `${professional}\n- 补充`, clientFacing: '' },
          }),
        ),
      [`POST ${ART_PATH}/approve`]: () =>
        json(
          200,
          makeArtifactDetail({ ...detail.artifact, contentHash: 'hash-2', status: 'approved' }),
        ),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(screen.queryByRole('tab', { name: '通俗版' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: '专业版' })).toHaveTextContent('没有通俗版');
    const editor = screen.getByRole('textbox', { name: '专业版内容' });
    await user.type(editor, '\n- 补充');
    await user.click(button('保存修改'));
    await waitFor(() => expect(api.callsTo('PATCH', ART_PATH)).toHaveLength(1));
    expect(api.callsTo('PATCH', ART_PATH)[0]?.body).toMatchObject({
      content: { professional: `${professional}\n- 补充`, clientFacing: '' },
    });

    await waitFor(() => expect(button('确认')).toBeEnabled());
    await user.click(button('确认'));
    await waitFor(() => expect(api.callsTo('POST', `${ART_PATH}/approve`)).toHaveLength(1));
    expect(await within(reviewBar()).findByText(/不提供复制和导出/)).toBeInTheDocument();
    expect(queryButton('复制通俗版')).not.toBeInTheDocument();
    expect(queryButton('导出 PDF')).not.toBeInTheDocument();
    expect(queryButton('导出图片')).not.toBeInTheDocument();
    expect(button('基于此版修改')).toBeEnabled();
  });
});

describe('read-only task', () => {
  const readOnlyTask = makeTask({ detachedReason: 'client_transferred', archived: true });

  it('disables every action on a draft', async () => {
    const detail = makeArtifactDetail({ hasCriticalFlags: true, criticalFlags: [CRITICAL] });
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail, readOnlyTask)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user, { task: readOnlyTask });

    expect(reviewBar()).toHaveTextContent('客户已转出或删除，任务只读');
    expect(screen.queryByRole('textbox', { name: '通俗版内容' })).not.toBeInTheDocument();
    for (const name of ['保存修改', '确认', '退回重写']) expect(button(name)).toBeDisabled();
    expect(within(reviewBar()).getByRole('checkbox')).toBeDisabled();
  });

  it('disables copy, export and revise on an approved artifact', async () => {
    const detail = makeArtifactDetail({ status: 'approved' });
    const api = mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail, readOnlyTask)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user, { task: readOnlyTask });

    for (const name of ['复制通俗版', '导出图片', '导出 PDF', '基于此版修改']) {
      expect(button(name)).toBeDisabled();
    }
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows returned and voided versions read-only with a status note', async () => {
    const detail = makeArtifactDetail({ status: 'voided' });
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    await openArtifact(user);

    expect(reviewBar()).toHaveTextContent('此草稿已作废，只读');
    expect(within(reviewBar()).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('history tab', () => {
  it('lists versions and events without any content', async () => {
    const detail = makeArtifactDetail(
      { id: ids.artifact2, version: 2, status: 'approved' },
      {
        versions: [
          makeArtifactSummary({ status: 'returned' }),
          makeArtifactSummary({ id: ids.artifact2, version: 2, status: 'approved' }),
        ],
        events: [
          {
            id: ids.event1,
            artifactId: ids.artifact,
            actorId: ids.manager,
            action: 'returned',
            reason: '合成退回原因不应显示',
            format: null,
            createdAt: '2026-10-15T07:00:00.000Z',
          },
          {
            id: ids.event2,
            artifactId: ids.artifact2,
            actorId: ids.manager,
            action: 'exported',
            reason: null,
            format: 'png',
            createdAt: NOW,
          },
        ],
      },
    );
    mockApi({
      [`GET ${TASK_PATH}`]: () =>
        json(200, {
          ...emptyDetail(),
          artifacts: detail.versions,
        }),
      [`GET /artifacts/${ids.artifact2}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /第 2 版/ }));
    await screen.findByRole('heading', { name: /第 2 版/ });
    await user.click(screen.getByRole('tab', { name: '记录' }));

    const panel = screen.getByRole('tabpanel', { name: '记录' });
    expect(within(panel).getByRole('button', { name: '查看第 1 版' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('我 · 导出（图片）');
    expect(panel).toHaveTextContent('我 · 退回重写');
    expect(panel).not.toHaveTextContent('合成退回原因不应显示');
  });
});

describe('safe rendering', () => {
  it('renders model output as text, never as HTML', async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const detail = makeArtifactDetail({
      status: 'approved',
      content: {
        professional: `## 合成标题\n- **要点** ${payload}`,
        clientFacing: `合成通俗版 ${payload}\n\n${SYNTHETIC_DISCLAIMER}`,
      },
    });
    mockApi({
      [`GET ${TASK_PATH}`]: () => json(200, taskDetail(detail)),
      [`GET ${ART_PATH}`]: () => json(200, detail),
    });
    const user = userEvent.setup();
    const { container } = await openArtifact(user);

    const client = screen.getByTestId('artifact-client-facing');
    expect(client).toHaveTextContent(payload);
    await user.click(screen.getByRole('tab', { name: '专业版' }));
    const professional = screen.getByTestId('artifact-professional');
    expect(professional).toHaveTextContent(payload);
    expect(within(professional).getByText('要点').tagName).toBe('STRONG');
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('does not use innerHTML anywhere in the artifact preview', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .map((f) => readFileSync(join(here, f), 'utf8'));
    sources.push(readFileSync(join(here, '../shell/ResultsPanel.tsx'), 'utf8'));
    expect(sources.length).toBeGreaterThan(3);
    for (const source of sources) {
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/);
    }
  });
});
