import { describe, expect, it } from 'vitest';
import { getSkill } from '../registry.js';
import { TWIN_SNAPSHOTS } from '../twin-fixtures.js';
import {
  checkHandoffReply,
  checkHandoffReplyDraft,
  handoffReply,
  withHandoffReplySection,
} from './index.js';

/** /转交回复（M6 规格 2.9）。全部是合成数据 */

const categories = (text: string) => checkHandoffReplyDraft(text).map((i) => i.category);

describe('/转交回复', () => {
  it('登记在注册表：只有做一做，只有专业版，要 @ 转交', () => {
    const skill = getSkill('handoff-reply');
    expect(skill).toBeDefined();
    expect(skill).toMatchObject({
      kind: 'handoff_reply',
      modes: ['craft'],
      clientFacing: false,
      involvesHealthJudgment: true,
      usesHandoff: true,
    });
  });

  it('合格的回复：口语、短句、只说请向开药医生确认', () => {
    expect(
      categories('您问的事我记下了，用药的事请向开药医生确认，我明天上午给您打电话细聊。'),
    ).toEqual([]);
    expect(categories('如果现在还不舒服，请马上告诉家人或拨打120。我会尽快打电话问问您。')).toEqual(
      [],
    );
  });

  it('不合格的回复：药名、剂量、病名、数值评价、推荐医院、符号和字母、太长', () => {
    expect(categories('二甲双胍先别停。')).toContain('drug_name');
    expect(categories('每次吃两片就行。')).toContain('drug_advice');
    expect(categories('您这不是糖尿病。')).toContain('presumed_disease');
    expect(categories('您的血压挺正常的。')).toContain('judgment');
    expect(categories('您可以去市人民医院看看。')).toContain('companion_rule');
    expect(categories('血压130/80（mmHg）还好。')).toContain('not_speakable');
    expect(categories('好'.repeat(151))).toContain('not_speakable');
    expect(categories('这个能根治。')).toContain('banned_term');
  });

  it('原话有急症、危机说法：回复要有“家人”和“120”，不能安抚性否认', () => {
    const check = (reply: string, question: string, crisisSignal = false) =>
      (
        handoffReply.checkOutput?.(
          { reply, notes: [], crisisSignal },
          {
            client: TWIN_SNAPSHOTS.stable,
            managerRequest: '请起草给客户的回复',
            handoff: { category: 'symptom', question, createdOn: '2026-10-28' },
          },
        ) ?? []
      ).map((i) => i.category);
    expect(check('我会尽快打电话问问您。', '胸口疼喘不上气')).toContain('urgent_line');
    expect(
      check('如果现在还不舒服，请马上告诉家人或拨打120。别担心。', '胸口疼喘不上气'),
    ).toContain('urgent_line');
    expect(
      check('如果现在还不舒服，请马上告诉家人或拨打120。我会尽快打电话问问您。', '胸口疼'),
    ).toEqual([]);
    expect(check('我会尽快和您联系。', '活着没意思')).toContain('urgent_line');
    expect(check('我会尽快打电话问问您。', '最近有点头晕')).toEqual([]);
  });

  it('发送前的检查：风险分层字样（高危）也要提醒', () => {
    expect(checkHandoffReply('您属于高危人群，我明天给您打电话').warnings).toContain('risk_tier');
  });

  it('发送前的检查：禁用词、提示语不能发；药名先提醒', () => {
    expect(checkHandoffReply('这个能根治')).toMatchObject({ bannedTerms: ['根治'] });
    expect(checkHandoffReply('降压药先别停').warnings.length).toBeGreaterThan(0);
    expect(checkHandoffReply('我明天给您打电话')).toEqual({
      bannedTerms: [],
      managerOnly: false,
      warnings: [],
    });
  });

  it('用户消息带转交原话、类别；渲染出回复和说明，structured 是回复原文', () => {
    const input = {
      client: TWIN_SNAPSHOTS.stable,
      managerRequest: '请起草给客户的回复',
      handoff: {
        category: 'medication' as const,
        question: '合成：降压药能不能停',
        createdOn: '2026-10-28',
      },
    };
    const msg = handoffReply.buildUserMessage(input);
    expect(msg).toContain('合成：降压药能不能停');
    expect(msg).toContain('类别：用药');
    const out = handoffReply.render(
      { reply: ' 用药的事请向开药医生确认。 ', notes: ['建议电话确认'], crisisSignal: false },
      input,
    );
    expect(out.structured).toEqual({ reply: '用药的事请向开药医生确认。' });
    expect(out.clientFacing).toBe('');
    expect(out.professional).toContain('福宝会原样念给客户');
    // 专业版不存客户原话（客户转出后原话跟着客户走）
    expect(out.professional).not.toContain('降压药能不能停');
    expect(out.professional).toContain('- 建议电话确认');
  });

  it('改回复后专业版的“回复”一节跟着改，其余不变', () => {
    const before =
      '## 客户的问题\n合成\n\n## 回复（福宝会原样念给客户）\n旧的回复\n\n## 给健管师的说明\n- 没有';
    const after = withHandoffReplySection(before, '新的回复');
    expect(after).toContain('## 回复（福宝会原样念给客户）\n新的回复\n');
    expect(after).not.toContain('旧的回复');
    expect(after).toContain('## 给健管师的说明\n- 没有');
    expect(withHandoffReplySection('手改过', '新的回复')).toBe(
      '手改过\n\n## 回复（福宝会原样念给客户）\n新的回复',
    );
  });
});
