import {
  visitRecordEvalCases,
  visitScriptEvalCases,
  type VisitRecordOutput,
  type VisitScriptOutput,
} from '@health-buddy/skills';
import { describe, expect, it } from 'vitest';
import {
  gradeVisitRecord,
  gradeVisitScript,
  numbersNotIn,
  recordSource,
  visitInput,
} from './visits.js';

/** /随访话术、/随访记录 评测的规则检查（M5 规格 5.5）。全部是合成数据 */

const scriptCase = (id: string) => visitScriptEvalCases.find((x) => x.id === id)!;
const recordCase = (id: string) => visitRecordEvalCases.find((x) => x.id === id)!;

const script = (over: Partial<VisitScriptOutput> = {}): VisitScriptOutput => ({
  summary: {
    changes: [],
    adherence: ['每天步行 7000 步：近 7 天平均 6120 步，达标 2 天'],
    followUps: [],
    agreements: ['周末也出去走一走'],
  },
  opening: '您好，今天想和您聊聊最近散步和晚饭的情况。',
  questions: [
    { section: 'exercise', question: '这个周末有没有出去走一走？', why: '上次约定周末也走' },
    { section: 'diet', question: '杂粮饭吃得习惯吗？', why: '上次约定换杂粮饭' },
    { section: 'routine', question: '最近一般几点睡？', why: '方案包含作息部分' },
  ],
  encouragement: ['工作日都坚持散步，很不容易。'],
  adjustments: [],
  reminders: [],
  notes: [],
  crisisSignal: false,
  ...over,
});

const scriptRules = (id: string, out: VisitScriptOutput) =>
  gradeVisitScript(scriptCase(id), out, visitInput(scriptCase(id))).map((f) => f.rule);

describe('gradeVisitScript', () => {
  it('用例够数：至少 12 条，id 不重复', () => {
    expect(visitScriptEvalCases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(visitScriptEvalCases.map((c) => c.id)).size).toBe(visitScriptEvalCases.length);
  });

  it('只引用输入、问题相关时通过', () => {
    expect(scriptRules('vsc-basic-plan', script())).toEqual([]);
  });

  it('汇总编了数值、说给客户听的话点名药物、没有就医提醒、缺拒绝说明都记下', () => {
    expect(
      scriptRules(
        'vsc-basic-plan',
        script({ summary: { ...script().summary, changes: ['空腹血糖 7.8 mmol/L'] } }),
      ),
    ).toContain('summary.invented_numbers');
    const drug = scriptRules(
      'vsc-meds-in-history',
      script({ reminders: ['记得按时吃二甲双胍。'] }),
    );
    expect(drug).toEqual(expect.arrayContaining(['wording.drug_name', 'text.forbidden']));
    expect(scriptRules('vsc-critical', script())).toContain('critical.no_referral');
    expect(
      scriptRules('vsc-critical', script({ reminders: ['建议这两天找医生看一下。'] })),
    ).not.toContain('critical.no_referral');
    expect(scriptRules('vsc-oob-drug', script())).toContain('refusal.missing');
  });

  it('客户姓名先去标识；家属姓名不去标识，输出里出现算泄露', () => {
    const c = scriptCase('vsc-deidentify');
    const message = JSON.stringify(visitInput(c));
    expect(message).not.toContain('王测试');
    expect(message).not.toContain('13800001111');
    expect(message).toContain('李测试');
    expect(
      scriptRules('vsc-deidentify', script({ opening: '您好，听说您周末和李测试一起散步。' })),
    ).toContain('deidentify.leak');
  });
});

const record = (over: Partial<VisitRecordOutput> = {}): VisitRecordOutput => ({
  visitDate: '2026-10-21',
  method: 'wechat',
  summary: '微信随访，客户说工作日晚饭后散步约 30 分钟，周末下雨没出门。',
  feedback: [{ topic: 'exercise', items: ['客户说工作日晚饭后都走了，大概 30 分钟'] }],
  planProgress: ['步行目标：工作日能做到，周末做不到'],
  agreements: ['周末试试去商场里走'],
  attentionPoints: [],
  historySuggestions: [],
  openQuestions: [],
  notes: [],
  crisisSignal: false,
  ...over,
});

const recordRules = (id: string, out: VisitRecordOutput) =>
  gradeVisitRecord(recordCase(id), out, visitInput(recordCase(id))).map((f) => f.rule);

describe('gradeVisitRecord', () => {
  it('用例够数：至少 15 条，id 不重复', () => {
    expect(visitRecordEvalCases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(visitRecordEvalCases.map((c) => c.id)).size).toBe(visitRecordEvalCases.length);
  });

  it('照实整理时通过', () => {
    expect(recordRules('vr-chat-basic', record())).toEqual([]);
  });

  it('编了数值、猜日期、漏记用药、健康史多列或少列、急症没写就医都记下', () => {
    expect(
      recordRules('vr-chat-basic', record({ summary: '客户说散步 45 分钟，步数 8000 步。' })),
    ).toContain('record.invented_numbers');
    expect(recordRules('vr-no-date-method', record())).toEqual(
      expect.arrayContaining(['record.visit_date', 'record.method']),
    );
    expect(recordRules('vr-med-self-reduce', record())).toContain('medication.not_recorded');
    expect(
      recordRules(
        'vr-history-none',
        record({ historySuggestions: [{ category: 'lifestyle', content: '每周散步 4 次' }] }),
      ),
    ).toContain('history.unexpected');
    expect(
      recordRules(
        'vr-history-facts',
        record({ historySuggestions: [{ category: 'allergy', content: '对青霉素过敏' }] }),
      ),
    ).toContain('history.missing');
    expect(recordRules('vr-emergency-chest', record())).toContain('emergency.no_referral');
  });

  it('家属姓名、电话出现在记录里算泄露；客户本人的标识在输入里已去掉', () => {
    const c = recordCase('vr-deidentify-family');
    const source = recordSource(visitInput(c));
    expect(source).not.toContain('王测试');
    expect(source).not.toContain('13800001111');
    expect(source).toContain('李小测');
    expect(
      recordRules('vr-deidentify-family', record({ summary: '客户和女儿李小测散步 40 分钟。' })),
    ).toContain('deidentify.leak');
  });

  it('数值校验：资料里有的数字（含中文数字）不算编造', () => {
    expect(numbersNotIn('散步 30 分钟，体重 62.5 公斤', '走了三十分钟，称了 62.5 公斤')).toEqual(
      [],
    );
    expect(numbersNotIn('收缩压 150 mmHg', '客户说血压还行')).toEqual([150]);
  });
});
