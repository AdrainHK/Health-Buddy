import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expertOpinionSchema, findBannedTerms } from '@health-buddy/shared';
import { TWIN_SNAPSHOTS } from '@health-buddy/skills';
import { describe, expect, it } from 'vitest';
import { EXPERT_EVAL_TARGET } from './eval-types.js';
import { EXPERT_SNAPSHOTS } from './eval-fixtures.js';
import { routingEvalCases, synthesisEvalCases } from './engine-evals.js';
import {
  CARDS_MAX_CHARS,
  assertPublishable,
  loadExpert,
  parseExpertMd,
  parseSourcesMd,
  statusAllowed,
  type ExpertDefinition,
} from './framework.js';
import { buildConsultationInput, detectEmergencyKeywords, knownNumbers } from './input.js';
import {
  consultationDigest,
  expertMentions,
  withoutQuantities,
  renderConsultationSections,
  renderOpinion,
} from './opinion.js';
import {
  EXPERTS,
  EXPERT_EVAL_CASES,
  availableExperts,
  expertDetail,
  expertName,
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

const SOURCES_MD = (
  signOff: string,
  status: string,
  cardConfirm: string,
  scope: 'advice' | 'referral_only' = 'advice',
) => `# 示例

> 顾问签字：${signOff}

| sourceId | 文件名 | 颁布机构 | 版本 | 优先级 | 使用范围 | 确认状态 | 确认人 | 确认日期 |
|---|---|---|---|---|---|---|---|---|
| S1 | 示例来源 | 示例机构 | 示例版本 | 1级 | ${scope} | ${status} | ${status === '已确认' ? '顾问A' : '—'} | ${status === '已确认' ? '2026-10-20' : '—'} |

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
      maxOutputTokens: 6000,
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
    expect(preview.cards).toEqual([
      { cardId: 'S1-01', sourceId: 'S1', scope: 'advice', numbers: [7] },
    ]);
    expect(preview.systemPrompt).toContain('S1-01（来源待确认）');
    expect(preview.systemPrompt).toContain('来源：S1（1级）');
  });

  it('lists referral_only cards apart from citable ones and keeps their scope on the profile', () => {
    const md = parseExpertMd(EXPERT_MD('review'));
    const def: ExpertDefinition = {
      meta: md.meta,
      prompt: md.body,
      strengths: [],
      outOfScope: [],
      sources: parseSourcesMd(
        SOURCES_MD('顾问A，2026-10-20', '已确认', '顾问A，2026-10-20', 'referral_only'),
      ),
    };
    const profile = toProfile(def, { preview: false });
    expect(profile.cards).toEqual([
      { cardId: 'S1-01', sourceId: 'S1', scope: 'referral_only', numbers: [7] },
    ]);
    const prompt = profile.systemPrompt;
    // 没有可以引用的卡片：要点只能描述数据；referral_only 的卡片单独列在后面
    expect(prompt).toContain('目前没有可以引用的条目卡片');
    expect(prompt.indexOf('## 只用于判断是否需要转介的卡片')).toBeLessThan(
      prompt.indexOf('### S1-01'),
    );
    // 共用规则写明优先级和冲突处理顺序
    expect(prompt).toContain('1级 国内官方指南＞2级 国内专家共识＞3级 国际学会指南＞4级 兜底细则');
    expect(prompt).toContain('3级国际学会指南只作对标参考');
    const detail = expertDetail(def, { preview: false, paused: new Set() }, 0);
    expect(detail.sources[0]).toMatchObject({ priority: 1, scope: 'referral_only', section: null });
    expect(detail.cards[0]).toMatchObject({ cardId: 'S1-01', scope: 'referral_only' });
  });

  it('rejects banned terms in strengths and out-of-scope items shown on the expert page', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-expert-'));
    try {
      const dir = join(root, 'nutrition');
      cpSync(new URL('./nutrition/', import.meta.url), dir, { recursive: true });
      const file = join(dir, 'expert.md');
      const md = readFileSync(file, 'utf8');
      writeFileSync(file, md.replace('## 擅长的问题\n\n', '## 擅长的问题\n\n- 代谢疾病筛查\n'));
      expect(() => loadExpert(pathToFileURL(`${dir}/`))).toThrow(/擅长的问题含禁用词/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never lets anyone cite cards of a retired source, even in preview', () => {
    const md = parseExpertMd(EXPERT_MD('review'));
    const def: ExpertDefinition = {
      meta: md.meta,
      prompt: md.body,
      strengths: [],
      outOfScope: [],
      sources: parseSourcesMd(SOURCES_MD('未签字', '已停用', '待确认')),
    };
    expect(toProfile(def, { preview: true }).cards).toEqual([]);
    expect(expertDetail(def, { preview: true, paused: new Set() }, 0).cards).toEqual([]);
  });

  it("ships the product owner's lists, unverified and unsigned, with no cards yet", () => {
    for (const id of IDS) {
      const text = readFileSync(new URL(`./${id}/sources.md`, import.meta.url), 'utf8');
      const doc = parseSourcesMd(text);
      expect(text).toContain('顾问签字：未签字');
      expect(text).toContain('> 状态：待医学顾问核实');
      expect(doc.signOff).toBeNull();
      expect(doc.provenance).toMatch(/^产品负责人提供 2026-10-18/);
      expect(doc.cards).toEqual([]);
      expect(doc.sources.length).toBeGreaterThan(0);
      for (const src of doc.sources) {
        expect(src.status).toBe('candidate');
        expect(src.confirmedBy).toBeNull();
        expect(src.section).toMatch(/^[一二三四五六七八九十]+、/);
        expect(src.publisher).not.toBeNull();
        expect(src.version).not.toBeNull();
      }
      // 每份清单都同时有可以作为建议依据的来源和只用于转介判断的来源
      expect(doc.sources.some((s) => s.scope === 'advice')).toBe(true);
      expect(doc.sources.some((s) => s.scope === 'referral_only')).toBe(true);
    }
    // 抽查原样抄录：跨行折断的文件名、颁布机构和版本已经接回整行
    const endocrine = parseSourcesMd(
      readFileSync(new URL('./endocrine-metabolism/sources.md', import.meta.url), 'utf8'),
    );
    expect(endocrine.sources).toHaveLength(67);
    expect(endocrine.sources.find((s) => s.name === '中国高尿酸血症与痛风诊疗指南')).toMatchObject({
      section: '三、高尿酸血症与痛风',
      publisher: 'CSE',
      version: '2019主指南+2024合并症补充版',
      priority: 1,
    });
    expect(
      endocrine.sources.find((s) => s.name === '经皮冠状动脉介入治疗（PCI）指南'),
    ).toBeUndefined();
    const nutrition = parseSourcesMd(
      readFileSync(new URL('./nutrition/sources.md', import.meta.url), 'utf8'),
    );
    // 文件名和颁布机构都折行的一行、跨页折断的颁布机构
    expect(nutrition.sources[0]).toMatchObject({
      name: '中国成人患者肠外肠内营养临床应用指南',
      publisher: '中华医学会肠外肠内营养学分会（CSPEN）',
      version: '2023版',
      priority: 1,
    });
    expect(nutrition.sources.find((s) => s.name === '中国肿瘤患者营养治疗指南')?.publisher).toBe(
      'CSPEN肿瘤营养分会',
    );
    const cardio = parseSourcesMd(
      readFileSync(new URL('./cardiovascular/sources.md', import.meta.url), 'utf8'),
    );
    expect(cardio.sources.find((s) => s.name.includes('PCI'))).toMatchObject({
      scope: 'referral_only',
      priority: 1,
    });
    expect(cardio.sources.find((s) => s.name === '中国高血压防治指南')).toMatchObject({
      publisher: '中华医学会心血管病学分会（CSC）+国家卫健委',
      version: '2024修订版',
      scope: 'advice',
    });
  });

  it('parses priority, scope and section, and rejects rows without them', () => {
    const md = `# 示例

> 顾问签字：未签字
> 来源清单出处：产品负责人提供 2026-10-18

## 来源清单

### 一、糖尿病及并发症（CDS，核心模块）

| sourceId | 文件名 | 颁布机构 | 版本 | 优先级 | 使用范围 | 确认状态 | 确认人 | 确认日期 |
|---|---|---|---|---|---|---|---|---|
| S1 | 中国示例指南 | 示例学会（CDS） | 2024版 | 1级 | advice | 待医学顾问核实 | — | — |
| S2 | 示例用药共识 | 示例学会 | 2019主指南+2024补充版 | 2 级 | referral_only | 候选 | — | — |

### 二、急症

| sourceId | 文件名 | 颁布机构 | 版本 | 优先级 | 使用范围 | 确认状态 | 确认人 | 确认日期 |
|---|---|---|---|---|---|---|---|---|
| S3 | 示例急症共识 | 示例学会 | 2023版 | 4 | referral_only | 已停用 | — | — |
`;
    const doc = parseSourcesMd(md);
    expect(doc.provenance).toBe('产品负责人提供 2026-10-18');
    expect(doc.sources.map((s) => [s.sourceId, s.priority, s.scope, s.status, s.section])).toEqual([
      ['S1', 1, 'advice', 'candidate', '一、糖尿病及并发症'],
      ['S2', 2, 'referral_only', 'candidate', '一、糖尿病及并发症'],
      ['S3', 4, 'referral_only', 'retired', '二、急症'],
    ]);
    expect(doc.sources[1]?.version).toBe('2019主指南+2024补充版');
    // 分组标题不算卡片，也不计入卡片长度
    expect(doc.cards).toEqual([]);
    expect(() => parseSourcesMd(md.replace('| 1级 | advice |', '| 5级 | advice |'))).toThrow(
      '优先级只能是',
    );
    expect(() => parseSourcesMd(md.replace('| 1级 | advice |', '| 1级 | 建议 |'))).toThrow(
      '使用范围只能是',
    );
    expect(() => parseSourcesMd(md.replace('| 1级 | advice |', '| advice |'))).toThrow('列数不对');
    // 卡片跟随来源的优先级和使用范围
    const withCard = parseSourcesMd(
      `${md}\n## 条目卡片\n\n### S2-01\n- 来源：S2，第 1 章\n- 要点：示例。\n- 可引用数值：无\n- 确认：待确认\n`,
    );
    expect(withCard.cards[0]).toMatchObject({
      priority: 2,
      scope: 'referral_only',
      section: '第 1 章',
    });
  });

  const ROW = (priority: string, scope: string) =>
    `| S1 | 示例 | 示例学会 | 2024版 | ${priority} | ${scope} | 候选 | — | — |`;
  const DOC = (heading: string, row: string, extra = '') => `# 示例

## 来源清单

### ${heading}
${extra}
| sourceId | 文件名 | 颁布机构 | 版本 | 优先级 | 使用范围 | 确认状态 | 确认人 | 确认日期 |
|---|---|---|---|---|---|---|---|---|
${row}
`;

  it('keeps 3级 international guidelines referral_only and lets a card only narrow its scope', () => {
    expect(() => parseSourcesMd(DOC('一、示例', ROW('3级', 'advice')))).toThrow('3级国际学会指南');
    expect(parseSourcesMd(DOC('一、示例', ROW('3级', 'referral_only'))).sources[0]?.scope).toBe(
      'referral_only',
    );
    const card = (scope: string) =>
      `\n## 条目卡片\n\n### S1-01\n- 来源：S1，第 2 章\n- 要点：示例。\n- 可引用数值：无\n- 使用范围：${scope}\n- 确认：待确认\n`;
    // advice 来源里的一张卡片可以收窄成 referral_only
    expect(
      parseSourcesMd(DOC('一、示例', ROW('1级', 'advice')) + card('referral_only')).cards[0]?.scope,
    ).toBe('referral_only');
    // referral_only 来源里的卡片不能放宽成 advice
    expect(() =>
      parseSourcesMd(DOC('一、示例', ROW('1级', 'referral_only')) + card('advice')),
    ).toThrow('不能比来源宽');
  });

  it('shows section names without notes, and rejects banned or 决策 wording in shown text (only file names are exempt)', () => {
    const shown = parseSourcesMd(
      DOC('九、心血管急症（AI 急救决策必备，不可缺失）', ROW('1级', 'referral_only')),
    );
    expect(shown.sources[0]?.section).toBe('九、心血管急症');
    expect(() => parseSourcesMd(DOC('九、AI 急救决策', ROW('1级', 'referral_only')))).toThrow(
      '决策',
    );
    expect(() =>
      parseSourcesMd(DOC('六、肿瘤标志物筛查与结果解读', ROW('1级', 'referral_only'))),
    ).toThrow('禁用词');
    // 原标题去掉括号后仍有禁用词时，写“显示名称”
    expect(
      parseSourcesMd(
        DOC(
          '六、肿瘤标志物筛查与结果解读（体检异常重点模块）',
          ROW('1级', 'referral_only'),
          '\n显示名称：六、肿瘤标志物结果解读（说明）\n',
        ),
      ).sources[0]?.section,
    ).toBe('六、肿瘤标志物结果解读');
    // 文件名照原样，可以含禁用词
    expect(
      parseSourcesMd(
        DOC('一、示例', ROW('1级', 'referral_only').replace('| 示例 |', '| 示例诊断标准 |')),
      ).sources[0]?.name,
    ).toBe('示例诊断标准');
    // 卡片的要点和章节不在例外里
    const card = (point: string, ref = '第 2 章') =>
      `\n## 条目卡片\n\n### S1-01\n- 来源：S1，${ref}\n- 要点：${point}\n- 可引用数值：无\n- 确认：待确认\n`;
    const base = DOC('一、示例', ROW('1级', 'advice'));
    expect(() => parseSourcesMd(base + card('定期筛查。'))).toThrow('要点含禁用词');
    expect(() => parseSourcesMd(base + card('示例。', '诊断标准一节'))).toThrow('章节含禁用词');
  });

  it('never puts source file names or section names into prompts or rendered opinions (spec 5.1)', () => {
    const outputs: string[] = [];
    for (const def of EXPERTS) {
      for (const preview of [true, false]) outputs.push(toProfile(def, { preview }).systemPrompt);
      const cited = {
        inScope: true,
        outOfScopeNote: null,
        summary: '示例结论。',
        findings: [
          {
            point: '示例要点。',
            basis: 'cited' as const,
            dataRefs: [],
            citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
          },
        ],
        suggestions: [],
        referral: { needed: false, urgency: null, to: null, reason: null },
        questionsToAsk: [],
        dataGaps: [],
        crisisSignal: false,
        emergencySignal: false,
      };
      outputs.push(renderOpinion(cited, { expertId: def.meta.id }));
      outputs.push(
        renderConsultationSections(
          {
            consensus: [
              {
                point: '示例共识。',
                experts: [def.meta.id],
                citations: cited.findings[0]!.citations,
              },
            ],
            disagreements: [],
            referrals: [],
            followUpPoints: [],
            crisisSignal: false,
            emergencySignal: false,
            missingExperts: [],
          },
          [
            { expertId: def.meta.id, opinion: cited },
            { expertId: 'nutrition', opinion: cited },
          ],
          expertName,
          { synthesisFailed: false },
        ),
      );
    }
    const shown = EXPERTS.flatMap((def) =>
      def.sources.sources.flatMap((s) => [s.name, ...(s.section ? [s.section] : [])]),
    );
    expect(shown.length).toBeGreaterThan(300);
    for (const text of outputs) {
      const leaked = shown.filter((t) => text.includes(t));
      expect(leaked).toEqual([]);
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
    expect(detectEmergencyKeywords(['客户说这两周有几次胸口闷痛'])).toBe(true);
  });
});

describe('twin consultation input (M4 spec 2.6之二, 5.4.6)', () => {
  const twinInput = () =>
    buildConsultationInput({
      client: TWIN_SNAPSHOTS.manualAdjusted,
      question: '王测试的代谢请专家看看，电话 13800001111',
      identifiers: ['王测试'],
      twinRefs: [{ kind: 'domain', code: 'metabolic' }],
    });

  it('removes names and phones from adjust reasons and follow-up notes', () => {
    const input = twinInput();
    for (const leaked of ['王测试', '13800001111', '139 0000 2222', '13900002222']) {
      expect(input.userContent).not.toContain(leaked);
      expect(input.request).not.toContain(leaked);
    }
    expect(input.userContent).toContain('数字孪生');
  });

  it('routes by the referenced twin item instead of the whole report', () => {
    expect(twinInput().flaggedIndicators).toEqual([
      { code: 'tg', direction: 'high', source: 'report' },
    ]);
    const sleep = buildConsultationInput({
      client: TWIN_SNAPSHOTS.manualAdjusted,
      question: '',
      identifiers: [],
      twinRefs: [{ kind: 'domain', code: 'sleep' }],
    });
    expect(sleep.flaggedIndicators).toEqual([
      { code: 'sleep_hours', direction: 'low', source: 'monitoring' },
    ]);
  });

  it('allows forecast numbers computed by the backend', () => {
    const nums = twinInput().allowedNumbers;
    for (const n of [6.1, 4.4, 7.8, 1.9, 6.8]) expect(nums).toContain(n);
  });

  it('detects crisis and emergency keywords in the raw reasons and notes (5.4 第 7 条)', () => {
    const base = TWIN_SNAPSHOTS.manualAdjusted;
    const withText = (reason: string, note: string) => ({
      ...base,
      twin: {
        ...base.twin,
        domains: base.twin.domains.map((d) =>
          d.manual ? { ...d, manual: { ...d.manual, reason } } : d,
        ),
        followUps: base.twin.followUps.map((f) => ({ ...f, note })),
      },
    });
    const crisis = buildConsultationInput({
      client: withText('王测试说最近不想活了', '作息不规律'),
      question: '',
      identifiers: ['王测试'],
      twinRefs: [{ kind: 'domain', code: 'metabolic' }],
    });
    expect(crisis.crisisDetected).toBe(true);
    expect(crisis.userContent).not.toContain('王测试');
    const emergency = buildConsultationInput({
      client: withText('复测正常', '昨晚胸痛，出冷汗'),
      question: '',
      identifiers: [],
      twinRefs: [{ kind: 'domain', code: 'metabolic' }],
    });
    expect(emergency.emergencyDetected).toBe(true);
    expect(twinInput().crisisDetected).toBe(false);
    expect(twinInput().emergencyDetected).toBe(false);
  });

  it('adds the twin judgment checks to opinion validation only when the twin is present', () => {
    const check = twinInput().extraWordingCheck!;
    expect(check('建议将代谢调整为红色。')).toBe(true);
    expect(check('空腹血糖将会继续升高。')).toBe(true);
    expect(check('心血管风险较高。')).toBe(true);
    expect(check('建议了解近期饮食。')).toBe(false);
    const plain = buildConsultationInput({
      client: EXPERT_SNAPSHOTS.homeBpHigh,
      question: '',
      identifiers: [],
    });
    expect(plain.extraWordingCheck).toBeUndefined();
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
    suggestions: [{ text: '建议复测。', category: 'follow_up' as const, citations: [] }],
    referral: { needed: true, urgency: 'attention' as const, to: '内分泌科医生', reason: null },
    questionsToAsk: [],
    dataGaps: [],
    crisisSignal: true,
    emergencySignal: false,
  };

  it('marks citations of cards the adviser has not confirmed', () => {
    const cited = {
      ...opinion,
      crisisSignal: false,
      suggestions: [
        {
          text: '来源中的说法。',
          category: 'follow_up' as const,
          citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
        },
      ],
    };
    expect(renderOpinion(cited, { expertId: 'nutrition' })).toContain(
      '（来源：S1-01（来源待确认））',
    );
  });

  it('shows the referral for out-of-scope opinions that need a doctor', () => {
    const out = {
      ...opinion,
      inScope: false,
      outOfScopeNote: '用药调整不在我的范围内。',
      referral: { needed: true, urgency: 'urgent' as const, to: '急诊', reason: '胸痛' },
    };
    const text = renderOpinion(out, { expertId: 'nutrition' });
    expect(text).toContain('用药调整不在我的范围内。');
    expect(text).toContain('**是否需要转介**');
    expect(text).toContain('急诊');
    expect(renderOpinion({ ...out, referral: { ...out.referral, needed: false } })).not.toContain(
      '是否需要转介',
    );
  });

  it('splits the digest: only lifestyle advice without crisis or emergency signals is rewritable', () => {
    const calm = {
      ...opinion,
      crisisSignal: false,
      suggestions: [
        { text: '晚餐少吃甜食。', category: 'lifestyle' as const, citations: [] },
        { text: '三个月后复查。', category: 'follow_up' as const, citations: [] },
      ],
    };
    const urgent = {
      ...calm,
      emergencySignal: true,
      suggestions: [{ text: '每天快走。', category: 'lifestyle' as const, citations: [] }],
    };
    const digest = consultationDigest(
      [
        { expertId: 'nutrition', opinion: calm },
        { expertId: 'cardiovascular', opinion: urgent },
      ],
      (id) => id,
    );
    const [professional = '', rewritable = ''] = digest.split('第二部分');
    expect(professional).toContain('三个月后复查');
    expect(professional).toContain('转介：建议就医评估，内分泌科医生');
    expect(professional).not.toContain('晚餐少吃甜食');
    expect(rewritable).toContain('- 晚餐少吃甜食。');
    expect(rewritable).not.toMatch(/复查|快走|内分泌科|nutrition/);
    // “需尽快就医”的转介同样不给可改写的建议（M5 规格 2.5）
    const referred = consultationDigest(
      [
        {
          expertId: 'exercise-rehab',
          opinion: {
            ...calm,
            referral: { needed: true, urgency: 'urgent' as const, to: '心内科医生', reason: null },
          },
        },
      ],
      (id) => id,
    );
    expect(referred.split('第二部分')[1]).not.toContain('晚餐少吃甜食');
    // 有信号的意见都没有可改写的建议时写“没有”
    const none = consultationDigest([{ expertId: 'nutrition', opinion }], (id) => id);
    expect(none.split('第二部分')[1]).toContain('（没有）');
  });

  it('finds the word expert and expert names in client text, also when spaced or traditional', () => {
    expect(expertMentions('建议少喝甜饮料。', ['营养专家'])).toEqual([]);
    expect(expertMentions('AI 专家说营养专家建议…', ['营养专家'])).toEqual(['专家', '营养专家']);
    expect(expertMentions('營養 專 家建議', ['营养专家'])).toContain('专家');
    expect(expertMentions('营养\u200b专家', ['营养专家'])).toEqual(['专家', '营养专家']);
  });

  it('keeps numbers of lifestyle advice out of the rewritable part of the digest', () => {
    expect(withoutQuantities('每周 150 分钟中等强度身体活动，每天盐不超过 5 克。')).toBe(
      '每周适量中等强度身体活动，每天盐适量。',
    );
    expect(withoutQuantities('每天走六千步，主食换一部分杂粮。')).toBe(
      '每天走适量，主食换一部分杂粮。',
    );
    expect(withoutQuantities('晚餐少吃甜食。')).toBe('晚餐少吃甜食。');
    const digest = consultationDigest(
      [
        {
          expertId: 'nutrition',
          opinion: {
            ...opinion,
            crisisSignal: false,
            suggestions: [
              {
                text: '来源中的说法是每周 150 分钟中等强度身体活动。',
                category: 'lifestyle' as const,
                citations: [],
              },
            ],
          },
        },
      ],
      (id) => id,
    );
    const [professional = '', rewritable = ''] = digest.split('第二部分');
    expect(professional).toContain('150 分钟');
    expect(rewritable).not.toContain('150');
    expect(rewritable).toContain('每周适量中等强度身体活动');
  });

  it('checks confirmation per expert: the same card number of another expert does not count', () => {
    // 两位专家都没有确认过的卡片；共识只列出其中一位真正引用了它
    const cited = {
      ...opinion,
      crisisSignal: false,
      suggestions: [
        {
          text: '来源中的说法。',
          category: 'follow_up' as const,
          citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
        },
      ],
    };
    const text = renderConsultationSections(
      {
        consensus: [
          {
            point: '共识。',
            experts: ['nutrition', 'cardiovascular'],
            citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
          },
        ],
        disagreements: [],
        referrals: [],
        followUpPoints: [],
        crisisSignal: false,
        emergencySignal: false,
        missingExperts: [],
      },
      [
        { expertId: 'nutrition', opinion: cited },
        { expertId: 'cardiovascular', opinion: { ...cited, suggestions: [] } },
      ],
      (id) => id,
      { synthesisFailed: false },
    );
    expect(text).toContain('S1-01（来源待确认）');
  });

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
