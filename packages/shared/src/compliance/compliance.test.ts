import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  buildClientDeliverable,
  countDisclaimers,
  endsWithDisclaimer,
  findBannedTerms,
} from './index.js';

describe('findBannedTerms', () => {
  it('returns nothing for compliant copy', () => {
    expect(findBannedTerms('坚持快走30分钟，有助于改善血糖控制。')).toEqual([]);
  });

  it('finds every occurrence with its position, in order', () => {
    const issues = findBannedTerms('本产品可以筛查糖尿病，坚持使用可以根治，筛查很准。');
    expect(issues.map((i) => [i.term, i.index])).toEqual([
      ['筛查', 5],
      ['根治', 17],
      ['筛查', 20],
    ]);
  });

  it('allows the standard disclaimer', () => {
    expect(findBannedTerms(`血压偏高，建议复测。${DISCLAIMER}`)).toEqual([]);
  });

  it('still flags 诊断 outside the disclaimer', () => {
    const issues = findBannedTerms(`AI 诊断结果：高血压。${DISCLAIMER}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.term).toBe('诊断');
  });
});

describe('findBannedTerms normalization', () => {
  it('flags terms split by spaces, zero-width characters or line breaks', () => {
    const text = '可以筛 查，也能根\u200B治，还能确\n诊。';
    expect(findBannedTerms(text).map((i) => i.term)).toEqual(['筛查', '根治', '确诊']);
  });

  it('maps positions back to the original text', () => {
    const text = '能 根 治';
    const [issue] = findBannedTerms(text);
    expect(issue?.index).toBe(2);
    expect(text[issue?.index ?? -1]).toBe('根');
  });

  it('still allows the disclaimer written with spaces or full-width punctuation', () => {
    expect(findBannedTerms('血压偏高。仅供参考,非医疗 诊断')).toEqual([]);
  });

  it('flags full-width banned terms in mixed text', () => {
    expect(findBannedTerms('ＡＩ诊断结果').map((i) => i.term)).toEqual(['诊断']);
  });
});

describe('endsWithDisclaimer', () => {
  it('requires the disclaimer at the end', () => {
    expect(endsWithDisclaimer(`建议多走路。\n${DISCLAIMER}\n`)).toBe(true);
    expect(endsWithDisclaimer(`${DISCLAIMER}。建议多走路。`)).toBe(false);
  });
});

describe('findBannedTerms separators and traditional characters', () => {
  it('flags terms split by in-word punctuation', () => {
    expect(findBannedTerms('诊·断、根-治、筛、查').map((i) => i.term)).toEqual([
      '诊断',
      '根治',
      '筛查',
    ]);
  });

  it('flags traditional-character variants', () => {
    expect(findBannedTerms('已確診，可治癒').map((i) => i.term)).toEqual(['确诊', '治愈']);
  });

  it('does not join words across commas or full stops', () => {
    expect(findBannedTerms('扎根，治理。根。治')).toEqual([]);
  });
});

describe('countDisclaimers', () => {
  it('counts spaced and zero-width variants as the same disclaimer', () => {
    expect(countDisclaimers(`正文。\n\n${DISCLAIMER}`)).toBe(1);
    expect(countDisclaimers(`仅供参考 ，非医疗\u200B诊断。正文。\n\n${DISCLAIMER}`)).toBe(2);
  });
});

describe('buildClientDeliverable', () => {
  it('appends the product name after the disclaimer', () => {
    expect(buildClientDeliverable(`正文。\n\n${DISCLAIMER}\n`)).toBe(
      `正文。\n\n${DISCLAIMER}\n\n— Health Buddy`,
    );
  });
});
