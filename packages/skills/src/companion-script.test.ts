import { COMPANION_DEFAULT_SCRIPTS } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import { checkCompanionScript } from './wording.js';

/** M6 伴侣固定话术的保存检查（规格 2.10、合规复审 B1、B2）。正文里的话都是反例 */
describe('checkCompanionScript', () => {
  const categories = (kind: string, text: string) =>
    checkCompanionScript(kind, text).map((i) => i.category);

  it('默认话术全部通过', () => {
    for (const [kind, text] of Object.entries(COMPANION_DEFAULT_SCRIPTS)) {
      expect({ kind, issues: checkCompanionScript(kind, text) }).toEqual({ kind, issues: [] });
    }
  });

  it('疾病判断、数值评价、药名、剂量、功效承诺、孪生和专家都拦', () => {
    expect(categories('handoff', '您的血压偏高，我已经转给健管师了。')).toContain('judgment');
    expect(categories('handoff', '可能是高血压，我已经转给健管师了。')).toContain(
      'presumed_disease',
    );
    expect(categories('fallback', '先别吃降压药了。')).toContain('drug_name');
    expect(categories('reminder_medication', '该吃两片了，吃了吗？')).toContain('drug_advice');
    expect(categories('reminder_exercise', '坚持运动保证降下来。')).toContain('efficacy_claim');
    expect(categories('fallback', '您的孪生状态是红灯。')).toContain('twin_term');
    expect(categories('handoff', '营养专家说可以。')).toContain('judgment');
    expect(categories('handoff', '请去市第一医院挂号。')).toContain('hospital');
    expect(categories('handoff', '我们可以帮您诊断一下。')).toContain('banned_term');
  });

  it('危机、急症、危急指标不许安抚性否认；转交类不许代健管师承诺', () => {
    expect(categories('emergency', '没事的，应该不严重，请拨打 120。')).toContain('reassurance');
    expect(categories('critical_value', '别担心，这个数值需要尽快告诉医生。')).toContain(
      'reassurance',
    );
    expect(categories('handoff', '已经转给健管师，她会给您打电话。')).toContain('manager_promise');
    expect(categories('fallback', '健管师今天回复您。')).toContain('manager_promise');
  });

  it('必须保留的内容：危机要有 120 和家人，急症要有 120，开场要有“不是医生”', () => {
    expect(categories('crisis', '请马上联系家人。')).toEqual(['missing_required']);
    expect(categories('crisis', '请马上拨打 120。')).toEqual(['missing_required']);
    expect(categories('emergency', '请马上让家人送医。')).toEqual(['missing_required']);
    expect(categories('intro', '您好，我是福宝。')).toEqual(['missing_required']);
    expect(categories('daily_intro', '我是 AI 伴侣福宝，不是医生。')).toEqual([]);
  });

  it('占位符：只有测量提醒有且只有一个 {metric}', () => {
    expect(categories('reminder_measurement', '该记一下今天的血压了。')).toEqual(['placeholder']);
    expect(categories('reminder_measurement', '{metric}和{metric}都记一下。')).toEqual([
      'placeholder',
    ]);
    expect(categories('reminder_exercise', '今天的{metric}做了吗？')).toEqual(['placeholder']);
    expect(categories('asr_retry', '我没听清{，您再说一遍。')).toEqual(['placeholder']);
  });

  it('告知书模板只查禁用词', () => {
    expect(categories('notice', '福宝不会判断您是否患有疾病，请以医生意见为准。')).toEqual([]);
    expect(categories('notice', '福宝不能替代医生诊断。')).toEqual(['banned_term']);
  });
});
