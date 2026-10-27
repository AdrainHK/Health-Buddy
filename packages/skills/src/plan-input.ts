import type { PlanSection, VisitMethod, VisitPurpose } from '@health-buddy/shared';

/**
 * 方案和随访技能的输入（M5 规格 5.2）。由后端组装，只有健康数据和日程，不含客户姓名、电话等。
 * 当前方案、随访记录只给专业版和随访类产物用（未处理的跟进项在孪生资料里）；计划的日期由后端算好，模型不能改。
 */

export const PLAN_SECTION_ZH: Record<PlanSection, string> = {
  diet: '饮食',
  exercise: '运动',
  routine: '作息',
  mind: '心理',
};

export const VISIT_METHOD_ZH: Record<VisitMethod, string> = {
  phone: '电话',
  wechat: '微信',
  in_person: '面谈',
  video: '视频',
};

export const VISIT_PURPOSE_ZH: Record<VisitPurpose, string> = {
  routine: '常规随访',
  plan_review: '方案复评',
  follow_up: '跟进项回访',
  adhoc: '临时随访',
};

/** 生效方案的摘要（不含通俗版全文） */
export interface CarePlanDigest {
  startDate: string;
  reviewDate: string;
  cycleWeeks: number;
  sections: PlanSection[];
  /** 每部分的行为目标，已由模板和参数渲染成文字 */
  goals: { section: PlanSection; text: string }[];
}

/** 最近的随访记录（已确认），只取摘要和约定的事 */
export interface VisitRecordDigest {
  visitDate: string;
  method: VisitMethod;
  summary: string;
  agreements: string[];
}

/** 后端按频次规则算好的一次随访：日期和目的类别不能改（Q17） */
export interface ScheduledVisitRow {
  dueDate: string;
  purpose: Exclude<VisitPurpose, 'adhoc'>;
  method: VisitMethod;
}

export interface PlanContext {
  currentPlan: CarePlanDigest | null;
  recentRecords: VisitRecordDigest[];
  /** /随访计划：后端算好的随访日期（按日期升序） */
  schedule?: {
    today: string;
    /** 按哪一档的间隔排的（高、中、低、未分层） */
    tierLabel: string;
    intervalDays: number;
    rows: ScheduledVisitRow[];
  };
}

/** 方案和随访的资料，接在客户资料后面 */
export function describePlanContext(plan: PlanContext): string {
  const lines: string[] = ['## 当前方案'];
  const p = plan.currentPlan;
  if (!p) lines.push('没有生效的方案。');
  else {
    lines.push(
      `- 生效日期 ${p.startDate}，周期 ${p.cycleWeeks} 周，复评日期 ${p.reviewDate}`,
      `- 包含：${p.sections.map((s) => PLAN_SECTION_ZH[s]).join('、')}`,
    );
    if (!p.goals.length) lines.push('- 行为目标：没有');
    for (const g of p.goals) lines.push(`- 行为目标（${PLAN_SECTION_ZH[g.section]}）：${g.text}`);
  }

  lines.push('', '## 最近的随访记录（已由健管师确认）');
  if (!plan.recentRecords.length) lines.push('没有随访记录。');
  for (const r of plan.recentRecords) {
    lines.push(`- ${r.visitDate}（${VISIT_METHOD_ZH[r.method]}）：${r.summary}`);
    for (const a of r.agreements) lines.push(`  - 约定的事：${a}`);
  }

  return lines.join('\n');
}

/** /随访计划：后端排好的日期表（模型照抄日期和目的，只写方式建议和重点） */
export function describeSchedule(schedule: NonNullable<PlanContext['schedule']>): string {
  const lines = [
    '## 系统排好的随访日期',
    `今天：${schedule.today}；按风险分层“${schedule.tierLabel}”的间隔 ${schedule.intervalDays} 天排（日期和目的不能改）。`,
  ];
  schedule.rows.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.dueDate} · ${VISIT_PURPOSE_ZH[r.purpose]} · 默认方式：${VISIT_METHOD_ZH[r.method]}`,
    );
  });
  return lines.join('\n');
}

/** 方案上下文里健管师和 AI 写的自由文字（随访记录的摘要和约定），组装提示词前去标识 */
export function redactPlanContext(plan: PlanContext, redact: (t: string) => string): PlanContext {
  return {
    ...plan,
    recentRecords: plan.recentRecords.map((r) => ({
      ...r,
      summary: redact(r.summary),
      agreements: r.agreements.map(redact),
    })),
  };
}

/** 方案上下文里的自由文字（危机和急症的关键词识别也看这些） */
export function planFreeTexts(plan: PlanContext | undefined): string[] {
  if (!plan) return [];
  return plan.recentRecords.flatMap((r) => [r.summary, ...r.agreements]);
}
