import type {
  ExtractedValue,
  ReportUpload,
  ReportUploadSummary,
  ReportUploadStreamEvent,
} from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPane, type ChatPaneProps } from '../shell/ChatPane';
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
import { ReviewView } from './ReviewView';

/** 合成的识别记录和识别结果。全部是虚构数据 */
const UPLOAD_ID = 'a0000000-0000-4000-8000-000000000001';
const FILE_ID = 'a0000000-0000-4000-8000-000000000002';
const VALUE_FPG = 'a0000000-0000-4000-8000-000000000003';
const VALUE_TC = 'a0000000-0000-4000-8000-000000000004';
const REPORT_ID = 'a0000000-0000-4000-8000-000000000005';

function value(overrides: Partial<ExtractedValue>): ExtractedValue {
  return {
    id: VALUE_TC,
    seq: 0,
    rawName: '总胆固醇',
    code: 'tc',
    rawValue: '4.5',
    rawUnit: 'mmol/L',
    value: 4.5,
    unit: 'mmol/L',
    refLow: null,
    refHigh: 5.2,
    refText: '<5.2',
    page: 1,
    sourceSnippet: null,
    flags: [],
    reviewStatus: 'pending',
    attention: false,
    abnormal: 'normal',
    ...overrides,
  };
}

const FPG = value({
  id: VALUE_FPG,
  seq: 1,
  rawName: '空腹血糖',
  code: 'fpg',
  rawValue: '108',
  rawUnit: 'mg/dL',
  value: 5.994,
  refLow: 3.885,
  refHigh: 6.105,
  refText: '70-110',
  flags: ['unit_converted'],
  attention: true,
});

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

function upload(overrides: Partial<ReportUpload> = {}): ReportUpload {
  return {
    ...summary(),
    version: 1,
    reportDate: '2026-09-01',
    institution: '合成体检中心',
    files: [
      {
        id: FILE_ID,
        seq: 0,
        mimeType: 'image/png',
        sizeBytes: 100,
        pageCount: 1,
        originalName: 'synthetic.png',
      },
    ],
    values: [value({}), FPG],
    sameDateReportIds: [],
    criticalAcknowledged: false,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('核对界面', () => {
  it('需特别注意的行逐行勾选后才能确认，勾选保存在后端；原件走后端地址', async () => {
    const user = userEvent.setup();
    let current = upload();
    const api = mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () => json(200, { upload: current }),
      [`PATCH /report-uploads/${UPLOAD_ID}/values/${VALUE_FPG}`]: () =>
        json(200, { value: { ...FPG, reviewStatus: 'checked' }, version: 2 }),
      [`POST /report-uploads/${UPLOAD_ID}/verify`]: () => {
        current = { ...current, status: 'verified', reportId: REPORT_ID, version: 3 };
        return json(200, { upload: current });
      },
    });
    const onChanged = vi.fn();
    render(<ReviewView uploadId={UPLOAD_ID} onChanged={onChanged} />);

    expect(
      await screen.findByText('还有 1 行需特别注意，请对照原件逐行勾选“已核对”'),
    ).toBeVisible();
    expect(screen.getByRole('img')).toHaveAttribute(
      'src',
      `/api/report-files/${FILE_ID}/content?page=1`,
    );
    // 换算过的行显示原值和标记
    expect(screen.getByText('已换算单位')).toBeVisible();
    expect(screen.getByText('（原值 108 mg/dL）')).toBeVisible();
    const confirm = screen.getByRole('button', { name: '确认核对' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: '已核对' }));
    expect(
      api.callsTo('PATCH', `/report-uploads/${UPLOAD_ID}/values/${VALUE_FPG}`)[0]?.body,
    ).toEqual({ checked: true });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/verify`)[0]?.body).toEqual({
      version: 2,
      checkedValueIds: [VALUE_FPG],
      reportDate: '2026-09-01',
      acknowledgedCritical: false,
      saveAsNew: false,
    });
    expect(await screen.findByText('已核对，已写入档案')).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认核对' })).not.toBeInTheDocument();
  });

  it('后端说有危急指标时显示危急指标和“已知悉”，勾选后再确认', async () => {
    const user = userEvent.setup();
    const current = upload({ values: [value({ code: 'fpg', rawName: '空腹血糖', value: 2.5 })] });
    let attempts = 0;
    const api = mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () => json(200, { upload: current }),
      [`POST /report-uploads/${UPLOAD_ID}/verify`]: () => {
        attempts += 1;
        if (attempts === 1) {
          return json(409, {
            error: 'conflict',
            reasons: ['critical_unacknowledged'],
            critical: [
              {
                metric: 'fpg',
                value: 2.5,
                unit: 'mmol/L',
                observedOn: '2026-09-01',
                source: 'report',
                rule: { comparator: 'lt', value: 3, level: 'urgent' },
              },
            ],
          });
        }
        return json(200, { upload: { ...current, status: 'verified', reportId: REPORT_ID } });
      },
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);
    await user.click(await screen.findByRole('button', { name: '确认核对' }));
    expect(await screen.findByText('有危急指标，请勾选“已知悉”后再确认')).toBeVisible();
    expect(screen.getByText('空腹血糖 2.5 mmol/L')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: '已知悉以上危急指标，会及时联系客户' }));
    await user.click(screen.getByRole('button', { name: '确认核对' }));
    await screen.findByText('已核对，已写入档案');
    expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/verify`)[1]?.body).toMatchObject({
      acknowledgedCritical: true,
    });
  });

  it('同一天已有报告时要选择作为新报告保存', async () => {
    mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () =>
        json(200, { upload: upload({ sameDateReportIds: [REPORT_ID] }) }),
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);
    expect(
      await screen.findByRole('checkbox', { name: '这一天已有报告，作为新报告保存' }),
    ).not.toBeChecked();
  });
});

describe('对话里上传报告', () => {
  function renderPane(props: Partial<ChatPaneProps> = {}) {
    const all: ChatPaneProps = {
      narrow: false,
      onOpenMenu: () => {},
      resultsOpen: true,
      onToggleResults: () => {},
      task: makeTask(),
      skills: [SKILL],
      clients: CLIENTS,
      ...props,
    };
    return render(<ChatPane {...all} />);
  }

  const file = () =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'p.png', { type: 'image/png' });

  it('没有 @ 客户时提示先 @ 客户，不上传', async () => {
    const user = userEvent.setup();
    const api = mockApi({ [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail()) });
    renderPane();
    await screen.findByRole('textbox');
    await user.upload(screen.getByTestId('chat-file-input'), file());
    expect(await screen.findByText('请先 @ 客户，再上传报告')).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('关联了客户的任务：上传后显示识别进度，识别完成后可以去核对', async () => {
    const user = userEvent.setup();
    const task = makeTask({ clientId: ids.clientA });
    const events: ReportUploadStreamEvent[] = [
      {
        type: 'progress',
        upload: summary({ status: 'processing', progressPage: 1, pageCount: 2 }),
      },
      { type: 'done', upload: summary({ pageCount: 2, progressPage: 2 }) },
    ];
    const api = mockApi({
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(task)),
      [`GET /clients/${ids.clientA}/reports`]: () =>
        json(200, {
          reports: [
            {
              id: REPORT_ID,
              reportDate: '2026-08-01',
              institution: null,
              source: 'upload',
              indicatorCount: 3,
              abnormalCount: 1,
            },
          ],
        }),
      [`GET /clients/${ids.clientA}/report-uploads`]: () => json(200, { uploads: [] }),
      [`POST /clients/${ids.clientA}/report-uploads`]: () =>
        json(201, {
          upload: upload({ status: 'queued', progressPage: 0, pageCount: 2, values: [] }),
        }),
      [`GET /report-uploads/${UPLOAD_ID}/events`]: () => sseResponse(events),
    });
    const onReviewUpload = vi.fn();
    renderPane({ task, onReviewUpload });
    await screen.findByRole('textbox');
    await user.upload(screen.getByTestId('chat-file-input'), [file(), file()]);

    const card = await screen.findByRole('region', { name: '报告识别' });
    await within(card).findByText('识别完成，请核对后确认');
    const post = api.callsTo('POST', `/clients/${ids.clientA}/report-uploads`)[0];
    const form = post?.body as FormData;
    expect(form.get('taskId')).toBe(ids.task);
    expect(form.getAll('files')).toHaveLength(2);
    await user.click(within(card).getByRole('button', { name: '去核对' }));
    expect(onReviewUpload).toHaveBeenCalledWith(UPLOAD_ID);
  });

  it('@ 列表里有已核对的报告；还没核对完的列出来但不能选；发送时带上报告引用', async () => {
    const user = userEvent.setup();
    const task = makeTask({ clientId: ids.clientA });
    const api = mockApi({
      [`GET /tasks/${ids.task}`]: () => json(200, emptyDetail(task)),
      [`GET /clients/${ids.clientA}/reports`]: () =>
        json(200, {
          reports: [
            {
              id: REPORT_ID,
              reportDate: '2026-08-01',
              institution: null,
              source: 'upload',
              indicatorCount: 3,
              abnormalCount: 0,
            },
          ],
        }),
      [`GET /clients/${ids.clientA}/report-uploads`]: () =>
        json(200, { uploads: [summary({ createdAt: '2026-10-01T00:00:00.000Z' })] }),
      [`POST /tasks/${ids.task}/messages`]: () => sseResponse([]),
    });
    renderPane({ task });
    const box = await screen.findByRole('textbox');
    await user.type(box, '@报告');
    const pending = await screen.findByRole('option', { name: /报告 · 2026-10-01/ });
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    expect(within(pending).getByText('这份报告还没核对完')).toBeVisible();
    await user.click(screen.getByRole('option', { name: '报告 · 2026-08-01' }));
    expect(screen.getByRole('button', { name: '移除报告 2026-08-01' })).toBeVisible();
    await user.type(box, '看看这份报告{Enter}');
    await waitFor(() => expect(api.callsTo('POST', `/tasks/${ids.task}/messages`)).toHaveLength(1));
    expect(api.callsTo('POST', `/tasks/${ids.task}/messages`)[0]?.body).toMatchObject({
      reportRefs: [REPORT_ID],
    });
  });
});
