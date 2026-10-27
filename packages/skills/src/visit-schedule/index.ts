import { DISCLAIMER, VISIT_FOCUS_MAX, VISIT_METHODS } from '@health-buddy/shared';
import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import {
  VISIT_METHOD_ZH,
  VISIT_PURPOSE_ZH,
  describePlanContext,
  describeSchedule,
} from '../plan-input.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import { TWIN_PROMPT_RULES, describeTwin } from '../twin-input.js';
import {
  checkTwinJudgments,
  checkWhyWording,
  wordingCategories,
  type WordingCategory,
} from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/** 风险分层的说法（只给健管师看的专业版里可以出现） */
const TIER_WORDING = /风险分层|[高中低]风险/g;

/**
 * /随访计划（M5 规格 2.7）：只有专业版（clientFacing: false），产物 kind = visit_schedule。
 * 日期和目的类别由后端按频次规则算好（Q17），模型只写方式建议和重点；
 * 结构校验要求行数、日期、目的和输入完全一致，不一致重试一次，仍不一致不保存草稿。
 */
export const visitScheduleOutputSchema = z.object({
  rows: z.array(
    z.object({
      dueDate: z.string(),
      purpose: z.enum(['routine', 'plan_review', 'follow_up']),
      method: z.enum(VISIT_METHODS),
      focus: z.string(),
    }),
  ),
  notes: z.array(z.string()),
  crisisSignal: z.boolean(),
});
export type VisitScheduleOutput = z.output<typeof visitScheduleOutputSchema>;

/** 模型写的文字（措辞检查用） */
export function visitScheduleTexts(output: VisitScheduleOutput): string[] {
  return [...output.rows.map((r) => r.focus), ...output.notes];
}

/**
 * 结构校验（5.2）：行数、日期、目的类别和后端排好的完全一致；重点不超过日程表的上限 200 字
 * （提示词让模型写到 100 字以内，留出健管师自己补充的余地）。
 * 返回类别：schedule_mismatch、focus_too_long
 */
export function validateVisitSchedule(output: VisitScheduleOutput, input: SkillInput): string[] {
  const expected = input.plan?.schedule?.rows ?? [];
  const issues: string[] = [];
  const same =
    output.rows.length === expected.length &&
    output.rows.every(
      (r, i) => r.dueDate === expected[i]?.dueDate && r.purpose === expected[i]?.purpose,
    );
  if (!same) issues.push('schedule_mismatch');
  if (output.rows.some((r) => r.focus.trim().length > VISIT_FOCUS_MAX)) {
    issues.push('focus_too_long');
  }
  return issues;
}

const VALIDATION_NOTE: Record<string, string> = {
  schedule_mismatch:
    'rows 和“系统排好的随访日期”对不上；必须逐行照抄日期和目的类别，条数、顺序都相同，不能增删行',
  focus_too_long: '有一行的重点太长；每行重点不超过 100 个字',
};

const WORDING_NOTE: Partial<Record<WordingCategory, string>> = {
  banned_term: '重点或说明里出现了禁用词（如“诊断”“筛查”“治愈”“根治”“确诊”）',
  presumed_disease: '重点或说明里出现了疾病名称（包括照抄健康史）；改成“健康史里有相关记录”',
  judgment: '重点或说明里用了“疑似”“患有”“风险”这类判断说法',
  drug_name: '重点或说明里点名了具体药物；写“了解用药情况，用药调整由医生评估”',
  drug_advice: '重点或说明里出现了用药建议或剂量',
  status_change: '重点或说明里写了孪生状态的结论；状态只能由健管师在孪生上手动调整',
  forecast_certainty: '重点或说明里用了“将会”“一定会”这类确定说法',
  disease_risk: '重点或说明里把指标走势说成了疾病或患病概率',
};

function note(lines: readonly string[]): string {
  return [
    '## 上一次生成的随访计划没有通过检查，请重新生成',
    ...lines.map((l) => `- ${l}`),
    '- 其余要求不变；输出前逐条检查一遍。',
  ].join('\n');
}

export const visitSchedule: SkillDefinition<typeof visitScheduleOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: `${TWIN_PROMPT_RULES}\n\n${body}`,
  outputSchema: visitScheduleOutputSchema,
  planContext: 'visit_schedule',
  experts: 'none',
  runStepLabel: 'steps.generateVisitSchedule',

  buildUserMessage(input) {
    const parts = [describeReportClient(input, { includeCriteria: false })];
    if (input.client.twin) parts.push('', describeTwin(input.client.twin));
    if (input.plan) {
      parts.push('', describePlanContext(input.plan));
      if (input.plan.schedule) parts.push('', describeSchedule(input.plan.schedule));
    }
    return appendRequest(parts, input);
  },

  render(output, input) {
    // 日期和目的照抄后端排好的（校验已保证一致），方式和重点用模型写的
    const expected = input?.plan?.schedule?.rows ?? [];
    const rows = expected.map((e, i) => {
      const r = output.rows[i];
      const focus = r?.focus.trim() ?? '';
      return {
        dueDate: e.dueDate,
        purpose: e.purpose,
        method: r?.method ?? e.method,
        focus: focus ? focus.slice(0, VISIT_FOCUS_MAX) : null,
      };
    });
    const lines: string[] = [];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    const schedule = input?.plan?.schedule;
    lines.push('## 随访计划');
    if (schedule) {
      lines.push(
        `按风险分层“${schedule.tierLabel}”的随访间隔 ${schedule.intervalDays} 天排出（${schedule.today} 起）。`,
      );
    }
    for (const r of rows) {
      lines.push(
        `- ${r.dueDate} · ${VISIT_PURPOSE_ZH[r.purpose]} · ${VISIT_METHOD_ZH[r.method]}：${r.focus ?? '（没有写重点）'}`,
      );
    }
    if (output.notes.length) lines.push('', '## 说明', ...output.notes.map((n) => `- ${n}`));
    lines.push(
      '',
      '---',
      `随访日期由系统按平台的随访频次规则排出，可以在日程表里修改；确认后才写入随访日程。${DISCLAIMER}`,
    );
    return {
      professional: lines.join('\n'),
      clientFacing: '',
      crisisSignal: output.crisisSignal,
      structured: { rows },
    };
  },

  checkOutput(output) {
    return visitScheduleTexts(output).flatMap((t) => {
      // 专业版只给健管师：照抄“按风险分层排的间隔”“高风险客户”这类分层说法是正常的，
      // 不算“风险”这类判断说法（遮成等长空格，位置照旧）
      const masked = t.replace(TIER_WORDING, (m) => ' '.repeat(m.length));
      return [...checkWhyWording(masked), ...checkTwinJudgments(masked)];
    });
  },

  correctionNote(issues) {
    return note(
      wordingCategories(issues).flatMap((c) => (WORDING_NOTE[c] ? [WORDING_NOTE[c]] : [])),
    );
  },

  validateOutput: validateVisitSchedule,

  validationNote(categories) {
    return note(categories.flatMap((c) => (VALIDATION_NOTE[c] ? [VALIDATION_NOTE[c]] : [])));
  },
};
