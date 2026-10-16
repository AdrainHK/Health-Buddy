/**
 * 用报告的技能（/体检解读、/面谈提纲，M2 规格 2.5、2.8）共用的输入组装。
 *
 * 只含去标识化后的资料（M1 Q9、M2 4.2）：年龄段、性别、健康数据、健康史（已脱敏）、当前分层。
 * 高低标记由后端按报告上印的参考范围算好（Q10），模型只引用，不自己判断。
 */
import type { CriticalFlag } from '@health-buddy/shared';
import type {
  ClientSnapshot,
  HealthHistoryEntry,
  ReportIndicatorDetail,
  SkillInput,
} from './framework.js';
import { indicatorName } from './indicators.js';

const GENDER_ZH = { female: '女', male: '男', other: '其他' } as const;
const SOURCE_ZH = { monitoring: '日常监测', report: '体检报告' } as const;
const COMPARATOR_ZH = { gte: '≥', gt: '>', lte: '≤', lt: '<' } as const;
const LEVEL_ZH = { urgent: '需尽快就医', attention: '建议就医评估' } as const;
export const TIER_ZH = { high: '高', medium: '中', low: '低' } as const;
export const ABNORMAL_ZH = {
  high: '高于参考范围',
  low: '低于参考范围',
  normal: '在参考范围内',
  no_reference: '报告未提供参考范围',
} as const;
export const HISTORY_CATEGORY_ZH: Record<HealthHistoryEntry['category'], string> = {
  past_history: '既往病史',
  family_history: '家族史',
  medication: '正在使用的药物',
  allergy: '过敏史',
  lifestyle: '生活习惯',
};

/** 指标的显示名：目录指标用中文名，未收录指标用报告上的原始名称 */
export function reportIndicatorLabel(i: Pick<ReportIndicatorDetail, 'code' | 'rawName'>): string {
  return i.code ? indicatorName(i.code) : `${i.rawName ?? '未命名指标'}（未收录指标）`;
}

/** 数值和单位，如“6.5 mmol/L”；文字结果原样写 */
export function reportValueText(i: Pick<ReportIndicatorDetail, 'value' | 'textValue' | 'unit'>) {
  const v = i.value !== null ? String(i.value) : (i.textValue ?? '没有数值');
  return i.unit ? `${v} ${i.unit}` : v;
}

/** 报告上印的参考范围原文；没有就写“报告未提供参考范围” */
export function referenceText(i: Pick<ReportIndicatorDetail, 'refText' | 'refLow' | 'refHigh'>) {
  if (i.refText) return i.refText;
  if (i.refLow !== null || i.refHigh !== null) return `${i.refLow ?? ''}–${i.refHigh ?? ''}`;
  return ABNORMAL_ZH.no_reference;
}

function describeCritical(flags: readonly CriticalFlag[], lines: string[]) {
  lines.push('', '### 危急指标（由系统按平台设定的阈值识别）');
  if (!flags.length) lines.push('无。');
  for (const f of flags) {
    lines.push(
      `- ${indicatorName(f.metric)} ${f.value} ${f.unit}（${f.observedOn}，${SOURCE_ZH[f.source]}），阈值 ${COMPARATOR_ZH[f.rule.comparator]} ${f.rule.value}，${LEVEL_ZH[f.rule.level]}`,
    );
  }
}

function describeMonitoring(client: ClientSnapshot, lines: string[]) {
  lines.push('', '### 最近 30 天日常监测');
  if (!client.monitoring.length) lines.push('没有日常监测数据。');
  for (const m of client.monitoring) {
    const values = m.readings.map((r) => `${r.date} ${r.value}`).join('；');
    lines.push(`- ${indicatorName(m.metric)}（${m.unit}）：${values || '没有记录'}`);
  }
}

/**
 * 用报告的技能看到的客户资料。分层标准只给 /体检解读（includeCriteria）。
 */
export function describeReportClient(
  input: SkillInput,
  options: { includeCriteria: boolean },
): string {
  const { client } = input;
  const lines: string[] = ['## 客户资料'];
  lines.push(
    `- 年龄段：${client.ageBand ? `${client.ageBand} 岁` : '未知'}；性别：${client.gender ? GENDER_ZH[client.gender] : '未知'}`,
  );
  const tier = client.riskTier;
  lines.push(
    `- 当前风险分层（健管师设定，只给健管师看）：${tier ? `${TIER_ZH[tier.tier]}（${tier.setOn} 设定）` : '未分层'}`,
  );

  lines.push('', '### 健康史（健管师录入）');
  const history = client.healthHistory ?? [];
  if (!history.length) lines.push('没有健康史记录。');
  for (const h of history) lines.push(`- ${HISTORY_CATEGORY_ZH[h.category]}：${h.content}`);

  const report = client.reportDetail;
  lines.push('', '### 这次的体检报告（已由健管师核对）');
  if (!report) lines.push('没有已核对的体检报告。');
  else {
    lines.push(
      `报告日期：${report.date}`,
      '每项后面的高低标记由系统按报告上印的参考范围计算，直接引用，不要自己重新判断高低，也不要写报告上没有的参考范围。',
    );
    for (const i of report.indicators) {
      const prev = i.previous.length
        ? `；之前：${i.previous.map((p) => `${p.date} ${p.value}${i.unit ? ` ${i.unit}` : ''}`).join('，')}`
        : '';
      lines.push(
        `- ${reportIndicatorLabel(i)}：${reportValueText(i)}；参考范围（报告原文）：${referenceText(i)}；${ABNORMAL_ZH[i.abnormal]}${prev}`,
      );
    }
    lines.push(
      '',
      `之前已核对的报告：${report.previousReportDates.length ? report.previousReportDates.join('、') : '没有'}（“之前”只列同一指标、同一单位的数值）`,
    );
  }

  describeMonitoring(client, lines);
  describeCritical(client.criticalFlags, lines);

  if (options.includeCriteria) {
    lines.push('', '### 风险分层标准');
    const criteria = input.riskTierCriteria?.trim();
    lines.push(criteria ? criteria : '没有提供分层标准。');
  }
  return lines.join('\n');
}

/** 健管师的要求和退回原因，接在客户资料后面 */
export function appendRequest(parts: string[], input: SkillInput): string {
  parts.push('', '## 健管师的要求', input.managerRequest);
  if (input.returnReason) parts.push('', '## 上一版被退回，退回原因', input.returnReason);
  return parts.join('\n');
}
