import { COMPANION_DEFAULT_SCRIPTS } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import {
  acceptCompanionMemory,
  buildCompanionMemoryRequest,
  buildCompanionRequest,
  checkCompanionReply,
  confirmsForgetAll,
  isAllowedMemory,
  matchMemoriesToForget,
  preCheckCompanionInput,
  type CompanionContext,
} from './index.js';

/** M6 第 4 步：福宝的确定性检查（规格 5.4）。全部是合成数据 */

const CTX: CompanionContext = {
  nameForClient: '王阿姨',
  ageBand: '60-69',
  nextVisit: { on: '2026-11-05', method: 'phone' },
  deliveries: [
    { kind: 'care_plan', content: '每天饭后散步 20 分钟；少吃咸菜。仅供参考，非医疗诊断。' },
  ],
  memories: ['客户喜欢听戏'],
  recentSummaries: ['聊了孙子放假回家'],
  today: '2026-10-29',
};

describe('调用模型前的检查', () => {
  it('危机、急症关键词', () => {
    expect(preCheckCompanionInput('最近总想着不如死了算了')).toMatchObject({ crisis: true });
    expect(preCheckCompanionInput('我胸口痛，还出冷汗')).toMatchObject({ emergency: true });
    expect(preCheckCompanionInput('今天天气真好')).toEqual({
      crisis: false,
      emergency: false,
      medical: null,
      forget: null,
    });
  });

  it.each([
    ['我这个降压药能不能停', 'medication'],
    ['药要吃几片', 'medication'],
    ['这个药饭前吃还是饭后吃呢', 'medication'],
    ['我是不是得了糖尿病', 'diagnosis'],
    ['血压 150 高不高', 'exam'],
    ['化验单上那个指标怎么回事', 'exam'],
    ['我要不要去医院看看', 'other'],
    ['这两天头有点疼', 'symptom'],
  ])('用药、症状、诊断类问题直接转交：%s', (text, category) => {
    expect(preCheckCompanionInput(text).medical).toBe(category);
  });

  it('说“药吃过了”不是问题，不转交', () => {
    expect(preCheckCompanionInput('早上的药吃过了').medical).toBeNull();
  });

  it('“忘掉……”命令（N11）', () => {
    expect(preCheckCompanionInput('把我去北京的事忘掉吧').forget).toEqual({
      all: false,
      query: '我去北京',
    });
    expect(preCheckCompanionInput('把我的事全都忘掉').forget?.all).toBe(true);
    expect(confirmsForgetAll('对，全都忘掉')).toBe(true);
    expect(confirmsForgetAll('算了')).toBe(false);
    const memories = [
      { id: 1, text: '客户下周要去北京看孙子' },
      { id: 2, text: '客户喜欢听戏' },
    ];
    expect(matchMemoriesToForget(memories, '我去北京').map((m) => m.id)).toEqual([1]);
    expect(matchMemoriesToForget(memories, '')).toEqual([]);
  });
});

describe('输出检查', () => {
  it('合格的回答', () => {
    expect(checkCompanionReply('记下了，我会告诉您的健管师。')).toEqual([]);
    expect(checkCompanionReply('我是 AI 伴侣福宝，饭后散步二十分钟挺好的。')).toEqual([]);
  });

  it.each([
    ['您的血压偏高了，要注意。', 'judgment'],
    ['这可能是高血压。', 'presumed_disease'],
    ['可以吃点阿司匹林。', 'drug_name'],
    ['健管师会给您打电话的。', 'manager_promise'],
    ['坚持下去就能根治。', 'banned_term'],
    ['坚持下去一定能治好。', 'efficacy_claim'],
    ['第一，多喝水；第二，多走路；第三，早点睡；第四，少吃盐。', 'too_long'],
    ['您可以这样做：1. 散步 2. 喝水', 'symbols'],
    ['', 'empty'],
  ])('不合格：%s', (text, category) => {
    expect(checkCompanionReply(text).map((i) => i.category)).toContain(category);
  });

  it('危机后的陪伴里不能说“没事”', () => {
    expect(
      checkCompanionReply('没事的，您先别担心。', { crisis: true }).map((i) => i.category),
    ).toContain('reassurance');
  });

  it('默认固定话术本身能通过输出检查（念出来的标准一致）', () => {
    for (const kind of [
      'handoff',
      'fallback',
      'rate_limited',
      'asr_retry',
      'memory_forgotten',
    ] as const) {
      expect(checkCompanionReply(COMPANION_DEFAULT_SCRIPTS[kind])).toEqual([]);
    }
  });
});

describe('提示词和资料', () => {
  it('资料里只有能读的内容；客户的话去掉电话和证件号', () => {
    const { system, messages } = buildCompanionRequest(CTX, [
      { role: 'client', text: '我电话是 13800138000' },
      { role: 'companion', text: '好的' },
    ]);
    expect(system).toContain('王阿姨');
    expect(system).toContain('每天饭后散步 20 分钟');
    expect(system).toContain('2026-11-05，电话');
    expect(messages[0]!.content).not.toContain('13800138000');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(buildCompanionRequest(CTX, [], 'crisis').system).toContain('求助话术');
  });

  it('记忆整理：去掉病名、药名、判断和重复', () => {
    expect(isAllowedMemory('客户喜欢听戏')).toBe(true);
    expect(isAllowedMemory('客户有高血压')).toBe(false);
    expect(isAllowedMemory('客户每天早上吃药')).toBe(false);
    expect(
      acceptCompanionMemory(
        {
          memories: ['客户喜欢听戏', '客户的孙子下周放假', '客户血压偏高', '客户在吃二甲双胍'],
          summary: '聊了孙子放假的事。',
        },
        ['客户喜欢听戏'],
      ),
    ).toEqual({ memories: ['客户的孙子下周放假'], summary: '聊了孙子放假的事。' });
    expect(
      acceptCompanionMemory({ memories: [], summary: '客户说自己得了糖尿病。' }, []).summary,
    ).toBeNull();
    const req = buildCompanionMemoryRequest([{ role: 'client', text: '我住在幸福路 8 号' }], []);
    expect(req.messages[0]!.content).not.toContain('幸福路 8 号');
  });
});
