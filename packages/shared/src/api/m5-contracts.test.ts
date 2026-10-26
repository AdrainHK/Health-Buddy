import { describe, expect, it } from 'vitest';
import { approveArtifactRequestSchema, artifactSchema } from './artifacts.js';
import {
  carePlanStructuredSchema,
  endCarePlanRequestSchema,
  planOptionsSchema,
} from './care-plans.js';
import { libraryStatusRequestSchema } from './plan-library-admin.js';
import { sendMessageRequestSchema } from './tasks.js';
import {
  createVisitMaterialRequestSchema,
  updateVisitRequestSchema,
  visitScheduleStructuredSchema,
} from './visits.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('M5 契约', () => {
  it('方案选项：默认四部分、8 周；至少一个部分，不能重复；周期只能 4、8、12', () => {
    expect(planOptionsSchema.parse({})).toEqual({
      sections: ['diet', 'exercise', 'routine', 'mind'],
      cycleWeeks: 8,
    });
    expect(planOptionsSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(planOptionsSchema.safeParse({ sections: ['diet', 'diet'] }).success).toBe(false);
    expect(planOptionsSchema.safeParse({ cycleWeeks: 6 }).success).toBe(false);
  });

  it('方案结构：食谱只能在饮食部分，运动条目要有运动或心理部分，每餐一份', () => {
    const section = (s: string) => ({ section: s, professional: '', clientFacing: '', goals: [] });
    const recipe = { day: 1, meal: 'breakfast', recipeId: ID(1) };
    expect(
      carePlanStructuredSchema.safeParse({ sections: [section('diet')], recipes: [recipe] })
        .success,
    ).toBe(true);
    expect(
      carePlanStructuredSchema.safeParse({ sections: [section('routine')], recipes: [recipe] })
        .success,
    ).toBe(false);
    expect(
      carePlanStructuredSchema.safeParse({ sections: [section('diet')], recipes: [recipe, recipe] })
        .success,
    ).toBe(false);
    const exercise = { exerciseId: ID(2), frequencyPerWeek: 3, minutes: 20 };
    expect(
      carePlanStructuredSchema.safeParse({ sections: [section('mind')], exercises: [exercise] })
        .success,
    ).toBe(true);
    expect(
      carePlanStructuredSchema.safeParse({ sections: [section('diet')], exercises: [exercise] })
        .success,
    ).toBe(false);
    expect(endCarePlanRequestSchema.safeParse({}).success).toBe(false);
  });

  it('随访计划草稿：日期不能重复，不能有临时随访', () => {
    const row = { dueDate: '2026-11-09', method: 'phone', purpose: 'routine', focus: null };
    expect(visitScheduleStructuredSchema.safeParse({ rows: [row] }).success).toBe(true);
    expect(visitScheduleStructuredSchema.safeParse({ rows: [row, row] }).success).toBe(false);
    expect(
      visitScheduleStructuredSchema.safeParse({ rows: [{ ...row, purpose: 'adhoc' }] }).success,
    ).toBe(false);
  });

  it('处理随访：完成要关联记录或写备注；取消必须选原因', () => {
    expect(updateVisitRequestSchema.safeParse({ action: 'done' }).success).toBe(false);
    expect(updateVisitRequestSchema.safeParse({ action: 'done', note: '已电话沟通' }).success).toBe(
      true,
    );
    expect(updateVisitRequestSchema.safeParse({ action: 'done', recordId: ID(3) }).success).toBe(
      true,
    );
    expect(updateVisitRequestSchema.safeParse({ action: 'cancel' }).success).toBe(false);
    expect(updateVisitRequestSchema.safeParse({ action: 'reschedule' }).success).toBe(false);
  });

  it('随访素材不超过 20000 字', () => {
    expect(createVisitMaterialRequestSchema.safeParse({ text: '合'.repeat(20000) }).success).toBe(
      true,
    );
    expect(createVisitMaterialRequestSchema.safeParse({ text: '合'.repeat(20001) }).success).toBe(
      false,
    );
  });

  it('发消息：库条目和素材各最多 3 个、不能重复；素材只能交给技能', () => {
    const msg = { mode: 'craft', skillId: 'visit-record', content: '' };
    const refs = [ID(1), ID(2), ID(3)];
    expect(sendMessageRequestSchema.safeParse({ ...msg, materialRefs: refs }).success).toBe(true);
    expect(
      sendMessageRequestSchema.safeParse({ ...msg, materialRefs: [...refs, ID(4)] }).success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({ ...msg, materialRefs: [ID(1), ID(1)] }).success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({ mode: 'ask', content: '问', materialRefs: [ID(1)] })
        .success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({
        mode: 'ask',
        content: '这个早餐怎么样',
        libraryRefs: [{ type: 'recipe', id: ID(1) }],
      }).success,
    ).toBe(true);
    expect(
      sendMessageRequestSchema.safeParse({
        mode: 'ask',
        content: '问',
        libraryRefs: [{ type: 'goal_template', id: ID(1) }],
      }).success,
    ).toBe(false);
  });

  it('确认：跟进项最多 20 个且不重复；旧产物缺少新字段时按空处理', () => {
    const base = { version: 1, contentHash: 'h' };
    expect(approveArtifactRequestSchema.parse(base)).toMatchObject({
      acknowledgedAllergens: false,
      resolveFollowUpItemIds: [],
    });
    const ids = Array.from({ length: 21 }, (_, i) => ID(i + 1));
    expect(
      approveArtifactRequestSchema.safeParse({ ...base, resolveFollowUpItemIds: ids }).success,
    ).toBe(false);
    expect(
      approveArtifactRequestSchema.safeParse({ ...base, resolveFollowUpItemIds: [ID(1), ID(1)] })
        .success,
    ).toBe(false);
    expect(artifactSchema.shape.structured.parse(undefined)).toBeNull();
    expect(artifactSchema.shape.planOptions.parse(undefined)).toBeNull();
  });

  it('方案库发布必须填审定人和日期', () => {
    expect(libraryStatusRequestSchema.safeParse({ version: 1, status: 'published' }).success).toBe(
      false,
    );
    expect(
      libraryStatusRequestSchema.safeParse({
        version: 1,
        status: 'published',
        reviewedByLabel: '营养顾问甲',
        reviewedOn: '2026-10-26',
      }).success,
    ).toBe(true);
    expect(libraryStatusRequestSchema.safeParse({ version: 1, status: 'review' }).success).toBe(
      true,
    );
  });
});
