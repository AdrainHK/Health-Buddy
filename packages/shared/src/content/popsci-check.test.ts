import { describe, expect, it } from 'vitest';
import { contentRulesSchema } from '../api/content-rules.js';
import { popsciContentSchema, type PopsciContent } from '../api/popsci.js';
import {
  POPSCI_DEFAULT_RULES,
  checkPopsciContent,
  hasForbiddenHits,
  hasReviewHits,
} from './popsci-check.js';

/** M8 规格 2.3：科普的确定性合规检查。全部是合成文字 */

const article = (body: string, extra: Partial<PopsciContent> = {}): PopsciContent =>
  popsciContentSchema.parse({
    kind: 'popsci_article',
    title: '冬季怎样管理血压',
    sections: [
      { heading: '天冷要保暖', body: '出门注意保暖，避免突然受凉。' },
      { heading: '规律作息', body },
    ],
    summary: '',
    ...extra,
  });

const check = (c: PopsciContent) => checkPopsciContent(c, POPSCI_DEFAULT_RULES);

describe('科普合规检查', () => {
  it('默认规则符合规则 schema', () => {
    expect(contentRulesSchema.safeParse(POPSCI_DEFAULT_RULES).success).toBe(true);
  });

  it('干净的内容没有命中', () => {
    expect(check(article('每天按时睡觉，适量活动。'))).toEqual([]);
  });

  it('验收 4：“治愈”“100% 有效”是禁止类，标出第几节', () => {
    const hits = check(article('坚持这样做可以治愈，100%有效。'));
    expect(hasForbiddenHits(hits)).toBe(true);
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'builtin_banned',
          term: '治愈',
          location: { field: 'body', index: 1, item: null },
        }),
        expect.objectContaining({ ruleId: 'efficacy_promise', term: '100%有效' }),
      ]),
    );
    // 禁止类排在前面
    expect(hits[0]!.category).toBe('forbid');
  });

  it('繁体、全角、插空格和零宽字符拆开的词照样拦下', () => {
    for (const body of ['可以根 治', '可以根​治', '可以根·治', '保　證有效', '立竿見影']) {
      expect(hasForbiddenHits(check(article(body))), body).toBe(true);
    }
  });

  it('看不见的格式字符是禁止类', () => {
    const hits = check(article('每天按时⁦睡觉'));
    expect(hits.map((h) => h.ruleId)).toContain('builtin_invisible');
  });

  it('前面紧挨着否定说法时不算：“不能代替药物”“请勿停药”“千万不要擅自停药”', () => {
    for (const body of [
      '生活方式调整不能代替药物治疗。',
      '生活方式并不能完全代替药物。',
      '谁也不能保证有效。',
      '千万不要随意代替药物。',
    ]) {
      expect(hasForbiddenHits(check(article(body))), body).toBe(false);
    }
    // “请勿停药”“不要擅自停药”是正常提醒：只要求核对，不禁止
    expect(hasForbiddenHits(check(article('请勿擅自停药。')))).toBe(false);
  });

  it('合规审查 B1：否定字只是挨得近、隔着标点或双重否定时照样拦下', () => {
    for (const body of [
      '绝不骗你，保证有效',
      '无论如何保证见效',
      '没想到立竿见影',
      '不少人可以停药',
      '没问题，可以停药',
      '不满意无效退款',
      '不仅最有效还便宜',
      '不是不可以停药',
      '没有不可以停药的',
      '血压平稳了就可以停药。',
      '不要说自己可以停药，其实可以停药。',
    ]) {
      expect(hasForbiddenHits(check(article(body))), body).toBe(true);
    }
  });

  it('合规审查 B2、S2：单字的绝对化用语和停药说法要核对；短语形式禁止', () => {
    for (const body of ['最好在医生指导下运动', '第一页先讲保暖', '保证睡眠', '根除幽门螺杆菌']) {
      const hits = check(article(body));
      expect(hasForbiddenHits(hits), body).toBe(false);
      expect(
        hits.map((h) => h.ruleId),
        body,
      ).toContain('wording_review');
    }
    for (const body of [
      '这是最好的方法',
      '第一品牌',
      '唯一的办法',
      '效果最佳',
      '直接停药',
      '代替降压药',
    ]) {
      expect(hasForbiddenHits(check(article(body))), body).toBe(true);
    }
  });

  it('合规审查 S1：表情符号里的变体选择符和连接符、回车换行不算看不见的字符', () => {
    expect(check(article('多晒太阳☀️，心情好❤️\r\n早点睡👨‍👩‍👧'))).toEqual([]);
    expect(check(article('根\uFE0F本'))).toEqual([
      expect.objectContaining({ ruleId: 'builtin_invisible' }),
    ]);
  });

  it('合规审查 S3：引用说法拆开写、其他引用说法和剂量照样标出', () => {
    const hits = check(article('研 究表明多喝水好。世界卫生组织建议每天两片，或 400 IU。'));
    const terms = hits.filter((h) => h.ruleId === 'builtin_citation').map((h) => h.term);
    expect(terms).toEqual(expect.arrayContaining(['研究表明', '世界卫生组织', '两片', '400IU']));
  });

  it('验收 5：疾病名称、药名、具体数字和引用是“需要人工判断”', () => {
    const hits = check(
      article('高血压患者服用降压药要遵医嘱。研究表明，每天少吃 2 克盐，血压可降 5%。'),
    );
    expect(hasForbiddenHits(hits)).toBe(false);
    expect(hasReviewHits(hits)).toBe(true);
    const ids = hits.map((h) => h.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining(['disease_names', 'builtin_drug', 'builtin_citation']),
    );
    const terms = hits.filter((h) => h.ruleId === 'builtin_citation').map((h) => h.term);
    expect(terms).toEqual(expect.arrayContaining(['研究表明', '5%', '2克']));
  });

  it('免责声明里的“诊断”不算违规', () => {
    expect(check(article('仅供参考，非医疗诊断'))).toEqual([]);
  });

  it('PPT 标出第几页第几条要点；社群稿标出第几段', () => {
    const deck = popsciContentSchema.parse({
      kind: 'lecture_deck',
      title: '老年人冬季健康',
      slides: [
        { title: '开场', bullets: ['大家好'], notes: '' },
        { title: '要点', bullets: ['注意保暖', '效果最好的办法'], notes: '' },
      ],
    });
    expect(check(deck)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'absolute_terms',
          category: 'forbid',
          location: { field: 'bullet', index: 1, item: 1 },
        }),
      ]),
    );
    const post = popsciContentSchema.parse({
      kind: 'community_post',
      paragraphs: ['今天聊聊睡眠。', '这款保健品很好。'],
      interaction: '你每天睡几个小时？',
    });
    expect(check(post)).toEqual([
      expect.objectContaining({
        ruleId: 'products',
        category: 'review',
        location: { field: 'paragraph', index: 1, item: null },
      }),
    ]);
  });

  it('后台词表的新词在下一次检查生效', () => {
    const rules = [
      ...POPSCI_DEFAULT_RULES,
      {
        id: 'custom',
        category: 'forbid' as const,
        label: '自定义',
        reason: '合成规则',
        terms: ['神奇'],
        negatable: false,
      },
    ];
    expect(checkPopsciContent(article('神奇的方法'), rules)[0]).toMatchObject({ ruleId: 'custom' });
  });

  it('规则 schema：不接受重复 id、builtin_ 开头的 id、看不见的字符', () => {
    const g = POPSCI_DEFAULT_RULES[0]!;
    expect(contentRulesSchema.safeParse([g, g]).success).toBe(false);
    expect(contentRulesSchema.safeParse([{ ...g, id: 'builtin_x' }]).success).toBe(false);
    expect(contentRulesSchema.safeParse([{ ...g, terms: ['保​证'] }]).success).toBe(false);
  });

  it('内容 schema：字段超长或为空时拒绝', () => {
    expect(
      popsciContentSchema.safeParse({ kind: 'community_post', paragraphs: [], interaction: '' })
        .success,
    ).toBe(false);
    expect(
      popsciContentSchema.safeParse({
        kind: 'popsci_article',
        title: '题'.repeat(61),
        sections: [{ heading: 'a', body: 'b' }],
        summary: '',
      }).success,
    ).toBe(false);
  });
});
