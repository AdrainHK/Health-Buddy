import { describe, expect, it } from 'vitest';
import { brandColorContrastOk, brandDarkVariant, contrastRatio } from '../brand-color.js';
import { brandContentIssues, updateBrandRequestSchema } from './brand.js';

describe('协会主色（M7 规格 2.2）', () => {
  it('对比度按 WCAG 计算；和白色不足 4.5:1 的主色不能用', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(brandColorContrastOk('#0e7c6b')).toBe(true);
    expect(brandColorContrastOk('#ffcc00')).toBe(false);
    expect(brandColorContrastOk('red')).toBe(false);
  });

  it('深色模式的主色在深色背景和深色按钮文字上都够清楚', () => {
    for (const c of ['#0e7c6b', '#1d4ed8', '#7c2d12', '#000000']) {
      const dark = brandDarkVariant(c);
      expect(contrastRatio(dark, '#0e1311')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark, '#06120f')).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('品牌保存请求', () => {
  it('空字符串当作不设置；含禁用词、对比度不够时标出字段', () => {
    const v = updateBrandRequestSchema.parse({
      displayName: '  ',
      primaryColor: '#FFCC00',
      loginGreeting: '欢迎来到慢病根治中心',
    });
    expect(v).toEqual({
      displayName: null,
      primaryColor: '#ffcc00',
      loginGreeting: '欢迎来到慢病根治中心',
    });
    expect(brandContentIssues(v)).toEqual([
      { field: 'loginGreeting', reason: 'banned_term' },
      { field: 'primaryColor', reason: 'low_contrast' },
    ]);
    expect(
      updateBrandRequestSchema.safeParse({
        displayName: 'x'.repeat(21),
        primaryColor: null,
        loginGreeting: null,
      }).success,
    ).toBe(false);
    expect(
      updateBrandRequestSchema.safeParse({
        displayName: null,
        primaryColor: 'url(x)',
        loginGreeting: null,
      }).success,
    ).toBe(false);
  });
});

describe('绕过禁用词检查（合规审查 B1、S4）', () => {
  it('含看不见的格式字符（LRM、RLO、变体选择符）时直接拒绝', () => {
    for (const text of ['诊\u200E断', '\u202E断诊', '治\uFE0F愈', '合成\u0007协会']) {
      expect(
        updateBrandRequestSchema.safeParse({
          displayName: null,
          primaryColor: null,
          loginGreeting: text,
        }).success,
      ).toBe(false);
      expect(
        updateBrandRequestSchema.safeParse({
          displayName: text,
          primaryColor: null,
          loginGreeting: null,
        }).success,
      ).toBe(false);
    }
  });

  it('显示名称不能包含产品名', () => {
    const v = updateBrandRequestSchema.parse({
      displayName: 'health buddy 协会',
      primaryColor: null,
      loginGreeting: null,
    });
    expect(brandContentIssues(v)).toEqual([{ field: 'displayName', reason: 'product_name' }]);
  });
});
