import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SkillInput } from './framework.js';
import { redactPlanContext, planFreeTexts, type PlanContext } from './plan-input.js';
import { getSkill, skillSummaries } from './registry.js';
import { TWIN_SNAPSHOTS } from './twin-fixtures.js';
import {
  validateVisitRecord,
  visitRecord,
  visitRecordStructured,
  type VisitRecordOutput,
} from './visit-record/index.js';
import { validateVisitScript, visitScript, type VisitScriptOutput } from './visit-script/index.js';

/** M5 第 6 步：/随访话术、/随访记录（规格 2.8、2.9、5.3）。全部是合成数据 */

const PLAN: PlanContext = {
  currentPlan: {
    startDate: '2026-10-01',
    reviewDate: '2026-11-26',
    cycleWeeks: 8,
    sections: ['diet', 'exercise'],
    goals: [{ section: 'exercise', text: '每天步行 7000 步' }],
  },
  recentRecords: [
    {
      visitDate: '2026-10-15',
      method: 'phone',
      summary: '该客户说工作日晚饭后散步。',
      agreements: ['周末也散步'],
    },
  ],
  adherence: ['每天步行 7000 步：近 7 天有数据 5 天，平均 6320 步，达标 3 天'],
  visit: { dueDate: '2026-10-28', purpose: 'routine', method: 'phone', focus: '了解周末散步' },
  today: '2026-10-28',
};
const input = (plan: PlanContext = PLAN, request = ''): SkillInput => ({
  client: TWIN_SNAPSHOTS.stable,
  managerRequest: request,
  plan,
});

const script = (over: Partial<VisitScriptOutput> = {}): VisitScriptOutput => ({
  summary: {
    changes: ['近 7 天步数平均 6320 步（日常监测）'],
    adherence: ['每天步行 7000 步：近 7 天达标 3 天'],
    followUps: [],
    agreements: ['周末也散步'],
  },
  opening: '您好，今天想和您聊聊最近散步的情况。',
  questions: [
    { section: 'exercise', question: '这周末有没有出去走一走？', why: '上次约定周末也散步' },
    { section: 'exercise', question: '散步时一般走多久？', why: '近 7 天达标 3 天' },
    { section: 'diet', question: '最近晚饭一般吃些什么？', why: '方案包含饮食部分' },
  ],
  encouragement: ['工作日都坚持散步，很不容易。'],
  adjustments: ['周末要不要约家人一起走？'],
  reminders: [],
  notes: [],
  crisisSignal: false,
  ...over,
});

describe('/随访话术', () => {
  it('登记在技能表里：只有专业版、读方案上下文、不接专家', () => {
    expect(getSkill('visit-script')).toBe(visitScript);
    expect(visitScript).toMatchObject({
      kind: 'visit_script',
      clientFacing: false,
      planContext: 'visit_script',
      experts: 'none',
    });
    expect(skillSummaries().find((s) => s.id === 'visit-script')).toMatchObject({
      allowsEmptyRequest: true,
      usesMaterials: false,
    });
  });

  it('用户消息里有当前方案、随访记录、这一次随访和执行情况', () => {
    const message = visitScript.buildUserMessage(input());
    expect(message).toContain('## 这一次随访');
    expect(message).toContain('了解周末散步');
    expect(message).toContain('## 方案执行情况（系统按监测数据算出）');
    expect(message).toContain('平均 6320 步');
    expect(message).toContain('周末也散步');
  });

  it('渲染：顶部有免责声明，问题按部分分组，有伴侣对话要点和不要说的话', () => {
    const { professional, clientFacing } = visitScript.render(script(), input());
    expect(clientFacing).toBe('');
    expect(professional.startsWith('仅供参考，非医疗诊断')).toBe(true);
    // 没有读伴侣资料时按没有开通写（M6）
    expect(professional).toContain('**伴侣对话要点**\n- 客户没有开通伴侣“福宝”');
    expect(professional.indexOf('**饮食**')).toBeLessThan(professional.indexOf('**运动**'));
    expect(professional).toContain('为什么问：上次约定周末也散步');
    expect(professional).toContain('## 不要说的话');
  });

  it('说给客户听的话按面向客户的标准检查：疾病、风险、药名、功效承诺都拦下', () => {
    expect(visitScript.checkOutput!(script(), input())).toEqual([]);
    const bad = script({
      opening: '您的高血压风险很高，今天聊聊。',
      reminders: ['坚持吃二甲双胍，保证血糖降下来。'],
    });
    const categories = new Set(visitScript.checkOutput!(bad, input()).map((i) => i.category));
    for (const c of ['presumed_disease', 'judgment', 'drug_name', 'efficacy_claim']) {
      expect(categories.has(c as never), c).toBe(true);
    }
  });

  it('结构校验：问题 3–8 个、开场不为空', () => {
    expect(validateVisitScript(script())).toEqual([]);
    expect(validateVisitScript(script({ questions: script().questions.slice(0, 2) }))).toEqual([
      'questions_count',
    ]);
    expect(validateVisitScript(script({ opening: ' ' }))).toEqual(['opening_empty']);
  });
});

const record = (over: Partial<VisitRecordOutput> = {}): VisitRecordOutput => ({
  visitDate: '2026-10-27',
  method: 'phone',
  summary: '电话随访，客户说工作日晚饭后散步，周末较少活动。',
  feedback: [
    { topic: 'exercise', items: ['客户说晚饭后散步 20 分钟，每周约 4 次'] },
    { topic: 'medication', items: ['客户说最近自行减少了氨氯地平'] },
  ],
  planProgress: ['步行目标：客户说工作日能做到，周末做不到'],
  agreements: ['周末约家人一起散步'],
  attentionPoints: ['用药调整请客户与医生确认'],
  historySuggestions: [{ category: 'lifestyle', content: '每周饮酒 3 次' }],
  openQuestions: ['周末的作息'],
  notes: [],
  crisisSignal: false,
  ...over,
});

describe('/随访记录', () => {
  it('登记在技能表里：只有做一做、要 @ 素材、只有专业版', () => {
    expect(getSkill('visit-record')).toBe(visitRecord);
    expect(visitRecord).toMatchObject({
      kind: 'visit_record',
      clientFacing: false,
      modes: ['craft'],
      planContext: 'visit_record',
      usesMaterials: true,
    });
    expect(skillSummaries().find((s) => s.id === 'visit-record')).toMatchObject({
      usesMaterials: true,
    });
  });

  it('用户消息里有素材原文（代码块），素材里的 ``` 不会提前结束代码块', () => {
    const message = visitRecord.buildUserMessage(
      input({ ...PLAN, materials: [{ uploadedOn: '2026-10-27', text: '散步 ``` 20 分钟' }] }),
    );
    expect(message).toContain('### 素材 1（2026-10-27 上传）');
    expect(message).toContain("散步 ''' 20 分钟");
  });

  it('素材和随访重点进入去标识和危机、急症关键词识别', () => {
    const plan = { ...PLAN, materials: [{ uploadedOn: '2026-10-27', text: '王测试说胸痛' }] };
    expect(planFreeTexts(plan)).toContain('王测试说胸痛');
    const redacted = redactPlanContext(plan, (t) => t.replace('王测试', '该客户'));
    expect(redacted.materials![0]!.text).toBe('该客户说胸痛');
  });

  it('结构化内容符合契约：截断、去空、按主题顺序；日期不合格时留空', () => {
    const s = visitRecordStructured(
      record({
        visitDate: '2026/10/27',
        feedback: [
          { topic: 'medication', items: ['客户说最近自行减少了氨氯地平', ' '] },
          { topic: 'diet', items: ['客户说'.padEnd(600, '多')] },
        ],
      }),
    );
    expect(s.visitDate).toBeNull();
    expect(s.feedback.map((f) => f.topic)).toEqual(['diet', 'medication']);
    expect(s.feedback[0]!.items[0]!.length).toBe(500);
    expect(s.feedback[1]!.items).toEqual(['客户说最近自行减少了氨氯地平']);
  });

  it('渲染：只有专业版，没写日期方式时提示填写；危机置顶', () => {
    const { professional, clientFacing, structured } = visitRecord.render(
      record({ visitDate: null, method: null, crisisSignal: true }),
      input(),
    );
    expect(clientFacing).toBe('');
    expect(professional.startsWith('## 心理危机提示')).toBe(true);
    expect(professional).toContain('- 日期：（请填写）');
    expect(professional).toContain('生活习惯：每周饮酒 3 次');
    expect(structured).toMatchObject({ visitDate: null, method: null });
  });

  it('措辞检查：药名只能出现在用药情况和用药史；病名只能出现在健康史；疾病判断和用药建议拦下', () => {
    expect(visitRecord.checkOutput!(record(), input())).toEqual([]);
    const history = record({
      historySuggestions: [
        { category: 'family_history', content: '父亲有高血压' },
        { category: 'medication', content: '长期服用氨氯地平' },
      ],
    });
    expect(visitRecord.checkOutput!(history, input())).toEqual([]);
    const judged = record({
      historySuggestions: [{ category: 'past_history', content: '疑似糖尿病' }],
    });
    expect(visitRecord.checkOutput!(judged, input()).map((i) => i.category)).toEqual(['judgment']);
    const bad = record({
      summary: '客户疑似患有糖尿病，建议把氨氯地平减半。',
    });
    const categories = new Set(visitRecord.checkOutput!(bad, input()).map((i) => i.category));
    for (const c of ['judgment', 'presumed_disease', 'drug_name']) {
      expect(categories.has(c as never), c).toBe(true);
    }
  });

  it('客户说的饮食份量不算剂量；用药情况可以有药名，但不能有病名和 AI 给的用药建议', () => {
    const ok = record({
      summary: '客户说晚饭米饭换成了半碗杂粮饭，每周喝三次白酒，每次二两左右。',
      feedback: [
        { topic: 'diet', items: ['客户说每天喝一杯牛奶'] },
        { topic: 'medication', items: ['客户说降压药每天一片，最近隔一天吃一次'] },
      ],
    });
    expect(visitRecord.checkOutput!(ok, input())).toEqual([]);
    const bad = (items: string[]) =>
      visitRecord.checkOutput!(record({ feedback: [{ topic: 'medication', items }] }), input()).map(
        (i) => i.category,
      );
    expect(bad(['建议继续服用降压药'])).toContain('drug_advice');
    expect(bad(['客户说因为糖尿病在吃二甲双胍'])).toContain('presumed_disease');
    const history = (category: 'lifestyle' | 'past_history', content: string) =>
      visitRecord.checkOutput!(
        record({ historySuggestions: [{ category, content }] }),
        input(),
      ).map((i) => i.category);
    expect(history('lifestyle', '有糖尿病')).toContain('presumed_disease');
    expect(history('past_history', '建议把氨氯地平减成半片')).toEqual(
      expect.arrayContaining(['drug_name', 'drug_advice']),
    );
  });

  it('日期校验：格式不对或晚于今天（留一天时区余量）不合格；null 可以', () => {
    expect(validateVisitRecord(record(), input())).toEqual([]);
    expect(validateVisitRecord(record({ visitDate: null }), input())).toEqual([]);
    expect(validateVisitRecord(record({ visitDate: '2026-10-29' }), input())).toEqual([]);
    expect(validateVisitRecord(record({ visitDate: '2026-10-30' }), input())).toEqual([
      'date_invalid',
    ]);
    expect(validateVisitRecord(record({ visitDate: '10月27日' }), input())).toEqual([
      'date_invalid',
    ]);
  });
});

describe('第 6 步技能的输出结构', () => {
  it('不带数值范围和长度限制（Claude 的结构化输出不接受）', () => {
    for (const skill of [visitScript, visitRecord]) {
      const schema = JSON.stringify(z.toJSONSchema(skill.outputSchema, { io: 'output' }));
      expect(schema).not.toMatch(/"(?:minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
    }
  });
});
