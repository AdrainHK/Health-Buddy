import { DISCLAIMER, TWIN_DOMAINS, type CriticalFlag } from '@health-buddy/shared';
import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import { indicatorName } from '../indicators.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import {
  TWIN_DOMAIN_ZH,
  TWIN_LEVEL_ZH,
  TWIN_PROMPT_RULES,
  describeCrossing,
  describeTwin,
  type TwinForecastSnapshot,
  type TwinSnapshot,
} from '../twin-input.js';
import { checkTwinWording, wordingCategories, type WordingCategory } from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/**
 * /孪生小结（M4 规格 2.7）：只有专业版（clientFacing: false，Q17），产物 kind = twin_summary。
 * 状态颜色和预测数字由后端从输入照抄写进小结（render），模型只写说明文字；
 * 说明文字过 wording 检查（状态结论、确定说法、疾病风险、疾病名称、用药）和数值校验（numberCheckTexts）。
 */
export const twinSummaryOutputSchema = z.object({
  professional: z.object({
    overview: z.string().min(1),
    domains: z.array(z.object({ domain: z.enum(TWIN_DOMAINS), explanation: z.string() })),
    changes: z.array(z.string()),
    trends: z.array(
      z.object({
        metric: z.string(),
        /** 同一指标既有报告又有监测预测时，写清是哪一个；只有一个时可以为 null */
        source: z.enum(['report', 'monitoring']).nullable().default(null),
        comment: z.string(),
      }),
    ),
    followUps: z.array(z.string()),
    suggestions: z.array(z.string()),
    referralAdvice: z.string().nullable(),
    dataGaps: z.array(z.string()),
  }),
  crisisSignal: z.boolean(),
});
export type TwinSummaryOutput = z.output<typeof twinSummaryOutputSchema>;

const SOURCE_ZH = { report: '体检报告', monitoring: '日常监测' } as const;
const LEVEL_ZH = { urgent: '需尽快就医', attention: '建议就医评估' } as const;
const INSUFFICIENT_ZH = {
  not_forecastable: '这个指标不做预测',
  too_few_points: '数据次数不够',
  span_too_short: '数据的时间跨度不够',
} as const;

/** 小结开头的危急指标提醒（后端固定写，不依赖模型，5.4 第 7 条） */
function criticalLines(flags: readonly CriticalFlag[]): string[] {
  if (!flags.length) return [];
  return [
    '## 危急指标提醒',
    '资料里有危急指标，请先电话联系客户，建议客户及时就医：',
    ...flags.map(
      (f) =>
        `- ${indicatorName(f.metric)} ${f.value} ${f.unit}（${f.observedOn}，${SOURCE_ZH[f.source]}）：${LEVEL_ZH[f.rule.level]}`,
    ),
    '',
  ];
}

/** 预测一行：数字全部照抄后端算好的结果（2.7：照抄，不自己推算） */
export function forecastLine(f: TwinForecastSnapshot): string {
  const name = `${indicatorName(f.metric)}（${SOURCE_ZH[f.source]}）`;
  if (f.status !== 'ok') {
    const reason = f.insufficientReason ? INSUFFICIENT_ZH[f.insufficientReason] : '数据不足';
    const need = f.pointsNeeded ? `，还需要 ${f.pointsNeeded} 次数据` : '';
    return `**${name}**：数据不足，暂不预测（${reason}${need}）`;
  }
  const level = Math.round(f.intervalLevel * 100);
  const points = f.points
    .map(
      (p) =>
        `${p.monthsAhead} 个月后中间值约 ${p.mid} ${f.unit}，${level}% 区间 ${p.low}–${p.high}`,
    )
    .join('；');
  const basis = f.basis
    ? `根据 ${f.basis.from} 至 ${f.basis.to} 共 ${f.nPoints} ${f.source === 'report' ? '次已核对报告的数值' : '个有效周的周平均'}`
    : `根据 ${f.nPoints} 次数据`;
  const uncertainty = f.uncertainty === 'high' ? '不确定性高' : '不确定性一般';
  return `**${name}**：按过去的变化速度推算，${points}（${basis}；${uncertainty}）`;
}

function twinOf(input?: SkillInput): TwinSnapshot | null {
  return input?.client.twin ?? null;
}

export const twinSummary: SkillDefinition<typeof twinSummaryOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: `${TWIN_PROMPT_RULES}\n\n${body}`,
  outputSchema: twinSummaryOutputSchema,
  usesTwin: true,
  // Q17：/孪生小结 不接入专家，需要专家时用“请专家看看”
  experts: 'none',
  runStepLabel: 'steps.generateTwinSummary',

  buildUserMessage(input) {
    const parts = [describeReportClient(input, { includeCriteria: false })];
    const twin = twinOf(input);
    parts.push('', twin ? describeTwin(twin) : '## 数字孪生\n没有孪生资料。');
    return appendRequest(parts, input);
  },

  render(output, input) {
    const p = output.professional;
    const twin = twinOf(input);
    const lines: string[] = [];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    lines.push(...criticalLines(input?.client.criticalFlags ?? []));
    lines.push('## 总体概述', p.overview.trim());

    // 状态：颜色和依据由后端照抄孪生（2.7），模型只写说明
    lines.push('', '## 四个方面的状态');
    for (const domain of TWIN_DOMAINS) {
      const d = twin?.domains.find((x) => x.domain === domain);
      const explanation = p.domains.find((x) => x.domain === domain)?.explanation.trim();
      if (!d) {
        lines.push(`- **${TWIN_DOMAIN_ZH[domain]}**：${TWIN_LEVEL_ZH.unknown}`);
      } else {
        const origin = d.manual
          ? `健管师手动调整（系统计算：${d.computedLevel ? TWIN_LEVEL_ZH[d.computedLevel] : '还没有计算'}；理由：${d.manual.reason}）`
          : '系统按规则计算';
        lines.push(`- **${TWIN_DOMAIN_ZH[domain]}**：${TWIN_LEVEL_ZH[d.level]} · ${origin}`);
        for (const b of d.basis) {
          const where = b.source === 'report' ? '体检报告' : `日常监测 ${b.count} 条平均`;
          lines.push(
            `  - ${indicatorName(b.metric)} ${b.value} ${b.unit}（${b.observedOn}，${where}）`,
          );
        }
      }
      if (explanation) lines.push(`  - 说明：${explanation}`);
    }

    if (p.changes.length) lines.push('', '## 最近的变化', ...p.changes.map((s) => `- ${s}`));

    lines.push('', '## 趋势预测');
    const forecasts = twin?.forecasts ?? [];
    if (!forecasts.length) lines.push('没有可预测的指标数据，暂不预测。');
    for (const f of forecasts) {
      lines.push(`- ${forecastLine(f)}`);
      if (f.crossings?.length)
        lines.push(`  - 越线：${f.crossings.map(describeCrossing).join('；')}（只是数值的推算）`);
      const comment = trendComment(p.trends, f, forecasts)?.trim();
      if (comment) lines.push(`  - 说明：${comment}`);
    }
    if (forecasts.length) {
      lines.push(
        '',
        '预测只根据过去的数值按直线外推，没有考虑用药、生活方式变化和其他因素；不是对任何疾病的预测。',
      );
    }

    if (p.followUps.length) lines.push('', '## 待跟进', ...p.followUps.map((s) => `- ${s}`));
    if (p.suggestions.length) {
      lines.push('', '## 建议健管师关注和了解', ...p.suggestions.map((s) => `- ${s}`));
    }
    if (p.referralAdvice) lines.push('', '## 就医或转介建议', p.referralAdvice);
    if (p.dataGaps.length) lines.push('', '## 数据缺口', ...p.dataGaps.map((s) => `- ${s}`));
    // 小结不能修改状态（2.7）：状态只能由健管师在孪生上手动调整
    lines.push(
      '',
      '---',
      `状态由平台规则计算或健管师手动调整，确认本小结不会改变任何状态。${DISCLAIMER}`,
    );
    // 没有通俗版：不能复制或导出给客户（Q17）
    return { professional: lines.join('\n'), clientFacing: '', crisisSignal: output.crisisSignal };
  },

  checkOutput(output) {
    return twinSummaryTexts(output).flatMap((t) => checkTwinWording(t));
  },

  numberCheckTexts(output) {
    return twinSummaryTexts(output);
  },

  correctionNote(issues) {
    return twinCorrectionNote(wordingCategories(issues));
  },
};

/**
 * 预测对应的说明：指标和来源都对上的优先；没写来源的只在这个指标只有一个预测时用，
 * 免得报告和监测两条预测挂上同一句说明。
 */
function trendComment(
  trends: TwinSummaryOutput['professional']['trends'],
  f: TwinForecastSnapshot,
  all: readonly TwinForecastSnapshot[],
): string | undefined {
  const exact = trends.find((t) => t.metric === f.metric && t.source === f.source);
  if (exact) return exact.comment;
  const single = all.filter((x) => x.metric === f.metric).length === 1;
  return single
    ? trends.find((t) => t.metric === f.metric && t.source === null)?.comment
    : undefined;
}

/** 模型写的全部文字（措辞检查和数值校验用） */
export function twinSummaryTexts(output: TwinSummaryOutput): string[] {
  const p = output.professional;
  return [
    p.overview,
    ...p.domains.map((d) => d.explanation),
    ...p.changes,
    ...p.trends.map((t) => t.comment),
    ...p.followUps,
    ...p.suggestions,
    ...(p.referralAdvice ? [p.referralAdvice] : []),
    ...p.dataGaps,
  ];
}

const CATEGORY_NOTE: Record<WordingCategory, string> = {
  banned_term: '小结里出现了禁用词（如“诊断”“筛查”“治愈”“根治”“确诊”）',
  presumed_disease:
    '小结里出现了疾病名称（包括照抄健康史）；改成“健康史里有相关记录”或只写指标和数值',
  judgment: '小结里用了“疑似”“患有”这类判断说法',
  drug_name: '小结里点名了具体药物；用药写“用药情况”，调整由医生评估',
  drug_advice: '小结里出现了用药建议或剂量；不写服用、换药、停药、加减量和剂量',
  status_change:
    '小结里写了状态结论（如“建议调整为红”“应改为绿色”）；状态只能照抄和解释，改状态由健管师在孪生上手动调整',
  forecast_certainty: '预测用了“将会”“一定会”“必然”这类确定说法；改成“如果按过去的走势，可能……”',
  disease_risk:
    '小结把指标走势说成了疾病或患病概率（如“会得”“会发展成”“风险增加”“患病概率”）；只写指标数值的走势',
  invented_number:
    '小结里出现了资料里没有的数值（可能是自己推算的预测或区间）；只引用资料里写出的数值，不推算',
  efficacy_claim: '小结里写了功效承诺（如“降血糖”“治好”“保证见效”）；只写指标数值的走势',
};

/** 没通过检查时，重新生成附在用户消息后面的纠正说明。只写问题类别，不复述上次的输出 */
export function twinCorrectionNote(categories: readonly WordingCategory[]): string {
  return [
    '## 上一次生成的小结没有通过检查，请重新生成',
    ...categories.map((c) => `- ${CATEGORY_NOTE[c]}`),
    '- 其余要求不变；输出前按“措辞规则”逐条检查一遍。',
  ].join('\n');
}
