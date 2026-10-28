import { describe, expect, it } from 'vitest';
import { ASK_PLAN_RULES, asksAboutLibrary, type AskLibraryItem } from './ask-plan.js';
import { ASK_SYSTEM_PROMPT, askSystemPrompt, buildAskUserContent } from './ask.js';
import type { PlanContext, PlanLibraryContext } from './plan-input.js';
import { TWIN_SNAPSHOTS } from './twin-fixtures.js';

/** 问一问读方案、随访和方案库（M5 规格 2.11）。全部是合成数据 */

const PLAN: PlanContext = {
  currentPlan: {
    startDate: '2026-10-01',
    reviewDate: '2026-11-26',
    cycleWeeks: 8,
    sections: ['exercise'],
    goals: [{ section: 'exercise', text: '每天步行 7000 步' }],
  },
  recentRecords: [
    {
      visitDate: '2026-10-15',
      method: 'phone',
      summary: '客户说周末很少出门。',
      agreements: ['周末也散步'],
    },
  ],
  adherence: ['每天步行 7000 步：近 7 天有数据 5 天，平均 6320 步，达标 3 天'],
};

const RECIPE: AskLibraryItem = {
  type: 'recipe',
  name: '合成花生拌面',
  mealTypes: ['breakfast'],
  tags: ['quick'],
  allergens: ['peanut'],
  ingredients: [{ name: '面条', householdAmount: '一拳' }],
  steps: ['煮面', '拌匀'],
  energyKcal: 420,
  conflicts: ['peanut'],
};

const WALK: AskLibraryItem = {
  type: 'exercise',
  name: '合成快走',
  category: 'aerobic',
  intensity: 'moderate',
  steps: ['快走 20 分钟'],
  keyPoints: ['能说话不能唱歌'],
  managerCautions: '膝关节不适时改为散步',
  restriction: '有危急指标',
};

const CANDIDATES: PlanLibraryContext = {
  options: { sections: ['diet', 'exercise', 'routine', 'mind'], cycleWeeks: 8 },
  recipes: [
    {
      id: 'r1',
      version: 1,
      name: '合成燕麦粥',
      mealTypes: ['breakfast'],
      tags: [],
      allergens: [],
      ingredients: [],
      steps: [],
      energyKcal: null,
    },
  ],
  exercises: [],
  goalTemplates: [],
  excludedForAllergy: 2,
  exerciseRestriction: null,
  libraryEmpty: false,
};

describe('问一问读方案和方案库', () => {
  it('引用客户时附上当前方案、执行情况、随访记录，问题在最后', () => {
    const text = buildAskUserContent(TWIN_SNAPSHOTS.stable, '方案执行得怎么样', { plan: PLAN });
    expect(text).toContain('## 当前方案');
    expect(text).toContain('每天步行 7000 步');
    expect(text).toContain('## 方案执行情况（系统按监测数据算出）');
    expect(text).toContain('约定的事：周末也散步');
    expect(text.trimEnd().endsWith('## 健管师的问题\n方案执行得怎么样')).toBe(true);
  });

  it('@ 的食谱写过敏原提示，@ 的运动写运动安全规则；放松练习不受运动安全规则限制', () => {
    const text = buildAskUserContent(undefined, '合适吗', { libraryItems: [RECIPE, WALK] });
    expect(text).toContain('### 食谱：合成花生拌面');
    expect(text).toContain('过敏原：花生');
    expect(text).toContain('该客户健康史里有花生过敏');
    expect(text).toContain('### 有氧：合成快走');
    expect(text).toContain('运动安全规则（系统判断）**：有危急指标');
    const relax = buildAskUserContent(undefined, '合适吗', {
      libraryItems: [{ ...WALK, category: 'relaxation' }],
    });
    expect(relax).not.toContain('运动安全规则');
  });

  it('候选条目按餐次只列名称，写明排除了几份', () => {
    const text = buildAskUserContent(TWIN_SNAPSHOTS.stable, '早餐吃什么', {
      candidates: CANDIDATES,
    });
    expect(text).toContain('- 早餐：合成燕麦粥');
    expect(text).toContain('因过敏史排除了 2 份食谱');
    expect(
      buildAskUserContent(undefined, '吃什么', {
        candidates: { ...CANDIDATES, libraryEmpty: true },
      }),
    ).toContain('方案库待审定');
  });

  it('没有方案和库资料时提示词和以前一样；有时加上方案规则', () => {
    expect(buildAskUserContent(undefined, '你好')).toBe('你好');
    expect(askSystemPrompt(undefined)).toBe(ASK_SYSTEM_PROMPT);
    expect(askSystemPrompt(undefined, { plan: PLAN })).toContain(ASK_PLAN_RULES);
    expect(ASK_PLAN_RULES).toContain('不能修改方案');
  });

  it('只有问吃什么、怎么运动时才读候选条目', () => {
    expect(asksAboutLibrary('这位客户早餐适合吃什么')).toBe(true);
    expect(asksAboutLibrary('推荐几个放松练习')).toBe(true);
    for (const q of ['他能不能吃水果', '平时吃啥好', '每天跑步可以吗', '适合练太极吗']) {
      expect(asksAboutLibrary(q), q).toBe(true);
    }
    expect(asksAboutLibrary('最近血压怎么样')).toBe(false);
  });
});
