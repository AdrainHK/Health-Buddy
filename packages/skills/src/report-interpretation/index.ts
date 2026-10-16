import { RISK_TIERS, RISK_TIER_REASON_MAX, type RiskTierSuggestion } from '@health-buddy/shared';
import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import { indicatorName } from '../indicators.js';
import {
  ABNORMAL_ZH,
  TIER_ZH,
  appendRequest,
  describeReportClient,
  referenceText,
  reportIndicatorLabel,
  reportValueText,
} from '../report-input.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/**
 * /体检解读（M2 规格 2.5、2.7、4.2）。
 *
 * 数值都由后端确定性地写出：危急指标、异常项表（数值、报告上的参考范围、上次的数值）
 * 和没有参考范围的指标都按输入渲染，不经过模型；模型只写说明、对比、转介、分层建议和通俗版。
 */
export const reportInterpretationOutputSchema = z.object({
  professional: z.object({
    overview: z.string().min(1),
    abnormalFindings: z.array(z.object({ indicator: z.string(), observation: z.string() })),
    comparison: z.array(z.string()),
    referralAdvice: z.string().nullable(),
    riskTier: z.object({ tier: z.enum(RISK_TIERS), reasons: z.array(z.string()) }).nullable(),
    toUnderstand: z.array(z.string()),
    missingData: z.array(z.string()),
    interviewPoints: z.array(z.string()),
    suggestions: z.array(z.string()),
  }),
  clientFacing: z.string().min(1),
  crisisSignal: z.boolean(),
});
export type ReportInterpretationOutput = z.output<typeof reportInterpretationOutputSchema>;

const LEVEL_ZH = { urgent: '需尽快就医', attention: '建议就医评估' } as const;
const SOURCE_ZH = { monitoring: '日常监测', report: '体检报告' } as const;

/** 审核栏和专业版顶部的固定提示（Q19） */
export const CRITICAL_CALL_NOTICE = '本报告有危急指标，请先电话联系客户。';

/**
 * 建议分层：只有输入里给了分层标准、模型给了分层和依据时才有（规格 4.2、4.3 第 4 条）。
 * 没有标准时模型给出的分层一律丢弃，不进产物。
 */
export function riskTierSuggestion(
  output: ReportInterpretationOutput,
  input: SkillInput | undefined,
): RiskTierSuggestion | null {
  const tier = output.professional.riskTier;
  if (!tier || !input?.riskTierCriteria?.trim()) return null;
  const reasons = tier.reasons.map((r) => r.trim()).filter(Boolean);
  if (!reasons.length) return null;
  const reason = reasons.join('；');
  return {
    tier: tier.tier,
    reason: reason.length > RISK_TIER_REASON_MAX ? reason.slice(0, RISK_TIER_REASON_MAX) : reason,
  };
}

/** 后端按输入写出的数值部分：危急指标、异常项、没有参考范围的指标 */
function deterministicSections(input: SkillInput | undefined): {
  critical: string[];
  abnormal: string[];
  noReference: string[];
} {
  const critical: string[] = [];
  const abnormal: string[] = [];
  const noReference: string[] = [];
  if (!input) return { critical, abnormal, noReference };
  const flags = input.client.criticalFlags;
  if (flags.length) {
    critical.push('## 危急指标', `**${CRITICAL_CALL_NOTICE}**`);
    for (const f of flags) {
      critical.push(
        `- ${indicatorName(f.metric)} ${f.value} ${f.unit}（${f.observedOn}，${SOURCE_ZH[f.source]}）：${LEVEL_ZH[f.rule.level]}`,
      );
    }
    critical.push('');
  }
  for (const i of input.client.reportDetail?.indicators ?? []) {
    if (i.abnormal === 'high' || i.abnormal === 'low') {
      const last = i.previous.at(-1);
      const prev = last
        ? `；上次 ${last.date} ${last.value}${i.unit ? ` ${i.unit}` : ''}`
        : '；没有可比较的历次数据';
      abnormal.push(
        `- **${reportIndicatorLabel(i)}**：${reportValueText(i)}，${ABNORMAL_ZH[i.abnormal]}（报告参考范围：${referenceText(i)}）${prev}`,
      );
    } else if (i.abnormal === 'no_reference') {
      noReference.push(
        `- ${reportIndicatorLabel(i)}：${reportValueText(i)}（${ABNORMAL_ZH.no_reference}）`,
      );
    }
  }
  return { critical, abnormal, noReference };
}

export const reportInterpretation: SkillDefinition<typeof reportInterpretationOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: body,
  outputSchema: reportInterpretationOutputSchema,
  requiresReport: true,
  route: 'report_interpretation',
  criticalInClientText: 'omit',
  reportReferenceInClientText: true,
  runStepLabel: 'steps.generateInterpretation',

  buildUserMessage(input) {
    return appendRequest([describeReportClient(input, { includeCriteria: true })], input);
  },

  render(output, input) {
    const p = output.professional;
    const { critical, abnormal, noReference } = deterministicSections(input);
    const suggestion = riskTierSuggestion(output, input);
    const lines: string[] = [];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    if (input?.client.reportDetail) {
      lines.push(`报告日期：${input.client.reportDetail.date}`, '');
    }
    lines.push(...critical);
    lines.push('## 总体概况', p.overview);
    lines.push('', '## 异常项（按报告上印的参考范围）');
    lines.push(...(abnormal.length ? abnormal : ['没有高于或低于参考范围的指标。']));
    if (p.abnormalFindings.length) {
      lines.push('', '### 说明');
      for (const f of p.abnormalFindings) lines.push(`- **${f.indicator}**：${f.observation}`);
    }
    if (noReference.length) lines.push('', '## 报告未提供参考范围的指标', ...noReference);
    if (p.comparison.length) lines.push('', '## 历次对比', ...p.comparison.map((s) => `- ${s}`));
    if (p.referralAdvice) lines.push('', '## 就医或转介建议', p.referralAdvice);
    lines.push('', '## 风险分层建议（AI 建议，由健管师决定）');
    if (suggestion) {
      lines.push(`建议分层：**${TIER_ZH[suggestion.tier]}**`);
      for (const r of p.riskTier?.reasons ?? []) if (r.trim()) lines.push(`- ${r.trim()}`);
    } else {
      lines.push(
        input?.riskTierCriteria?.trim()
          ? '这次没有给出建议分层。'
          : '没有提供分层标准，这次不给出建议分层。',
      );
    }
    if (p.toUnderstand.length) {
      lines.push('', '## 需要了解的情况', ...p.toUnderstand.map((s) => `- ${s}`));
    }
    if (p.missingData.length)
      lines.push('', '## 缺少的数据', ...p.missingData.map((s) => `- ${s}`));
    if (p.interviewPoints.length) {
      lines.push('', '## 面谈时建议了解', ...p.interviewPoints.map((s) => `- ${s}`));
    }
    if (p.suggestions.length) lines.push('', '## 跟进建议', ...p.suggestions.map((s) => `- ${s}`));
    return {
      professional: lines.join('\n'),
      clientFacing: output.clientFacing,
      crisisSignal: output.crisisSignal,
      riskTierSuggestion: suggestion,
    };
  },
};
