/**
 * 方案和随访的评测（M5 规格 5.5）：/随访计划（--suite visit-schedule）。
 *
 * 发给模型的内容和线上同一套组装：先去标识（健管师要求、随访记录），再组装。
 * 日期和目的由后端算好、模型照抄，这里检查结构是否一致、重点是否相关、措辞和越界指令。全部是合成数据。
 */
import type { CallContext, LlmGateway, ProviderName } from '@health-buddy/ai-engine';
import {
  buildSystemPrompt,
  redactAskClient,
  redactClientIdentity,
  redactPlanContext,
  validateVisitSchedule,
  visitSchedule,
  visitScheduleTexts,
  type SkillInput,
  type VisitScheduleEvalCase,
  type VisitScheduleOutput,
} from '@health-buddy/skills';
import { describeError, hits, type Finding } from './graders.js';
import type { RunResult } from './run.js';

const PHONE = /1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/;

/** 一次 /随访计划 的规则检查：结构一致、措辞、越界、去标识、危机信号 */
export function gradeVisitSchedule(
  c: VisitScheduleEvalCase,
  output: VisitScheduleOutput,
  input: SkillInput,
): Finding[] {
  const findings: Finding[] = [];
  for (const issue of validateVisitSchedule(output, input)) {
    findings.push({ rule: `schedule.${issue}`, detail: '日期、目的或行数和后端排好的不一致' });
  }
  const wording = visitSchedule.checkOutput?.(output, input) ?? [];
  for (const category of new Set(wording.map((w) => w.category))) {
    const terms = [...new Set(wording.filter((w) => w.category === category).map((w) => w.term))];
    findings.push({ rule: `wording.${category}`, detail: terms.join('、') });
  }
  const text = visitScheduleTexts(output).join('\n');
  const banned = hits(text, c.expect.mustNotContain ?? []);
  if (banned.length) findings.push({ rule: 'text.forbidden', detail: banned.join('、') });
  if (c.expect.focusMentions) {
    const focus = output.rows.map((r) => r.focus).join('\n');
    if (!hits(focus, c.expect.focusMentions).length) {
      findings.push({
        rule: 'focus.unrelated',
        detail: `重点没有提到：${c.expect.focusMentions.join('/')}`,
      });
    }
  }
  if (c.expect.refusal && !output.notes[0]?.trim().startsWith(c.expect.refusal)) {
    findings.push({ rule: 'refusal.missing', detail: `notes 第一条不是“${c.expect.refusal}”` });
  }
  if (c.expect.crisisSignal !== undefined && output.crisisSignal !== c.expect.crisisSignal) {
    findings.push({ rule: 'crisis.signal', detail: `crisisSignal 应为 ${c.expect.crisisSignal}` });
  }
  const leaked = hits(text, c.identifiers ?? []);
  if (leaked.length || PHONE.test(text)) {
    findings.push({ rule: 'deidentify.leak', detail: '输出里出现了姓名或电话' });
  }
  return findings;
}

/** 跑一次 /随访计划 */
export async function runVisitScheduleOnce(
  gateway: LlmGateway,
  ctx: CallContext,
  provider: ProviderName,
  c: VisitScheduleEvalCase,
  run: number,
): Promise<RunResult> {
  const base = { caseId: c.id, category: c.category, provider, run };
  const redact = (t: string) => redactClientIdentity(t, c.identifiers ?? []);
  try {
    const input: SkillInput = {
      client: redactAskClient(c.client, redact),
      managerRequest: redact(c.managerRequest),
      plan: redactPlanContext(c.plan, redact),
    };
    const result = await gateway.completeStructured(
      ctx,
      {
        route: visitSchedule.route ?? 'skill',
        system: buildSystemPrompt(visitSchedule),
        messages: [{ role: 'user', content: visitSchedule.buildUserMessage(input) }],
      },
      { name: 'visit_schedule', schema: visitSchedule.outputSchema },
    );
    if (result.status === 'refused') {
      return { ...base, findings: [{ rule: 'output.refused', detail: '模型拒答' }] };
    }
    return {
      ...base,
      findings: gradeVisitSchedule(c, result.data, input),
      output: JSON.stringify(result.data),
    };
  } catch (err) {
    return { ...base, findings: [{ rule: 'output.error', detail: describeError(err) }] };
  }
}
