import type { ReportUploadSummary, SkillSummary } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '../chat/Composer';
import { ClientForm } from '../record/ClientForm';
import {
  CLIENTS,
  NOW,
  SKILL,
  emptyDetail,
  ids,
  json,
  makeTask,
  mockApi,
  sseResponse,
} from '../test/mockApi';
import { ChatPane, type ChatPaneProps } from './ChatPane';

/**
 * M2 验收反馈（第 1、3、6、8 条）：按钮颜色、核对完成后的卡片、重复上传和选择报告、
 * 空着发送不需要再写要求的技能、核对完成后自动解读。全部是合成数据。
 */

const MSG_PATH = `/tasks/${ids.task}/messages`;
const DETAIL_PATH = `/tasks/${ids.task}`;
const REPORT_ID = '90000000-0000-4000-8000-0000000000c1';
const UPLOAD_ID = '90000000-0000-4000-8000-0000000000c2';

const INTERPRETATION: SkillSummary = {
  ...SKILL,
  id: 'report-interpretation',
  requiresReport: true,
  usesReport: true,
  allowsEmptyRequest: true,
};
// 报告可选（验收反馈）：不选报告也能发送
const OUTLINE: SkillSummary = {
  ...SKILL,
  id: 'interview-outline',
  clientFacing: false,
  requiresReport: false,
  usesReport: true,
  allowsEmptyRequest: true,
};
const SUMMARY_EMPTY: SkillSummary = { ...SKILL, allowsEmptyRequest: true };

function summary(overrides: Partial<ReportUploadSummary> = {}): ReportUploadSummary {
  return {
    id: UPLOAD_ID,
    clientId: ids.clientA,
    taskId: ids.task,
    status: 'needs_review',
    failureCategory: null,
    attempts: 1,
    pageCount: 1,
    progressPage: 1,
    reportId: null,
    createdAt: NOW,
    ...overrides,
  };
}

const reports = (list: { id: string; date: string; hasCritical?: boolean }[]) => () =>
  json(200, {
    reports: list.map((r) => ({
      id: r.id,
      reportDate: r.date,
      institution: null,
      source: 'upload',
      indicatorCount: 3,
      abnormalCount: 0,
      hasCritical: r.hasCritical ?? false,
    })),
  });

function renderPane(props: Partial<ChatPaneProps> = {}) {
  const all: ChatPaneProps = {
    narrow: false,
    onOpenMenu: () => {},
    resultsOpen: true,
    onToggleResults: () => {},
    task: makeTask({ clientId: ids.clientA }),
    skills: [SKILL, INTERPRETATION, OUTLINE],
    clients: CLIENTS,
    ...props,
  };
  const view = render(<ChatPane {...all} />);
  return {
    ...view,
    rerenderWith: (next: Partial<ChatPaneProps>) => view.rerender(<ChatPane {...all} {...next} />),
  };
}

const file = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'p.png', { type: 'image/png' });

async function pickSkill(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(await screen.findByRole('textbox'), '/');
  await user.click(screen.getByRole('option', { name }));
}

afterEach(() => vi.unstubAllGlobals());

describe('验收反馈 1：主要按钮用主色', () => {
  it('发送按钮是主色，空着时不能点、有内容时能点', async () => {
    const user = userEvent.setup();
    let text = '';
    const { rerender } = render(
      <Composer
        inputRef={{ current: null }}
        text={text}
        onTextChange={(v) => (text = v)}
        mode="craft"
        onModeChange={() => {}}
        skill={null}
        onSkillChange={() => {}}
        client={null}
        onClientChange={() => {}}
        skills={[]}
        clients={[]}
        disabled={false}
        generating={false}
        onSubmit={() => {}}
        onStop={() => {}}
      />,
    );
    const send = screen.getByRole('button', { name: '发送' });
    expect(send.className).toMatch(/primary/);
    expect(send).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'x');
    rerender(
      <Composer
        inputRef={{ current: null }}
        text="x"
        onTextChange={() => {}}
        mode="craft"
        onModeChange={() => {}}
        skill={null}
        onSkillChange={() => {}}
        client={null}
        onClientChange={() => {}}
        skills={[]}
        clients={[]}
        disabled={false}
        generating={false}
        onSubmit={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('新建客户表单的“新建”是主色', () => {
    render(<ClientForm onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: '新建' }).className).toMatch(/primary/);
    expect(screen.getByRole('button', { name: '取消' }).className).not.toMatch(/primary/);
  });
});

describe('验收反馈 3：核对完成后的识别卡片', () => {
  it('结果区里确认核对后，对话里的“去核对”变成不能点的“已完成核对”，并提示可以继续提问', async () => {
    let status: ReportUploadSummary['status'] = 'needs_review';
    mockApi({
      [`GET ${DETAIL_PATH}`]: () =>
        json(200, { ...emptyDetail(makeTask({ clientId: ids.clientA })), uploads: [summary()] }),
      [`GET /clients/${ids.clientA}/reports`]: reports([]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () =>
        json(200, {
          uploads: [summary(status === 'verified' ? { status, reportId: REPORT_ID } : { status })],
        }),
    });
    const onReviewUpload = vi.fn();
    const view = renderPane({ skills: [SKILL], uploadsVersion: 0, onReviewUpload });
    const card = await screen.findByRole('region', { name: '报告识别' });
    expect(within(card).getByRole('button', { name: '去核对' })).toBeEnabled();

    status = 'verified';
    view.rerenderWith({ skills: [SKILL], uploadsVersion: 1, onReviewUpload });
    const done = await within(card).findByRole('button', { name: '已完成核对' });
    expect(done).toBeDisabled();
    expect(within(card).queryByRole('button', { name: '去核对' })).not.toBeInTheDocument();
    expect(within(card).getByText('报告已加入客户档案，您可以继续提问。')).toBeVisible();
  });
});

describe('验收反馈 6：用已经上传过的报告', () => {
  it('选了 /体检解读 后列出已核对的报告，点一份就引用它', async () => {
    const user = userEvent.setup();
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([
        { id: REPORT_ID, date: '2026-09-12', hasCritical: true },
        { id: '90000000-0000-4000-8000-0000000000c3', date: '2025-09-01' },
      ]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
    });
    renderPane();
    await pickSkill(user, '体检解读');
    const picker = await screen.findByRole('group', { name: '选择要用的报告' });
    const buttons = within(picker).getAllByRole('button');
    // 含危急指标的报告带标记（合规评审）
    expect(buttons.map((b) => b.textContent)).toEqual([
      '报告 · 2026-09-12 含危急指标',
      '报告 · 2025-09-01',
    ]);
    await user.click(buttons[0]!);
    expect(screen.getByRole('button', { name: '移除报告 2026-09-12' })).toBeVisible();
    expect(screen.queryByRole('group', { name: '选择要用的报告' })).not.toBeInTheDocument();
  });

  it('重复上传已核对的文件：直接引用那份报告，不再提示“已经上传过”', async () => {
    const user = userEvent.setup();
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([{ id: REPORT_ID, date: '2026-09-12' }]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST /clients/${ids.clientA}/report-uploads`]: () =>
        json(409, {
          error: 'conflict',
          reasons: ['duplicate_file'],
          existing: {
            uploadId: UPLOAD_ID,
            status: 'verified',
            reportId: REPORT_ID,
            reportDate: '2026-09-12',
          },
        }),
    });
    renderPane();
    await pickSkill(user, '体检解读');
    await user.upload(screen.getByTestId('chat-file-input'), file());
    expect(
      await screen.findByText('这份文件已经上传并核对过（报告 · 2026-09-12），已为你引用这份报告'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '移除报告 2026-09-12' })).toBeVisible();
    expect(screen.queryByText('这份文件已经上传过了')).not.toBeInTheDocument();
    // 技能、客户和报告都有了，不用再写要求就能发送
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('重复上传还没核对完的文件：提示先核对，“去核对”打开那份识别记录', async () => {
    const user = userEvent.setup();
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST /clients/${ids.clientA}/report-uploads`]: () =>
        json(409, {
          error: 'conflict',
          reasons: ['duplicate_file'],
          existing: {
            uploadId: UPLOAD_ID,
            status: 'needs_review',
            reportId: null,
            reportDate: null,
          },
        }),
    });
    const onReviewUpload = vi.fn();
    renderPane({ onReviewUpload });
    await screen.findByRole('textbox');
    await user.upload(screen.getByTestId('chat-file-input'), file());
    expect(
      await screen.findByText('这份文件已经上传过，还没核对完，请先在核对标签里核对'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: '去核对' }));
    expect(onReviewUpload).toHaveBeenCalledWith(UPLOAD_ID);
  });

  it('一次上传里两个相同的文件：仍提示“已经上传过”', async () => {
    const user = userEvent.setup();
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST /clients/${ids.clientA}/report-uploads`]: () =>
        json(409, { error: 'conflict', reasons: ['duplicate_file'], existing: null }),
    });
    renderPane();
    await screen.findByRole('textbox');
    await user.upload(screen.getByTestId('chat-file-input'), [file(), file()]);
    expect(await screen.findByText('这份文件已经上传过了')).toBeVisible();
  });

  it('选了 /体检解读 时上传：识别完成自动打开核对，核对确认后自动开始解读', async () => {
    const user = userEvent.setup();
    let status: ReportUploadSummary['status'] = 'queued';
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: () =>
        status === 'verified' ? reports([{ id: REPORT_ID, date: '2026-09-12' }])() : reports([])(),
      [`GET /clients/${ids.clientA}/report-uploads`]: () =>
        json(200, {
          uploads: [summary(status === 'verified' ? { status, reportId: REPORT_ID } : { status })],
        }),
      [`POST /clients/${ids.clientA}/report-uploads`]: () =>
        json(201, {
          upload: {
            ...summary({ status: 'queued', progressPage: 0 }),
            version: 0,
            reportDate: null,
            institution: null,
            files: [],
            values: [],
            sameDateReportIds: [],
            criticalAcknowledged: false,
          },
        }),
      [`GET /report-uploads/${UPLOAD_ID}/events`]: () =>
        sseResponse([{ type: 'done', upload: summary() } as Record<string, unknown>]),
      [`POST ${MSG_PATH}`]: () => sseResponse([]),
    });
    const onReviewUpload = vi.fn();
    const view = renderPane({ onReviewUpload, uploadsVersion: 0 });
    await pickSkill(user, '体检解读');
    await user.upload(screen.getByTestId('chat-file-input'), file());
    const card = await screen.findByRole('region', { name: '报告识别' });
    expect(within(card).getByText('核对完成后会自动开始体检解读')).toBeVisible();
    await within(card).findByText('识别完成，请核对后确认');
    // 识别完成自动打开核对界面
    await waitFor(() => expect(onReviewUpload).toHaveBeenCalledWith(UPLOAD_ID));
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(0);

    // 结果区里确认核对
    status = 'verified';
    view.rerenderWith({ onReviewUpload, uploadsVersion: 1 });
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toMatchObject({
      mode: 'craft',
      skillId: 'report-interpretation',
      reportRefs: [REPORT_ID],
    });
    // 只开始一次
    view.rerenderWith({ onReviewUpload, uploadsVersion: 2 });
    await within(card).findByRole('button', { name: '已完成核对' });
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1);
    // 输入框里的 /体检解读 已经替健管师发出，去掉
    expect(screen.queryByRole('button', { name: '移除技能 体检解读' })).not.toBeInTheDocument();
  });

  it('没有解读意图时核对完成不自动解读，只提示已完成核对', async () => {
    const user = userEvent.setup();
    let status: ReportUploadSummary['status'] = 'needs_review';
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () =>
        json(200, {
          uploads: [summary(status === 'verified' ? { status, reportId: REPORT_ID } : { status })],
        }),
      [`POST /clients/${ids.clientA}/report-uploads`]: () =>
        json(201, {
          upload: {
            ...summary(),
            version: 1,
            reportDate: null,
            institution: null,
            files: [],
            values: [],
            sameDateReportIds: [],
            criticalAcknowledged: false,
          },
        }),
      [`POST ${MSG_PATH}`]: () => sseResponse([]),
    });
    const view = renderPane({ uploadsVersion: 0 });
    await screen.findByRole('textbox');
    await user.upload(screen.getByTestId('chat-file-input'), file());
    const card = await screen.findByRole('region', { name: '报告识别' });
    expect(within(card).queryByText('核对完成后会自动开始体检解读')).not.toBeInTheDocument();
    status = 'verified';
    view.rerenderWith({ uploadsVersion: 1 });
    await within(card).findByText('报告已加入客户档案，您可以继续提问。');
    expect(api.callsTo('POST', MSG_PATH)).toHaveLength(0);
  });
});

describe('验收反馈 8：不需要再写要求的技能可以空着发送', () => {
  it('/面谈提纲 选了技能和客户就能发送，内容为空；不支持的技能仍要写要求', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([{ id: REPORT_ID, date: '2026-09-12' }]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST ${MSG_PATH}`]: () => sseResponse([]),
    });
    renderPane();
    await pickSkill(user, '客户近况小结');
    // 测试里的近况小结没有标记 allowsEmptyRequest
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '移除技能 客户近况小结' }));

    await pickSkill(user, '面谈提纲');
    // 报告可选（验收反馈）：没选报告也能空着发送；列出报告供选择，并说明可以不选
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).toBeEnabled();
    const picker = await screen.findByRole('group', { name: '选择要用的报告' });
    expect(
      within(picker).getByText('可以不选：不选时用最近一份已核对的报告，没有报告就按档案生成'),
    ).toBeVisible();
    await user.click(within(picker).getByRole('button', { name: '报告 · 2026-09-12' }));
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'craft',
      content: '',
      skillId: 'interview-outline',
      clientRefs: [],
      reportRefs: [REPORT_ID],
    });
  });

  it('/面谈提纲 客户还没有已核对报告：选了技能就能空着发送，不带报告（验收反馈）', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST ${MSG_PATH}`]: () => sseResponse([]),
    });
    renderPane();
    await pickSkill(user, '面谈提纲');
    expect(screen.queryByRole('group', { name: '选择要用的报告' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toEqual({
      mode: 'craft',
      content: '',
      skillId: 'interview-outline',
      clientRefs: [],
    });
  });

  it('/体检解读 仍然要先选报告才能空着发送', async () => {
    const user = userEvent.setup();
    mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([{ id: REPORT_ID, date: '2026-09-12' }]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
    });
    renderPane();
    await pickSkill(user, '体检解读');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    const picker = await screen.findByRole('group', { name: '选择要用的报告' });
    expect(within(picker).getByText('不选时用最近一份已核对的报告')).toBeVisible();
    await user.click(within(picker).getByRole('button', { name: '报告 · 2026-09-12' }));
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('不需要报告的技能：选了技能就能发送（任务已关联客户）', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      [`GET ${DETAIL_PATH}`]: () => json(200, emptyDetail(makeTask({ clientId: ids.clientA }))),
      [`GET /clients/${ids.clientA}/reports`]: reports([]),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST ${MSG_PATH}`]: () => sseResponse([]),
    });
    renderPane({ skills: [SUMMARY_EMPTY] });
    await pickSkill(user, '客户近况小结');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', MSG_PATH)).toHaveLength(1));
    expect(api.callsTo('POST', MSG_PATH)[0]?.body).toMatchObject({
      content: '',
      skillId: SKILL.id,
    });
  });
});
