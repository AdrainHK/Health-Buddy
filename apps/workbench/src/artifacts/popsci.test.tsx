import type {
  ArtifactDetailResponse,
  ContentCheckResult,
  PopsciContent,
} from '@health-buddy/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOW, ids, json, makeArtifactDetail, mockApi } from '../test/mockApi';
import { ArtifactView } from './ArtifactView';

/** M8 第 4 步：科普产物的预览、编辑、合规检查结果和“已核对”（规格 2.1 第 5、7、8 条）。合成数据 */

const ARTICLE: PopsciContent = {
  kind: 'popsci_article',
  title: '冬季怎样管理血压',
  sections: [
    { heading: '天冷要保暖', body: '出门注意保暖，避免突然受凉。' },
    { heading: '规律作息', body: '坚持这样做可以治愈。' },
  ],
  summary: '',
};

const check = (over: Partial<ContentCheckResult> = {}): ContentCheckResult => ({
  rulesVersion: 1,
  hits: [],
  checkedAt: NOW,
  ackedBy: null,
  ackedAt: null,
  ...over,
});

function popsciDetail(
  structured: PopsciContent,
  contentCheck: ContentCheckResult,
): ArtifactDetailResponse {
  return makeArtifactDetail(
    {
      skillId: 'popsci-article',
      clientId: null,
      clientFacing: false,
      content: { professional: '', clientFacing: '' },
      structured,
    },
    { contentCheck },
  );
}

function renderView(detail: ArtifactDetailResponse, onDetail = vi.fn()) {
  render(
    <ArtifactView
      detail={detail}
      readOnly={false}
      onDetail={onDetail}
      onReload={() => {}}
      onOpen={() => {}}
      onChanged={() => {}}
      onReadOnly={() => {}}
      onBack={() => {}}
    />,
  );
  return onDetail;
}

afterEach(() => vi.unstubAllGlobals());

describe('科普产物', () => {
  it('只显示正文编辑器和固定提示；禁止类问题标出位置，不能确认', () => {
    mockApi({});
    renderView(
      popsciDetail(
        ARTICLE,
        check({
          hits: [
            {
              ruleId: 'builtin_banned',
              category: 'forbid',
              term: '治愈',
              reason: '不能承诺疗效',
              location: { field: 'body', index: 1, item: null },
            },
          ],
        }),
      ),
    );
    expect(screen.getByTestId('popsci-editor')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '通俗版' })).not.toBeInTheDocument();
    expect(screen.getByRole('note', { name: '固定提示' })).toHaveTextContent(
      '仅供参考，非医疗诊断如有不适请及时就医',
    );
    const forbid = screen.getByRole('list', { name: '禁止类问题' });
    expect(forbid).toHaveTextContent('第 2 节正文治愈不能承诺疗效');
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled();
    expect(screen.getByText(/合规检查有“禁止”类的问题/)).toBeInTheDocument();
  });

  it('改正文后保存：带上结构化内容；空字段时不能保存', async () => {
    const api = mockApi({
      [`PATCH /artifacts/${ids.artifact}`]: () =>
        json(200, popsciDetail({ ...ARTICLE, sections: [ARTICLE.sections[0]!] }, check())),
    });
    const user = userEvent.setup();
    const onDetail = renderView(popsciDetail(ARTICLE, check()));
    const body = screen.getByRole('textbox', { name: /第 2 节正文/ });
    await user.clear(body);
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(screen.getByTestId('structured-problems')).toHaveTextContent('有空的标题');
    await user.click(screen.getByRole('button', { name: '删除第 2 节' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(onDetail).toHaveBeenCalled());
    const sent = api.callsTo('PATCH', `/artifacts/${ids.artifact}`)[0]!.body as {
      structured: PopsciContent;
    };
    expect(sent.structured).toEqual({ ...ARTICLE, sections: [ARTICLE.sections[0]] });
  });

  it('需要人工判断的项目：点“已核对”后记下核对，再确认', async () => {
    const reviewHit = {
      ruleId: 'disease_names',
      category: 'review' as const,
      term: '高血压',
      reason: '提到疾病名称，请核对',
      location: { field: 'title' as const, index: null, item: null },
    };
    const clean = { ...ARTICLE, sections: [ARTICLE.sections[0]!] };
    const api = mockApi({
      [`POST /artifacts/${ids.artifact}/compliance-ack`]: () =>
        json(
          200,
          popsciDetail(clean, check({ hits: [reviewHit], ackedBy: ids.manager, ackedAt: NOW })),
        ),
    });
    const user = userEvent.setup();
    const onDetail = renderView(popsciDetail(clean, check({ hits: [reviewHit] })));
    const list = screen.getByRole('list', { name: '需要人工判断的项目' });
    expect(within(list).getByText('高血压')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '已核对以上项目' }));
    await waitFor(() => expect(onDetail).toHaveBeenCalled());
    expect(api.callsTo('POST', `/artifacts/${ids.artifact}/compliance-ack`)[0]!.body).toEqual({
      contentHash: 'hash-1',
    });
  });

  it('已核对、没有禁止类时可以确认；检查通过时显示“没有发现问题”', () => {
    mockApi({});
    renderView(popsciDetail({ ...ARTICLE, sections: [ARTICLE.sections[0]!] }, check()));
    expect(screen.getByText('没有发现问题')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled();
  });

  it('还没有检查结果时不能确认；有禁止类或未保存的修改时“已核对”不能点；草稿没有复制和导出', async () => {
    mockApi({});
    const user = userEvent.setup();
    const { unmount } = render(
      <ArtifactView
        detail={makeArtifactDetail(
          {
            skillId: 'popsci-article',
            clientId: null,
            clientFacing: false,
            content: { professional: '', clientFacing: '' },
            structured: ARTICLE,
          },
          { contentCheck: null },
        )}
        readOnly={false}
        onDetail={() => {}}
        onReload={() => {}}
        onOpen={() => {}}
        onChanged={() => {}}
        onReadOnly={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /复制|导出/ })).not.toBeInTheDocument();
    unmount();

    const review = {
      ruleId: 'disease_names',
      category: 'review' as const,
      term: '高血压',
      reason: '请核对',
      location: { field: 'title' as const, index: null, item: null },
    };
    const forbid = {
      ...review,
      ruleId: 'builtin_banned',
      category: 'forbid' as const,
      term: '治愈',
    };
    const { unmount: u2 } = render(
      <ArtifactView
        detail={popsciDetail(ARTICLE, check({ hits: [forbid, review] }))}
        readOnly={false}
        onDetail={() => {}}
        onReload={() => {}}
        onOpen={() => {}}
        onChanged={() => {}}
        onReadOnly={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '已核对以上项目' })).toBeDisabled();
    u2();

    renderView(popsciDetail(ARTICLE, check({ hits: [review] })));
    expect(screen.getByRole('button', { name: '已核对以上项目' })).toBeEnabled();
    await user.type(screen.getByRole('textbox', { name: /^标题/ }), '呀');
    expect(screen.getByRole('button', { name: '已核对以上项目' })).toBeDisabled();
    expect(
      screen.getByText('下面是已保存内容的检查结果，保存修改后会重新检查'),
    ).toBeInTheDocument();
  });

  it('已审核：文章有复制、导出 Word 和 PDF；PPT 只有导出 PPTX；社群稿只有复制', () => {
    mockApi({});
    const approved = (structured: PopsciContent, skillId: string) =>
      makeArtifactDetail(
        {
          skillId,
          status: 'approved',
          clientId: null,
          clientFacing: false,
          content: { professional: '', clientFacing: '' },
          structured,
        },
        { contentCheck: check() },
      );
    const labels = () =>
      ['复制全文', '导出 Word', '导出 PDF', '导出 PPTX'].filter((name) =>
        screen.queryByRole('button', { name }),
      );
    const cases: [PopsciContent, string, string[]][] = [
      [ARTICLE, 'popsci-article', ['复制全文', '导出 Word', '导出 PDF']],
      [
        {
          kind: 'lecture_deck',
          title: '冬季健康',
          slides: [{ title: '保暖', bullets: ['戴帽子'], notes: '' }],
        },
        'lecture-deck',
        ['导出 PPTX'],
      ],
      [
        { kind: 'community_post', paragraphs: ['今天聊睡眠。'], interaction: '' },
        'community-post',
        ['复制全文'],
      ],
    ];
    for (const [structured, skillId, expected] of cases) {
      const { unmount } = render(
        <ArtifactView
          detail={approved(structured, skillId)}
          readOnly={false}
          onDetail={() => {}}
          onReload={() => {}}
          onOpen={() => {}}
          onChanged={() => {}}
          onReadOnly={() => {}}
          onBack={() => {}}
        />,
      );
      expect(labels(), skillId).toEqual(expected);
      unmount();
    }
  });
});
