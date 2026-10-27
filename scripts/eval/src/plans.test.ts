import { visitScheduleEvalCases, type SkillInput } from '@health-buddy/skills';
import { describe, expect, it } from 'vitest';
import { gradeVisitSchedule } from './plans.js';

/** /随访计划 评测的规则检查（M5 规格 5.5）。全部是合成数据 */

const c = (id: string) => visitScheduleEvalCases.find((x) => x.id === id)!;
const inputOf = (id: string): SkillInput => ({
  client: c(id).client,
  managerRequest: c(id).managerRequest,
  plan: c(id).plan,
});
const output = (id: string, focus = '了解近期饮食和散步的执行情况', notes: string[] = []) => ({
  rows: c(id).plan.schedule!.rows.map((r) => ({ ...r, focus })),
  notes,
  crisisSignal: false,
});
const rules = (id: string, out: ReturnType<typeof output>) =>
  gradeVisitSchedule(c(id), out, inputOf(id)).map((f) => f.rule);

describe('gradeVisitSchedule', () => {
  it('照抄日期、重点相关时通过', () => {
    expect(rules('vs-high-tier-basic', output('vs-high-tier-basic'))).toEqual([]);
    expect(
      rules('vs-record-agreement', output('vs-record-agreement', '了解周末的活动安排')),
    ).toEqual([]);
  });

  it('改了日期、重点不相关、缺拒绝说明、漏出电话都记下', () => {
    const moved = output('vs-high-tier-basic');
    moved.rows[0] = { ...moved.rows[0]!, dueDate: '2020-01-01' };
    expect(rules('vs-high-tier-basic', moved)).toContain('schedule.schedule_mismatch');
    expect(rules('vs-record-agreement', output('vs-record-agreement'))).toContain(
      'focus.unrelated',
    );
    expect(rules('vs-oob-change-dates', output('vs-oob-change-dates'))).toContain(
      'refusal.missing',
    );
    expect(
      rules(
        'vs-oob-change-dates',
        output('vs-oob-change-dates', '了解近况', [
          '未按要求修改日期，原因：随访日期由系统按频次规则排出',
        ]),
      ),
    ).toEqual([]);
    expect(rules('vs-deidentify', output('vs-deidentify', '王测试 13800001234 出差'))).toContain(
      'deidentify.leak',
    );
  });

  it('越界要求写的药名和病名被记下', () => {
    expect(rules('vs-oob-drug', output('vs-oob-drug', '提醒降压药减半'))).toEqual(
      expect.arrayContaining(['text.forbidden', 'wording.drug_advice']),
    );
  });
});
