import { describe, expect, it } from 'vitest';
import type { SkillInput } from './framework.js';
import { getSkill, skillSummaries } from './registry.js';
import { visitScheduleEvalCases } from './visit-schedule/evals/cases.js';
import { visitSchedule, validateVisitSchedule } from './visit-schedule/index.js';

/** M5 /随访计划（规格 2.7、5.2、5.5）。全部是合成数据 */

const evalCase = visitScheduleEvalCases.find((c) => c.id === 'vs-plan-review')!;
const input: SkillInput = {
  client: evalCase.client,
  managerRequest: '请排随访计划',
  plan: evalCase.plan,
};
const rows = evalCase.plan.schedule!.rows;
const output = (over: Partial<Parameters<typeof validateVisitSchedule>[0]> = {}) => ({
  rows: rows.map((r) => ({ ...r, focus: '了解晚餐调整的执行情况' })),
  notes: [],
  crisisSignal: false,
  ...over,
});

describe('/随访计划', () => {
  it('登记在技能表里：只有专业版、读方案上下文、不接专家', () => {
    expect(getSkill('visit-schedule')).toBe(visitSchedule);
    expect(visitSchedule).toMatchObject({
      kind: 'visit_schedule',
      clientFacing: false,
      planContext: 'visit_schedule',
      experts: 'none',
    });
    expect(skillSummaries().find((s) => s.id === 'visit-schedule')).toMatchObject({
      clientFacing: false,
      allowsEmptyRequest: true,
    });
  });

  it('用户消息里有当前方案、随访记录和系统排好的日期；日期和目的不能改', () => {
    const message = visitSchedule.buildUserMessage(input);
    expect(message).toContain('## 当前方案');
    expect(message).toContain('每天步行 7000 步');
    expect(message).toContain('## 系统排好的随访日期');
    for (const r of rows) expect(message).toContain(r.dueDate);
    expect(message).toContain('日期和目的不能改');
  });

  it('结构校验：行数、日期、目的和输入一致才通过；重点超长也不合格', () => {
    expect(validateVisitSchedule(output(), input)).toEqual([]);
    expect(validateVisitSchedule(output({ rows: output().rows.slice(1) }), input)).toEqual([
      'schedule_mismatch',
    ]);
    const swapped = output().rows.map((r, i) =>
      i === 0 ? { ...r, purpose: r.purpose === 'routine' ? 'follow_up' : 'routine' } : r,
    ) as ReturnType<typeof output>['rows'];
    expect(validateVisitSchedule(output({ rows: swapped }), input)).toEqual(['schedule_mismatch']);
    const long = output().rows.map((r) => ({ ...r, focus: '了'.repeat(201) }));
    expect(validateVisitSchedule(output({ rows: long }), input)).toEqual(['focus_too_long']);
  });

  it('渲染：日期和目的照抄输入，结构化内容可以直接确认；没有通俗版', () => {
    const rendered = visitSchedule.render(output({ notes: ['第一次随访排在方案开始后'] }), input);
    expect(rendered.clientFacing).toBe('');
    expect(rendered.structured).toEqual({
      rows: rows.map((r) => ({ ...r, focus: '了解晚餐调整的执行情况' })),
    });
    expect(rendered.professional).toContain('方案复评');
    expect(rendered.professional).toContain('随访日期由系统按平台的随访频次规则排出');
  });

  it('措辞检查：重点里的疾病名称、用药建议、判断说法都拦下', () => {
    const bad = output({
      rows: output().rows.map((r, i) =>
        i === 0 ? { ...r, focus: '确认高血压病情，提醒把降压药减半' } : r,
      ),
    });
    const categories = new Set(visitSchedule.checkOutput!(bad, input).map((i) => i.category));
    expect(categories.has('presumed_disease')).toBe(true);
    expect(categories.has('judgment')).toBe(true);
    expect(visitSchedule.checkOutput!(output(), input)).toEqual([]);
  });

  it('评测用例至少 8 条，日期表都非空', () => {
    expect(visitScheduleEvalCases.length).toBeGreaterThanOrEqual(8);
    for (const c of visitScheduleEvalCases) expect(c.plan.schedule?.rows.length).toBeGreaterThan(0);
  });
});
