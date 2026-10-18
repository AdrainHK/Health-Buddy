import { readFileSync } from 'node:fs';
import { expertOpinionSchema, findBannedTerms } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import { EXPERT_EVAL_TARGET } from './eval-types.js';
import { EXPERT_SNAPSHOTS } from './eval-fixtures.js';
import { routingEvalCases, synthesisEvalCases } from './engine-evals.js';
import {
  CARDS_MAX_CHARS,
  assertPublishable,
  parseExpertMd,
  parseSourcesMd,
  statusAllowed,
  type ExpertDefinition,
} from './framework.js';
import { buildConsultationInput, knownNumbers } from './input.js';
import { consultationDigest, renderConsultationSections, renderOpinion } from './opinion.js';
import {
  EXPERTS,
  EXPERT_EVAL_CASES,
  availableExperts,
  expertDetail,
  expertSummary,
  toProfile,
} from './registry.js';

const IDS = [
  'endocrine-metabolism',
  'cardiovascular',
  'nutrition',
  'exercise-rehab',
  'mental-health',
  'lab-interpretation',
];

describe('expert registry', () => {
  it('registers the first six experts in routing order', () => {
    expect(EXPERTS.map((e) => e.meta.id)).toEqual(IDS);
  });

  it('keeps every expert in review until the medical adviser confirms sources (Q1, Q2)', () => {
    for (const e of EXPERTS) {
      expect(e.meta.status).toBe('review');
      expect(e.sources.signOff).toBeNull();
      expect(e.sources.sources.length).toBeGreaterThan(0);
      expect(e.sources.sources.every((s) => s.status === 'candidate')).toBe(true);
      // 没有顾问写的卡片之前不放任何卡片，更不放凭记忆写的数值
      expect(e.sources.cards).toEqual([]);
    }
  });

  it('hides review experts outside preview and paused experts everywhere', () => {
    expect(availableExperts({ preview: false, paused: new Set() })).toEqual([]);
    const preview = availableExperts({ preview: true, paused: new Set(['nutrition']) });
    expect(preview.map((e) => e.meta.id)).toEqual(IDS.filter((id) => id !== 'nutrition'));
    expect(statusAllowed('published', false)).toBe(true);
    expect(statusAllowed('draft', true)).toBe(false);
    expect(statusAllowed('retired', true)).toBe(false);
  });

  it('names, taglines and expert prompts contain no banned terms', () => {
    for (const e of EXPERTS) {
      expect(findBannedTerms(e.meta.name)).toEqual([]);
      expect(findBannedTerms(e.meta.tagline)).toEqual([]);
      expect(findBannedTerms(e.prompt)).toEqual([]);
      expect(e.strengths.length).toBeGreaterThan(2);
      expect(e.outOfScope.length).toBeGreaterThan(1);
    }
  });

  it('builds the engine profile with shared rules first and no citable cards yet', () => {
    const endo = EXPERTS[0] as ExpertDefinition;
    const profile = toProfile(endo, { preview: true });
    expect(profile.systemPrompt.startsWith('你是 Health Buddy 平台上的一位 AI 专家')).toBe(true);
    expect(profile.systemPrompt).toContain('## 禁止事项');
    expect(profile.systemPrompt).toContain('目前没有可以引用的条目卡片');
    expect(profile.cards).toEqual([]);
    expect(profile.indicatorCodes).toContain('fpg');
    expect(toProfile(EXPERTS[5] as ExpertDefinition, { preview: true }).indicatorCodes).toEqual([
      '*',
    ]);
    expect(profile.sourcesVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('shows unconfirmed sources without publisher or version (spec 5.2.4)', () => {
    const detail = expertDetail(
      EXPERTS[0] as ExpertDefinition,
      {
        preview: true,
        paused: new Set(),
      },
      2,
    );
    expect(detail.sourcesPending).toBe(true);
    expect(detail.myUsageCount).toBe(2);
    expect(detail.sources.every((s) => s.publisher === null && s.version === null)).toBe(true);
    const summary = expertSummary(EXPERTS[0] as ExpertDefinition, {
      preview: false,
      paused: new Set(),
    });
    expect(summary.available).toBe(false);
  });

  it('has a starter eval set for every expert, five or more each (target 15)', () => {
    expect(EXPERT_EVAL_TARGET).toBe(15);
    for (const id of IDS) {
      const cases = EXPERT_EVAL_CASES[id] ?? [];
      expect(cases.length).toBeGreaterThanOrEqual(5);
      expect(cases.every((c) => c.expertId === id)).toBe(true);
      expect(cases.some((c) => c.category === 'boundary' || c.category === 'out_of_scope')).toBe(
        true,
      );
    }
    const crisis = (EXPERT_EVAL_CASES['mental-health'] ?? []).filter(
      (c) => c.category === 'crisis',
    );
    expect(crisis.length).toBeGreaterThanOrEqual(5);
    const ids = Object.values(EXPERT_EVAL_CASES).flatMap((cs) => cs.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(routingEvalCases.length).toBeGreaterThanOrEqual(5);
    for (const c of synthesisEvalCases)
      for (const o of c.opinions)
        expect(expertOpinionSchema.safeParse(o.opinion).success).toBe(true);
  });
});

const EXPERT_MD = (status: string, extra = '') => `---
id: sample-expert
name: 示例专家
tagline: 只用于单元测试的示例专家
version: 1.0.0
status: ${status}
indicatorCodes: fpg, tg
historyCategories: lifestyle
${extra}---

## 角色
示例。
## 擅长的问题
- 甲
## 不负责的问题和转介去向
- 乙
## 分析流程
示例。
## 输出要求
示例。
## 禁止事项
示例。
`;

const SOURCES_MD = (signOff: string, status: string, cardConfirm: string) => `# 示例

> 顾问签字：${signOff}

| sourceId | 名称 | 发布机构 | 版本或年份 | 适用范围 | 确认状态 | 确认人 | 确认日期 |
|---|---|---|---|---|---|---|---|
| S1 | 示例来源 | 示例机构 | 示例版本 | 成人 | ${status} | ${status === '已确认' ? '顾问A' : '—'} | ${status === '已确认' ? '2026-10-20' : '—'} |

## 条目卡片

### S1-01
- 来源：S1，第 1 章
- 要点：示例要点。
- 可引用数值：7.0 mmol/L
- 适用人群：成人
- 确认：${cardConfirm}
`;

describe('expert.md and sources.md parsing', () => {
  it('validates frontmatter, banned terms and section order', () => {
    expect(parseExpertMd(EXPERT_MD('review')).meta).toMatchObject({
      id: 'sample-expert',
      indicatorCodes: ['fpg', 'tg'],
      maxOutputTokens: 1500,
    });
    expect(() => parseExpertMd(EXPERT_MD('live'))).toThrow('元数据不合法');
    expect(() => parseExpertMd(EXPERT_MD('review').replace('示例专家', '诊断专家'))).toThrow();
    expect(() =>
      parseExpertMd(EXPERT_MD('review').replace('indicatorCodes: fpg, tg', 'indicatorCodes: tsh')),
    ).toThrow();
    expect(() => parseExpertMd(EXPERT_MD('review').replace('## 禁止事项', '## 其他'))).toThrow(
      '禁止事项',
    );
  });

  it('only confirms cards with a confirmer, a date and a confirmed source', () => {
    const confirmed = parseSourcesMd(
      SOURCES_MD('顾问A，2026-10-20', '已确认', '顾问A，2026-10-20'),
    );
    expect(confirmed.signOff).toBe('顾问A，2026-10-20');
    expect(confirmed.cards[0]).toMatchObject({ confirmed: true, numbers: [7] });
    const candidate = parseSourcesMd(SOURCES_MD('未签字', '候选', '顾问A，2026-10-20'));
    expect(candidate.signOff).toBeNull();
    expect(candidate.cards[0]?.confirmed).toBe(false);
    const unsigned = parseSourcesMd(SOURCES_MD('顾问A，2026-10-20', '已确认', '待确认'));
    expect(unsigned.cards[0]?.confirmed).toBe(false);
    expect(() =>
      parseSourcesMd(SOURCES_MD('', '已确认', '').replace('| 顾问A |', '| — |')),
    ).toThrow('缺少确认人');
  });

  it('fails the build when cards exceed the prompt budget', () => {
    const long = SOURCES_MD('', '候选', '').replace('示例要点。', '长'.repeat(CARDS_MAX_CHARS));
    expect(() => parseSourcesMd(long)).toThrow('超过');
  });

  it('refuses to publish without confirmed sources, sign-off and confirmed eval cards (spec 5.4)', () => {
    const def = (sources: string): ExpertDefinition => {
      const md = parseExpertMd(EXPERT_MD('published'));
      return {
        meta: md.meta,
        prompt: md.body,
        strengths: [],
        outOfScope: [],
        sources: parseSourcesMd(sources),
      };
    };
    expect(() => assertPublishable(def(SOURCES_MD('未签字', '候选', '')), [])).toThrow(
      '没有已确认的来源',
    );
    const ok = def(SOURCES_MD('顾问A，2026-10-20', '已确认', '顾问A，2026-10-20'));
    expect(() => assertPublishable(ok, ['S1-01'])).not.toThrow();
    expect(() => assertPublishable(ok, ['S1-02'])).toThrow('S1-02');
  });

  it('keeps candidate cards out of production profiles but lets preview cite them', () => {
    const md = parseExpertMd(EXPERT_MD('review'));
    const sources = parseSourcesMd(SOURCES_MD('未签字', '候选', '待确认'));
    const def: ExpertDefinition = {
      meta: md.meta,
      prompt: md.body,
      strengths: [],
      outOfScope: [],
      sources,
    };
    expect(toProfile(def, { preview: false }).cards).toEqual([]);
    const preview = toProfile(def, { preview: true });
    expect(preview.cards).toEqual([{ cardId: 'S1-01', sourceId: 'S1', numbers: [7] }]);
    expect(preview.systemPrompt).toContain('S1-01（来源待确认）');
  });

  it('ships sources.md files that parse and mark every candidate as unverified', () => {
    for (const id of IDS) {
      const text = readFileSync(new URL(`./${id}/sources.md`, import.meta.url), 'utf8');
      expect(text).toContain('待核实');
      expect(text).toContain('顾问签字：未签字');
    }
  });
});

describe('consultation input', () => {
  it('removes names, phones and ID numbers from the assembled prompt (spec 7.2.4)', () => {
    const client = {
      ...EXPERT_SNAPSHOTS.singleAbnormal,
      healthHistory: [
        { category: 'lifestyle' as const, content: '测试客户丙每周游泳，电话 13900001111。' },
      ],
    };
    const input = buildConsultationInput({
      client,
      question:
        '测试客户丙（身份证 110101199001011234，电话 139 0000 1111）的血糖怎么看？张阿姨很担心。',
      identifiers: ['测试客户丙', '张某某'],
    });
    for (const leaked of [
      '测试客户丙',
      '110101199001011234',
      '13900001111',
      '139 0000 1111',
      '张阿姨',
    ]) {
      expect(input.userContent).not.toContain(leaked);
      expect(input.request).not.toContain(leaked);
    }
    expect(input.userContent).toContain('该客户');
    expect(input.flaggedIndicators).toEqual([{ code: 'fpg', direction: 'high' }]);
    expect(input.historyCategories).toEqual(['lifestyle']);
  });

  it('collects input numbers including report references, previous values and differences', () => {
    const nums = knownNumbers(EXPERT_SNAPSHOTS.singleAbnormal);
    for (const n of [6.5, 3.9, 6.1, 5.9, 0.6, 5200]) expect(nums).toContain(n);
  });

  it('detects crisis and emergency signals by keyword, including earlier messages', () => {
    const crisis = buildConsultationInput({
      client: null,
      question: '请看看',
      identifiers: [],
      earlierTexts: ['客户说不想拖累家人了'],
    });
    expect(crisis.crisisDetected).toBe(true);
    const emergency = buildConsultationInput({
      client: null,
      question: '客户昨天晕厥了一次',
      identifiers: [],
    });
    expect(emergency.emergencyDetected).toBe(true);
    expect(emergency.userContent).toContain('没有关联客户');
  });
});

describe('rendering for managers only', () => {
  const opinion = {
    inScope: true,
    outOfScopeNote: null,
    summary: '空腹血糖 6.5 mmol/L 高于报告参考范围。',
    findings: [
      {
        point: '比上次上升。',
        basis: 'data_only' as const,
        dataRefs: [{ label: '空腹血糖', value: '6.5 mmol/L', date: '2026-09-12' }],
        citations: [],
      },
    ],
    suggestions: [{ text: '建议复测。', citations: [] }],
    referral: { needed: true, urgency: 'attention' as const, to: '内分泌科医生', reason: null },
    questionsToAsk: [],
    dataGaps: [],
    crisisSignal: true,
    emergencySignal: false,
  };

  it('puts the crisis notice first and the expert disclaimer last', () => {
    const text = renderOpinion(opinion, { removedFindings: 1 });
    expect(text.startsWith('**心理危机提示**')).toBe(true);
    expect(text.endsWith('仅供健管师专业参考，非医疗诊断，请勿直接转发给客户')).toBe(true);
    expect(text).toContain('部分内容因依据无法核实已移除');
  });

  it('renders the interpretation sections and keeps mental-health opinions out of the digest', () => {
    const sections = renderConsultationSections(
      null,
      [{ expertId: 'endocrine-metabolism', opinion }],
      (id) => (id === 'endocrine-metabolism' ? '内分泌与代谢专家' : id),
      { synthesisFailed: false },
    );
    expect(sections).toContain('## 专家意见汇总');
    expect(sections).toContain('## 专家分歧');
    expect(sections).toContain('已调用：内分泌与代谢专家');
    expect(renderConsultationSections(null, [], (id) => id, { synthesisFailed: false })).toContain(
      '本次未能取得专家意见',
    );
    const digest = consultationDigest(
      [
        { expertId: 'nutrition', opinion },
        { expertId: 'mental-health', opinion: { ...opinion, summary: '情绪低落需要关注。' } },
      ],
      (id) => id,
    );
    expect(digest).toContain('### nutrition');
    expect(digest).not.toContain('情绪低落');
  });
});
