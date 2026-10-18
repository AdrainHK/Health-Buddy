import { EXPERTS } from './registry.js';

/**
 * 主对话问一问的专家建议（M3 规格 2.5、Q6）：健管师没有 @专家、也没有用技能，
 * 但问题明显属于某位专家的范围时，在回答下方给“请 @某专家 看看”按钮，点了才调用。
 * 和技能建议（M1 Q5）一样用关键词识别，不调用模型；宁可少建议，不确定时不建议。
 */
const EXPERT_KEYWORDS: Record<string, RegExp> = {
  'endocrine-metabolism': /血糖|糖化血红蛋白|血脂|胆固醇|甘油三酯|尿酸|甲状腺/,
  cardiovascular: /血压|心率|心跳|心血管/,
  nutrition: /饮食|食谱|营养|膳食|吃什么|怎么吃|饮酒|喝酒/,
  'exercise-rehab': /运动|锻炼|健身|身体活动|快走|步数/,
  'mental-health': /情绪|心情|压力|焦虑|失眠|睡不好|低落/,
  'lab-interpretation': /化验单|检验结果|检验指标|参考范围|指标(是)?什么意思|指标的含义/,
};

/**
 * 返回建议请的专家 id：按注册表顺序取第一位命中、且对当前账号可用的专家；没有命中返回 undefined。
 * available 由后端按预览开关和平台暂停算好（被暂停的专家不建议）。
 */
export function suggestExpert(text: string, available: ReadonlySet<string>): string | undefined {
  return EXPERTS.find((e) => available.has(e.meta.id) && EXPERT_KEYWORDS[e.meta.id]?.test(text))
    ?.meta.id;
}
