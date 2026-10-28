import type { VisitMaterial } from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { careIds, makeVisit } from '../test/careFixtures';
import { NOW, ids, json, mockApi } from '../test/mockApi';
import { localToday } from './dates';
import { VisitMaterials } from './VisitMaterials';

/** 随访素材上传（M5 规格 2.9，Q21、Q24）。全部是合成数据 */

const LIST = `/clients/${ids.clientA}/visit-materials`;
const MATERIAL_ID = 'a7000000-0000-4000-8000-000000000001';

function material(over: Partial<VisitMaterial> = {}): VisitMaterial {
  return {
    id: MATERIAL_ID,
    clientId: ids.clientA,
    visitId: careIds.visit1,
    kind: 'paste',
    charCount: 12,
    consumedArtifactId: null,
    purgeAfter: NOW,
    purged: false,
    createdAt: '2026-10-15T08:00:00.000Z',
    ...over,
  };
}

function routes(materials: VisitMaterial[], consentRecorded: boolean) {
  return {
    [`GET ${LIST}`]: () => json(200, { materials, consentRecorded }),
    [`GET /visits?clientId=${ids.clientA}`]: () =>
      json(200, {
        visits: [
          makeVisit({ dueDate: localToday() }),
          makeVisit({ id: careIds.visit2, dueDate: '2026-12-01' }),
        ],
      }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('随访素材', () => {
  it('第一次为这位客户上传：必须勾选“已告知客户”；默认关联今天到期的随访', async () => {
    const api = mockApi({
      ...routes([], false),
      [`POST ${LIST}`]: () => json(201, { material: material() }),
    });
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <VisitMaterials clientId={ids.clientA} readOnly={false} uploading onCloseUpload={onClose} />,
    );
    const form = await screen.findByRole('form', { name: '上传随访素材' });
    expect(within(form).getByRole('combobox', { name: '关联的随访' })).toHaveValue(careIds.visit1);
    await user.type(within(form).getByRole('textbox'), '  合成聊天记录：最近每天散步 ');
    expect(within(form).getByText('13 / 20000 字')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: '上传' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('请先勾选“已告知客户”');
    expect(api.callsTo('POST', LIST)).toHaveLength(0);
    await user.click(
      within(form).getByRole('checkbox', { name: '已告知客户本次沟通内容会被整理成服务记录' }),
    );
    await user.click(within(form).getByRole('button', { name: '上传' }));
    await waitFor(() => expect(api.callsTo('POST', LIST)).toHaveLength(1));
    expect(api.callsTo('POST', LIST)[0]!.body).toEqual({
      text: '合成聊天记录：最近每天散步',
      source: 'paste',
      visitId: careIds.visit1,
      consentConfirmed: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('选择 .txt 文件：在浏览器里读出文字上传，来源记为 txt；已告知过的客户不再询问', async () => {
    const api = mockApi({
      ...routes([], true),
      [`POST ${LIST}`]: () => json(201, { material: material({ kind: 'txt' }) }),
    });
    const user = userEvent.setup();
    render(
      <VisitMaterials clientId={ids.clientA} readOnly={false} uploading onCloseUpload={() => {}} />,
    );
    const form = await screen.findByRole('form', { name: '上传随访素材' });
    expect(within(form).queryByRole('checkbox')).toBeNull();
    await user.selectOptions(within(form).getByRole('combobox', { name: '关联的随访' }), '');
    await user.upload(
      screen.getByTestId('material-file-input'),
      new File(['合成通话笔记'], 'notes.txt', { type: 'text/plain' }),
    );
    await waitFor(() => expect(within(form).getByRole('textbox')).toHaveValue('合成通话笔记'));
    await user.click(within(form).getByRole('button', { name: '上传' }));
    await waitFor(() => expect(api.callsTo('POST', LIST)).toHaveLength(1));
    expect(api.callsTo('POST', LIST)[0]!.body).toEqual({ text: '合成通话笔记', source: 'txt' });
  });

  it('超过 20000 字时前端拦截；后端报 413、未配置加密时给出对应提示', async () => {
    const api = mockApi({
      ...routes([], true),
      [`POST ${LIST}`]: () => json(503, { error: 'not_configured' }),
    });
    const user = userEvent.setup();
    render(
      <VisitMaterials clientId={ids.clientA} readOnly={false} uploading onCloseUpload={() => {}} />,
    );
    const form = await screen.findByRole('form', { name: '上传随访素材' });
    const box = within(form).getByRole('textbox');
    await user.click(box);
    await user.paste('合'.repeat(20001));
    await user.click(within(form).getByRole('button', { name: '上传' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('素材超过 20000 字');
    expect(api.callsTo('POST', LIST)).toHaveLength(0);
    await user.clear(box);
    await user.type(box, '合成笔记');
    await user.click(within(form).getByRole('button', { name: '上传' }));
    expect(await within(form).findByText(/加密存储还没有配置/)).toBeInTheDocument();
  });

  it('还没整理成记录的素材显示为卡片（日期、字数、关联的随访），可以删除；已用过、已删除原文的不显示', async () => {
    const api = mockApi({
      ...routes(
        [
          material(),
          material({
            id: 'a7000000-0000-4000-8000-000000000002',
            consumedArtifactId: ids.artifact,
          }),
          material({ id: 'a7000000-0000-4000-8000-000000000003', purged: true }),
        ],
        true,
      ),
      [`DELETE /visit-materials/${MATERIAL_ID}`]: () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(
      <VisitMaterials
        clientId={ids.clientA}
        readOnly={false}
        uploading={false}
        onCloseUpload={() => {}}
      />,
    );
    const list = await screen.findByRole('list', { name: '随访素材' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent(`随访素材 · 2026-10-15 · 12 字 关联 ${localToday()} 的随访`);
    await user.click(
      within(cards[0]!).getByRole('button', { name: '删除 2026-10-15 上传的随访素材' }),
    );
    await waitFor(() =>
      expect(api.callsTo('DELETE', `/visit-materials/${MATERIAL_ID}`)).toHaveLength(1),
    );
    await waitFor(() => expect(api.callsTo('GET', LIST).length).toBeGreaterThan(1));
  });

  it('/随访记录：可以勾选要整理的素材，带上第一份关联的随访；不选技能时没有勾选框', async () => {
    mockApi(
      routes(
        [material(), material({ id: 'a7000000-0000-4000-8000-000000000002', visitId: null })],
        true,
      ),
    );
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <VisitMaterials
        clientId={ids.clientA}
        readOnly={false}
        uploading={false}
        onCloseUpload={() => {}}
        selectable
        selected={[]}
        onSelect={onSelect}
      />,
    );
    const boxes = await screen.findAllByRole('checkbox', { name: '整理这份（2026-10-15）' });
    expect(boxes).toHaveLength(2);
    expect(screen.getByText('勾选要整理成记录的素材，最多 3 份')).toBeInTheDocument();
    await user.click(boxes[0]!);
    expect(onSelect).toHaveBeenLastCalledWith([MATERIAL_ID], careIds.visit1);
    rerender(
      <VisitMaterials
        clientId={ids.clientA}
        readOnly={false}
        uploading={false}
        onCloseUpload={() => {}}
      />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('只读任务：只显示卡片，不能删除和上传', async () => {
    mockApi(routes([material()], true));
    render(<VisitMaterials clientId={ids.clientA} readOnly uploading onCloseUpload={() => {}} />);
    const list = await screen.findByRole('list', { name: '随访素材' });
    expect(within(list).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });
});
