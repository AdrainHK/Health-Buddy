import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import { indicatorName } from '../indicators.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

export const recentSummaryOutputSchema = z.object({
  professional: z.object({
    overview: z.string().min(1),
    findings: z.array(
      z.object({
        indicator: z.string(),
        observation: z.string(),
        source: z.enum(['monitoring', 'report']),
        date: z.string(),
      }),
    ),
    suggestions: z.array(z.string()),
    referralAdvice: z.string().nullable(),
    missingData: z.array(z.string()),
  }),
  clientFacing: z.string().min(1),
  crisisSignal: z.boolean(),
});
export type RecentSummaryOutput = z.output<typeof recentSummaryOutputSchema>;

const GENDER_ZH = { female: '女', male: '男', other: '其他' } as const;
const SOURCE_ZH = { monitoring: '日常监测', report: '体检报告' } as const;
const COMPARATOR_ZH = { gte: '≥', gt: '>', lte: '≤', lt: '<' } as const;
const LEVEL_ZH = { urgent: '需尽快就医', attention: '建议就医评估' } as const;

/** 把客户资料写成模型容易读的纯文本。只含去标识化后的资料。 */
export function describeClient(input: SkillInput): string {
  const { client } = input;
  const lines: string[] = ['## 客户资料'];
  lines.push(
    `- 年龄段：${client.ageBand ? `${client.ageBand} 岁` : '未知'}；性别：${client.gender ? GENDER_ZH[client.gender] : '未知'}`,
  );

  lines.push('', '### 最近 30 天日常监测');
  if (!client.monitoring.length) lines.push('没有日常监测数据。');
  for (const m of client.monitoring) {
    const values = m.readings.map((r) => `${r.date} ${r.value}`).join('；');
    lines.push(`- ${indicatorName(m.metric)}（${m.unit}）：${values || '没有记录'}`);
  }

  lines.push('', '### 最近一份体检报告');
  if (!client.latestReport) lines.push('没有体检报告。');
  else {
    lines.push(`报告日期：${client.latestReport.date}`);
    for (const i of client.latestReport.indicators) {
      const ref =
        i.refLow !== undefined || i.refHigh !== undefined
          ? `，参考范围 ${i.refLow ?? ''}–${i.refHigh ?? ''}`
          : '';
      lines.push(`- ${indicatorName(i.code)}：${i.value} ${i.unit}${ref}`);
    }
  }

  lines.push('', '### 危急指标（由系统按协会设定的阈值识别）');
  if (!client.criticalFlags.length) lines.push('无。');
  for (const f of client.criticalFlags) {
    lines.push(
      `- ${indicatorName(f.metric)} ${f.value} ${f.unit}（${f.observedOn}，${SOURCE_ZH[f.source]}），阈值 ${COMPARATOR_ZH[f.rule.comparator]} ${f.rule.value}，${LEVEL_ZH[f.rule.level]}`,
    );
  }
  return lines.join('\n');
}

export const clientRecentSummary: SkillDefinition<typeof recentSummaryOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: body,
  outputSchema: recentSummaryOutputSchema,

  buildUserMessage(input) {
    const parts = [describeClient(input), '', '## 健管师的要求', input.managerRequest];
    if (input.returnReason) {
      parts.push('', '## 上一版被退回，退回原因', input.returnReason);
    }
    return parts.join('\n');
  },

  render(output) {
    const p = output.professional;
    const lines: string[] = [];
    // 危机提示由后端写固定措辞，放在最前面，不依赖模型怎么表述
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    lines.push('## 近况概述', p.overview);
    if (p.findings.length) {
      lines.push('', '## 关注点');
      for (const f of p.findings) {
        lines.push(`- **${f.indicator}**：${f.observation}（${SOURCE_ZH[f.source]}，${f.date}）`);
      }
    }
    if (p.suggestions.length) {
      lines.push('', '## 跟进建议', ...p.suggestions.map((s) => `- ${s}`));
    }
    if (p.referralAdvice) lines.push('', '## 就医或转介建议', p.referralAdvice);
    if (p.missingData.length) {
      lines.push('', '## 缺少的数据', ...p.missingData.map((s) => `- ${s}`));
    }
    return {
      professional: lines.join('\n'),
      clientFacing: output.clientFacing,
      crisisSignal: output.crisisSignal,
    };
  },
};
