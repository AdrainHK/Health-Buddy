import { describe, expect, it } from 'vitest';
import {
  findCompanionVerbatim,
  companionFreeTexts,
  companionPoints,
  describeCompanionDigest,
  previewText,
  redactCompanionDigest,
  type CompanionDigest,
} from './companion-context.js';
import { askSystemPrompt, buildAskUserContent } from './ask.js';
import { TWIN_SNAPSHOTS } from './twin-fixtures.js';
import { visitScript } from './visit-script/index.js';

/** 伴侣“福宝”的信息（M6 规格 2.7、2.8）。全部是合成数据 */
const DIGEST: CompanionDigest = {
  days: 14,
  observations: [
    { category: 'sleep', count: 3, negative: 2, examples: ['王合成说夜里醒两三次'] },
    { category: 'diet', count: 1, negative: 0, examples: ['客户说晚饭吃了杂粮饭'] },
  ],
  checkins: [
    { kind: 'medication', metric: null, done: 10, partial: 0, missed: 2, noResponse: 2 },
    { kind: 'measurement', metric: 'bp', done: 5, partial: 1, missed: 0, noResponse: 0 },
  ],
  openHandoffs: [
    {
      category: 'medication',
      createdOn: '2026-10-28',
      preview: '药物能不能少吃一点',
      overdue: true,
    },
  ],
};

describe('伴侣信息', () => {
  it('提示词资料：条数、原句、打卡次数、未处理的转交；没有开通时写明', () => {
    const text = describeCompanionDigest(DIGEST);
    expect(text).toContain('睡眠：3 条（消极 2 条）');
    expect(text).toContain('  - 王合成说夜里醒两三次');
    expect(text).toContain('服药：共 14 次提醒，完成 10 次，没做 2 次，未应答 2 次');
    expect(text).toContain('测量血压：共 6 次提醒，完成 5 次，部分完成 1 次');
    expect(text).toContain('用药 · 2026-10-28（已超时）：药物能不能少吃一点');
    expect(describeCompanionDigest(null)).toContain('客户没有开通伴侣“福宝”');
  });

  it('给健管师的要点只有条数和次数，不写原句和转交原话', () => {
    const points = companionPoints(DIGEST).join('\n');
    expect(points).toContain('睡眠 3 条（消极 2 条），饮食 1 条');
    expect(points).toContain('未处理的转交：1 个（用药），其中 1 个已超时');
    expect(points).not.toContain('夜里醒');
    expect(points).not.toContain('少吃一点');
    expect(companionPoints(null)).toEqual(['- 客户没有开通伴侣“福宝”']);
  });

  it('去标识、危机关键词用的自由文字、原话截断', () => {
    const redacted = redactCompanionDigest(DIGEST, (t) => t.replace('王合成', '该客户'))!;
    expect(redacted.observations[0]!.examples[0]).toBe('该客户说夜里醒两三次');
    expect(companionFreeTexts(DIGEST)).toContain('药物能不能少吃一点');
    expect(companionFreeTexts(null)).toEqual([]);
    expect(previewText('一'.repeat(40))).toBe(`${'一'.repeat(30)}…`);
    // 转交原话的药名换成“药物”
    expect(previewText('氨氯地平能不能少吃一点')).toBe('药物能不能少吃一点');
  });

  it('/随访话术：有伴侣资料时用户消息带资料和规则，草稿的要点由后端写', () => {
    const input = {
      client: TWIN_SNAPSHOTS.stable,
      managerRequest: '请为这次随访准备话术',
      companion: DIGEST,
    };
    const msg = visitScript.buildUserMessage(input);
    expect(msg).toContain('伴侣“福宝”收集的信息');
    expect(msg).toContain('不复述客户的原话');
    expect(visitScript.buildUserMessage({ ...input, companion: undefined })).not.toContain(
      '伴侣“福宝”',
    );
    const out = visitScript.render(
      {
        summary: { changes: [], adherence: [], followUps: [], agreements: [] },
        opening: '您好',
        questions: [],
        encouragement: [],
        adjustments: [],
        reminders: [],
        notes: [],
        crisisSignal: false,
      },
      input,
    );
    expect(out.professional).toContain('**伴侣对话要点**\n- 收集信息（近 14 天）：睡眠 3 条');
    expect(out.professional).not.toContain('夜里醒');
  });

  it('问一问：带伴侣资料时用户消息和系统提示词都有', () => {
    const extras = { companion: DIGEST };
    expect(buildAskUserContent(TWIN_SNAPSHOTS.stable, '睡得怎么样', extras)).toContain(
      '王合成说夜里醒两三次',
    );
    expect(askSystemPrompt(TWIN_SNAPSHOTS.stable, extras)).toContain('伴侣“福宝”的信息');
    expect(askSystemPrompt(TWIN_SNAPSHOTS.stable)).not.toContain('伴侣“福宝”的信息');
  });

  it('复述原话（连续 8 个字相同）能查出，概括的说法不算', () => {
    expect(findCompanionVerbatim(['福宝说：客户说晚饭吃了杂粮饭。'], DIGEST)).not.toBeNull();
    expect(findCompanionVerbatim(['福宝记录到近期几次提到夜里醒'], DIGEST)).toBeNull();
    expect(findCompanionVerbatim(['药物能不能少吃一点'], DIGEST)).not.toBeNull();
    expect(findCompanionVerbatim(['任何文字'], null)).toBeNull();
  });
});
