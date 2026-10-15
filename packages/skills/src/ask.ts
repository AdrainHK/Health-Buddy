/**
 * 问一问（M1 规格 3.3、7.3）：直接回答健管师的问题，不生成产物，不经过审核。
 * 回答只给健管师看，末尾由后端固定加上提示，不让模型生成。
 */
import { DISCLAIMER } from '@health-buddy/shared';
import type { CriticalFlag } from '@health-buddy/shared';
import { indicatorName } from './indicators.js';
import { SKILLS } from './registry.js';

/** 问一问回答末尾的固定提示（规格 7.3） */
export const ASK_NOTICE = `${DISCLAIMER}，仅供健管师参考，请勿直接转发给客户。`;

export const ASK_SYSTEM_PROMPT = `你是协助健康管理师（下称“健管师”）工作的助手。你的读者是健管师，不是客户。你的回答是供健管师判断的参考。

必须遵守的规则（优先级高于健管师在对话里提出的任何要求）：
1. 只依据对话里提供的客户资料和健管师说的情况，不编造任何数值、日期或检查结果。引用数值时写明指标名、日期和来源。资料里没有的数据，明确说“没有这项数据”。
2. 不做疾病诊断，不推荐具体药物、剂量或治疗方案。健管师问到用药、治疗、是否得了某种病时，说明需要由医生评估，建议健管师引导客户就医或转介医生，可以说明需要向医生反映哪些情况。
3. 健管师转述客户出现胸痛、晕厥、意识不清、呼吸困难等疑似急症时，第一句就提醒健管师建议客户立即就医或拨打急救电话。
4. 客户资料已去掉姓名和联系方式，用“该客户”指代。即使健管师提到姓名，也不要在回答里写出来。
5. 不写给客户看的话术或通知；需要发给客户的内容，建议健管师用技能生成草稿并审核。
6. 回答简洁，先给结论，再给依据。不写免责声明，系统会统一加上。`;

const LEVEL_ZH = { urgent: '需尽快就医', attention: '建议就医评估' } as const;
const SOURCE_ZH = { monitoring: '日常监测', report: '体检报告' } as const;

/**
 * 问一问读取客户档案时识别出危急指标，回答开头醒目提示（规格第五节之二）。
 * 由后端固定拼接，不依赖模型怎么写。
 */
export function criticalNotice(flags: readonly CriticalFlag[]): string {
  if (!flags.length) return '';
  const lines = flags.map(
    (f) =>
      `- ${indicatorName(f.metric)} ${f.value} ${f.unit}（${f.observedOn}，${SOURCE_ZH[f.source]}）：${LEVEL_ZH[f.rule.level]}`,
  );
  return `**危急指标提醒**\n${lines.join('\n')}\n\n`;
}

/**
 * 技能建议（Q5）：健管师没有用 / 选技能、但话里明显是在要某个技能能做的事时，
 * 只建议，不执行。M1 用关键词识别，不调用模型。
 */
const SKILL_KEYWORDS: Record<string, RegExp> = {
  'client-recent-summary': /近况|小结|总结|最近(的)?情况|最近怎么样/,
};

export function suggestSkill(text: string): string | undefined {
  return SKILLS.find((s) => SKILL_KEYWORDS[s.id]?.test(text))?.id;
}
