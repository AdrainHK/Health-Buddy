import type {
  ExtractedValue,
  ReportUpload,
  ReportUploadSummary,
  ReportUploadStreamEvent,
} from '@health-buddy/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    checked: false,
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

const IDENTITY = '我已对照原件确认，报告上的姓名是本客户';

describe('核对界面', () => {
  it('需特别注意的行逐行勾选后才能确认，勾选保存在后端；原件走后端地址', async () => {
    const user = userEvent.setup();
    let current = upload();
    const api = mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () => json(200, { upload: current }),
      [`PATCH /report-uploads/${UPLOAD_ID}/values/${VALUE_FPG}`]: () =>
        json(200, { value: { ...FPG, reviewStatus: 'checked', checked: true }, version: 2 }),
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
    await user.click(screen.getByRole('checkbox', { name: IDENTITY }));

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
      identityConfirmed: true,
      confirmAll: false,
    });
    expect(await screen.findByText('已核对，已写入档案')).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认核对' })).not.toBeInTheDocument();
  });

  it('验收反馈 5：修改过的行再勾选“已核对”能勾上，确认时带上这一行', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    // 和后端一致：修改后 reviewStatus 是 edited、需要重新勾选；勾选后仍是 edited，checked 为 true
    const edited = { ...FPG, rawValue: '109', value: 6.05, reviewStatus: 'edited' as const };
    const api = mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () => json(200, { upload: upload() }),
      [`PATCH /report-uploads/${UPLOAD_ID}/values/${VALUE_FPG}`]: (req) => {
        patches.push(req.body);
        const body = req.body as { checked?: boolean };
        if (body.checked === true && patches.length > 1) {
          return json(200, { value: { ...edited, checked: true }, version: 3 });
        }
        return json(200, { value: { ...edited, checked: false }, version: 2 });
      },
      [`POST /report-uploads/${UPLOAD_ID}/verify`]: () =>
        json(200, { upload: upload({ status: 'verified', reportId: REPORT_ID, version: 4 }) }),
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);

    await user.click(await screen.findByRole('button', { name: '修改 空腹血糖' }));
    const valueInput = screen.getByRole('textbox', { name: '数值' });
    await user.clear(valueInput);
    await user.type(valueInput, '109');
    await user.click(screen.getByRole('button', { name: '保存' }));
    // 修改后的行要重新勾选
    const box = await screen.findByRole('checkbox', { name: '已核对' });
    expect(box).not.toBeChecked();
    expect(patches[0]).toMatchObject({ rawValue: '109', code: 'fpg' });

    await user.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '已核对' })).toBeChecked());
    expect(screen.getByText('需特别注意的行都已核对')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: IDENTITY }));
    const confirm = screen.getByRole('button', { name: '确认核对' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() =>
      expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/verify`)[0]?.body).toMatchObject({
        version: 3,
        checkedValueIds: [VALUE_FPG],
      }),
    );
  });

  it('验收反馈 7：补录一行时默认按名称自动对应指标，不传 code', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () => json(200, { upload: upload() }),
      [`POST /report-uploads/${UPLOAD_ID}/values`]: () =>
        json(200, {
          value: value({
            id: 'a0000000-0000-4000-8000-000000000009',
            seq: 2,
            rawName: '尿酸 UA',
            code: 'uric_acid',
            reviewStatus: 'added',
            checked: true,
          }),
          version: 2,
        }),
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);
    await user.click(await screen.findByRole('button', { name: '补录一项' }));
    expect(screen.getByRole('combobox', { name: '对应指标' })).toHaveValue('__auto');
    await user.type(screen.getByRole('textbox', { name: '报告上的名称' }), '尿酸 UA');
    await user.type(screen.getByRole('textbox', { name: '数值' }), '380');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/values`)).toHaveLength(1),
    );
    const body = api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/values`)[0]?.body;
    expect(body).toMatchObject({ rawName: '尿酸 UA', rawValue: '380' });
    expect(body).not.toHaveProperty('code');
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
    await user.click(await screen.findByRole('checkbox', { name: IDENTITY }));
    await user.click(screen.getByRole('button', { name: '确认核对' }));
    expect(await screen.findByText('有危急指标，请勾选“已知悉”后再确认')).toBeVisible();
    expect(screen.getByText('空腹血糖 2.5 mmol/L')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: '已知悉以上危急指标，会及时联系客户' }));
    await user.click(screen.getByRole('button', { name: '确认核对' }));
    await screen.findByText('已核对，已写入档案');
    expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/verify`)[1]?.body).toMatchObject({
      acknowledgedCritical: true,
    });
  });

  it('验收反馈 4：原件上方固定提醒核对姓名，勾选前两个确认按钮都不能点', async () => {
    const user = userEvent.setup();
    // 没有需特别注意的行，只差身份确认
    mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () =>
        json(200, { upload: upload({ values: [value({})] }) }),
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);
    const notice = await screen.findByText('请确认报告上的姓名是本客户');
    // 提醒在原件预览上面
    expect(
      notice.compareDocumentPosition(screen.getByRole('region', { name: '报告原件' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认核对' });
    const confirmAll = screen.getByRole('button', { name: '确认所有数据' });
    expect(confirm).toBeDisabled();
    expect(confirmAll).toBeDisabled();
    // 按钮旁列出还不能确认的原因
    const blockers = screen.getByRole('list', { name: '确认前还需要' });
    expect(
      within(blockers).getByText('勾选“报告上的姓名是本客户”（原件上方或这里都可以）'),
    ).toBeVisible();

    const box = screen.getByRole('checkbox', { name: IDENTITY });
    await user.click(box);
    expect(confirm).toBeEnabled();
    expect(confirmAll).toBeEnabled();
    await user.click(box);
    expect(confirm).toBeDisabled();
    expect(confirmAll).toBeDisabled();
  });

  it('手机验收反馈 1：按钮旁的勾选框和上方同步，报告日期为空时说明原因', async () => {
    const user = userEvent.setup();
    // 报告上没有识别出日期
    mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () =>
        json(200, { upload: upload({ values: [value({})], reportDate: null }) }),
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);
    const near = await screen.findByRole('checkbox', {
      name: '报告上的姓名是本客户（已对照原件）',
    });
    const top = screen.getByRole('checkbox', { name: IDENTITY });
    const confirm = screen.getByRole('button', { name: '确认核对' });
    const confirmAll = screen.getByRole('button', { name: '确认所有数据' });
    // 按钮旁的勾选框在按钮前面、原件后面
    expect(
      screen.getByRole('region', { name: '报告原件' }).compareDocumentPosition(near) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(near);
    expect(top).toBeChecked();
    // 只差日期：两个按钮仍不能点，原因写在按钮旁
    expect(confirmAll).toBeDisabled();
    const blockers = screen.getByRole('list', { name: '确认前还需要' });
    expect(within(blockers).getAllByRole('listitem')).toHaveLength(1);
    expect(within(blockers).getByText('填写报告日期（报告上没有识别出日期）')).toBeVisible();
    fireEvent.change(screen.getByLabelText('报告日期'), { target: { value: '2026-09-01' } });
    expect(confirm).toBeEnabled();
    expect(confirmAll).toBeEnabled();
    expect(screen.queryByRole('list', { name: '确认前还需要' })).toBeNull();
    // 取消上方的勾选，下方同步取消
    await user.click(top);
    expect(near).not.toBeChecked();
    expect(confirmAll).toBeDisabled();
  });

  it('验收反馈 2：“确认所有数据”不用逐行勾选、不用“已知悉”，一键确认', async () => {
    const user = userEvent.setup();
    // 一行需特别注意（未勾选），后端会识别出危急指标，但一键确认不再要求“已知悉”
    let current = upload();
    const api = mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () => json(200, { upload: current }),
      [`POST /report-uploads/${UPLOAD_ID}/verify`]: () => {
        current = {
          ...current,
          status: 'verified',
          reportId: REPORT_ID,
          version: 2,
          criticalAcknowledged: true,
          values: current.values.map((v) => ({ ...v, checked: true })),
        };
        return json(200, {
          upload: current,
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
      },
    });
    const onChanged = vi.fn();
    render(<ReviewView uploadId={UPLOAD_ID} onChanged={onChanged} />);
    expect(
      await screen.findByText('还有 1 行需特别注意，请对照原件逐行勾选“已核对”'),
    ).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: IDENTITY }));
    // 逐行确认仍要先勾选；一键确认可以直接点
    expect(screen.getByRole('button', { name: '确认核对' })).toBeDisabled();
    const confirmAll = screen.getByRole('button', { name: '确认所有数据' });
    expect(confirmAll).toBeEnabled();
    await user.click(confirmAll);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.callsTo('PATCH', `/report-uploads/${UPLOAD_ID}/values/${VALUE_FPG}`)).toHaveLength(
      0,
    );
    expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/verify`)).toHaveLength(1);
    expect(api.callsTo('POST', `/report-uploads/${UPLOAD_ID}/verify`)[0]?.body).toEqual({
      version: 1,
      checkedValueIds: [],
      reportDate: '2026-09-01',
      acknowledgedCritical: false,
      saveAsNew: false,
      identityConfirmed: true,
      confirmAll: true,
    });
    expect(await screen.findByText('已核对，已写入档案')).toBeVisible();
    // 确认后醒目列出危急指标并提示先电话联系客户；不需要勾选“已知悉”
    const notice = screen.getByRole('group', { name: '危急指标' });
    expect(within(notice).getByText('空腹血糖 2.5 mmol/L')).toBeVisible();
    expect(within(notice).getByText('本报告有危急指标，请先电话联系客户。')).toBeVisible();
    expect(
      screen.queryByRole('checkbox', { name: '已知悉以上危急指标，会及时联系客户' }),
    ).toBeNull();
  });

  it('“确认所有数据”遇到没有数值的行仍被拒绝，并点名要处理的行', async () => {
    const user = userEvent.setup();
    const broken = value({ rawName: '总胆固醇', rawValue: '模糊', value: null, unit: null });
    mockApi({
      [`GET /report-uploads/${UPLOAD_ID}`]: () =>
        json(200, { upload: upload({ values: [broken, FPG] }) }),
      [`POST /report-uploads/${UPLOAD_ID}/verify`]: () =>
        json(409, { error: 'conflict', reasons: ['missing_value'], valueIds: [VALUE_TC] }),
    });
    render(<ReviewView uploadId={UPLOAD_ID} />);
    await user.click(await screen.findByRole('checkbox', { name: IDENTITY }));
    await user.click(screen.getByRole('button', { name: '确认所有数据' }));
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('有指标没有数值（看不清或单位未识别），请修改或删除'),
    ).toBeVisible();
    expect(within(alert).getByText('需要先修改或删除的行：总胆固醇')).toBeVisible();
    // 那一行醒目标出
    const row = screen.getByRole('button', { name: '修改 总胆固醇' }).closest('li');
    expect(row).toHaveAttribute('data-highlighted', 'true');
    expect(screen.getByRole('button', { name: '确认所有数据' })).toBeEnabled();
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
    // 识别完成后自动打开核对界面（验收反馈 6 的产品决定）
    await waitFor(() => expect(onReviewUpload).toHaveBeenCalledWith(UPLOAD_ID));
    onReviewUpload.mockClear();
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
