import type {
  Allergen,
  ExerciseCategory,
  GoalMetric,
  GoalParam,
  LibraryTag,
  MealType,
  PlanOptions,
  PlanSection,
  VisitMethod,
  VisitPurpose,
} from '@health-buddy/shared';

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

/** /方案生成 的候选食谱（后端已按过敏原排除，Q16）。食材和做法用于后端渲染通俗版 */
export interface RecipeCandidate {
  id: string;
  version: number;
  name: string;
  mealTypes: MealType[];
  tags: LibraryTag[];
  allergens: Allergen[];
  ingredients: { name: string; householdAmount: string }[];
  steps: string[];
  energyKcal: number | null;
}

/** 候选的运动和放松练习（运动安全规则不允许时为空，Q8） */
export interface ExerciseCandidate {
  id: string;
  version: number;
  name: string;
  category: ExerciseCategory;
  intensity: 'low' | 'moderate';
  steps: string[];
  keyPoints: string[];
  /** 给健管师看的注意事项：只写进专业版 */
  managerCautions: string;
}

/** 目标模板（只能从这里选，参数在范围内，Q3） */
export interface GoalTemplateCandidate {
  id: string;
  version: number;
  section: PlanSection;
  text: string;
  params: GoalParam[];
  metric: GoalMetric | null;
}

/** /方案生成 的方案库候选和规则（规格 5.2） */
export interface PlanLibraryContext {
  options: PlanOptions;
  recipes: RecipeCandidate[];
  exercises: ExerciseCandidate[];
  goalTemplates: GoalTemplateCandidate[];
  /** 因过敏史排除了几份食谱（只记数量） */
  excludedForAllergy: number;
  /**
   * 运动安全规则（Q8）：有危急指标、急症信号，或健康史里有心脏病、近期手术、严重骨关节病时，
   * 运动部分只写“建议先就医评估再开始运动”，不给动作、强度和时长。这里写原因类别；不限制时为 null
   */
  exerciseRestriction: string | null;
  /** 正式环境的方案库还没有已发布条目（4.1）：饮食和运动只写原则，写明“方案库待审定” */
  libraryEmpty: boolean;
}

/** 这一次随访（/随访话术“准备随访”、/随访记录“记录随访”）：后端读到的日期、目的、方式和重点 */
export interface VisitDigest {
  dueDate: string;
  purpose: VisitPurpose;
  method: VisitMethod;
  focus: string | null;
}

/** /随访记录 的素材：后端解密、去标识后的原文和上传日期 */
export interface VisitMaterialDigest {
  uploadedOn: string;
  text: string;
}

export interface PlanContext {
  currentPlan: CarePlanDigest | null;
  recentRecords: VisitRecordDigest[];
  /**
   * 当前方案的执行情况（2.6、Q10，后端确定性计算）：每个关联监测的目标一句，
   * 如“每天步行 7000 步：近 7 天有数据 5 天，平均 6320 步，达标 3 天”。/随访话术 用
   */
  adherence?: string[];
  /** /随访话术、/随访记录：关联的那一次随访（没有关联时为下一次待随访） */
  visit?: VisitDigest | null;
  /** /随访记录：@ 的随访素材（已去标识） */
  materials?: VisitMaterialDigest[];
  /** 健管师时区的今天（YYYY-MM-DD）：/随访记录 校验随访日期不晚于今天 */
  today?: string;
  /** /方案生成：候选库条目、目标模板和方案选项 */
  library?: PlanLibraryContext;
  /** /随访计划：后端算好的随访日期（按日期升序） */
  schedule?: {
    today: string;
    /** 按哪一档的间隔排的（高、中、低、未分层） */
    tierLabel: string;
    intervalDays: number;
    rows: ScheduledVisitRow[];
    /**
     * 想一想“方案和随访”（2.10）：方案复评按同一次计划刚生成的方案草稿排（草稿还没确认，
     * 确认随访计划时这一行标为“待方案生效”）。只排随访计划时没有
     */
    draftPlan?: { cycleWeeks: number; reviewDate: string; replacesCurrent: boolean };
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
  if (schedule.draftPlan) {
    lines.push(
      `方案复评按本次刚生成的方案草稿排：周期 ${schedule.draftPlan.cycleWeeks} 周，复评日期 ${schedule.draftPlan.reviewDate}（方案确认生效后才写入日程）。` +
        (schedule.draftPlan.replacesCurrent
          ? '上面“当前方案”是正在执行的旧方案，新方案生效后被替代。'
          : ''),
    );
  }
  schedule.rows.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.dueDate} · ${VISIT_PURPOSE_ZH[r.purpose]} · 默认方式：${VISIT_METHOD_ZH[r.method]}`,
    );
  });
  return lines.join('\n');
}

/**
 * 方案上下文里健管师、AI 和客户写的自由文字（随访记录的摘要和约定、随访的重点、素材原文），
 * 组装提示词前去标识
 */
export function redactPlanContext(plan: PlanContext, redact: (t: string) => string): PlanContext {
  return {
    ...plan,
    recentRecords: plan.recentRecords.map((r) => ({
      ...r,
      summary: redact(r.summary),
      agreements: r.agreements.map(redact),
    })),
    ...(plan.visit
      ? { visit: { ...plan.visit, focus: plan.visit.focus && redact(plan.visit.focus) } }
      : {}),
    ...(plan.materials
      ? { materials: plan.materials.map((m) => ({ ...m, text: redact(m.text) })) }
      : {}),
  };
}

/** 方案上下文里的自由文字（危机和急症的关键词识别也看这些，包括随访素材） */
export function planFreeTexts(plan: PlanContext | undefined): string[] {
  if (!plan) return [];
  return [
    ...plan.recentRecords.flatMap((r) => [r.summary, ...r.agreements]),
    ...(plan.visit?.focus ? [plan.visit.focus] : []),
    ...(plan.materials ?? []).map((m) => m.text),
  ];
}

/** /随访话术、/随访记录：这一次随访和方案执行情况 */
export function describeVisit(plan: PlanContext): string {
  const lines = ['## 这一次随访'];
  const v = plan.visit;
  if (!v) lines.push('没有关联的随访（健管师临时联系客户）。');
  else {
    lines.push(
      `- 日期 ${v.dueDate} · ${VISIT_PURPOSE_ZH[v.purpose]} · 方式：${VISIT_METHOD_ZH[v.method]}`,
      `- 重点：${v.focus ?? '没有写'}`,
    );
  }
  if (plan.adherence) {
    lines.push('', '## 方案执行情况（系统按监测数据算出）');
    if (!plan.adherence.length) lines.push('没有关联监测数据的目标，执行情况需要在随访时了解。');
    for (const a of plan.adherence) lines.push(`- ${a}`);
  }
  return lines.join('\n');
}

/** /随访记录：素材原文（已去标识），只能整理里面有的内容 */
export function describeMaterials(materials: readonly VisitMaterialDigest[]): string {
  const lines = ['## 随访素材（已去掉姓名和联系方式；只能整理这里写了的内容）'];
  materials.forEach((m, i) => {
    // 素材里的 ``` 换掉，免得提前结束代码块
    lines.push(
      '',
      `### 素材 ${i + 1}（${m.uploadedOn} 上传）`,
      '```',
      m.text.replace(/`{3,}/g, "'''"),
      '```',
    );
  });
  return lines.join('\n');
}

const MEAL_ZH: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const TAG_ZH: Record<LibraryTag, string> = {
  low_oil: '少油',
  low_salt: '少盐',
  high_fiber: '高纤维',
  quality_protein: '优质蛋白',
  mixed_grains: '粗细搭配',
  vegetable_rich: '蔬菜多',
  low_sugar: '少糖',
  quick: '做法简单',
  vegetarian: '素食',
};

const CATEGORY_ZH: Record<ExerciseCategory, string> = {
  aerobic: '有氧',
  strength: '力量',
  flexibility: '柔韧',
  balance: '平衡',
  relaxation: '放松练习',
};

export { CATEGORY_ZH as EXERCISE_CATEGORY_ZH, MEAL_ZH };

/** /方案生成：方案选项和候选条目。模型只能选这里的 id，参数在范围内 */
export function describeLibrary(lib: PlanLibraryContext): string {
  const lines = [
    '## 方案选项',
    `- 包含：${lib.options.sections.map((s) => PLAN_SECTION_ZH[s]).join('、')}（只写这几部分）`,
    `- 周期：${lib.options.cycleWeeks} 周`,
  ];
  if (lib.libraryEmpty) {
    lines.push(
      '',
      '方案库待审定，暂时没有可用的食谱和动作：饮食和运动只写原则，不给示例；通俗版写“库中暂无合适的示例”，专业版写明“方案库待审定”。',
    );
  }
  if (lib.exerciseRestriction) {
    lines.push(
      '',
      `## 运动安全规则：${lib.exerciseRestriction}`,
      '运动部分只写“建议先就医评估再开始运动”，不选运动动作，不写强度、频率和时长；exercises 里只能有心理部分的放松练习。',
    );
  }
  lines.push('', '## 候选食谱（只能选这里的 id；已按过敏史排除不合适的）');
  if (lib.excludedForAllergy) lines.push(`因过敏史排除了 ${lib.excludedForAllergy} 份食谱。`);
  if (!lib.recipes.length) lines.push('没有候选食谱。');
  for (const r of lib.recipes) {
    const energy = r.energyKcal === null ? '' : `；约 ${r.energyKcal} 千卡/份`;
    lines.push(
      `- ${r.id}：${r.name}（${r.mealTypes.map((m) => MEAL_ZH[m]).join('、')}；${r.tags.map((t) => TAG_ZH[t]).join('、') || '无标签'}${energy}）`,
    );
  }
  lines.push('', '## 候选动作和放松练习（只能选这里的 id）');
  if (!lib.exercises.length) lines.push('没有候选动作。');
  for (const e of lib.exercises) {
    lines.push(
      `- ${e.id}：${e.name}（${CATEGORY_ZH[e.category]}，${e.intensity === 'low' ? '低强度' : '中等强度'}；注意事项：${e.managerCautions}）`,
    );
  }
  lines.push('', '## 目标模板（只能选这里的 id，参数在范围内）');
  if (!lib.goalTemplates.length) lines.push('没有可用的目标模板。');
  for (const t of lib.goalTemplates) {
    const params = t.params
      .map((p) =>
        p.type === 'int'
          ? `${p.name}：整数 ${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ''}，默认 ${p.default}`
          : `${p.name}：时间 ${p.min}–${p.max}，默认 ${p.default}`,
      )
      .join('；');
    lines.push(
      `- ${t.id}（${PLAN_SECTION_ZH[t.section]}）：${t.text}${params ? `【${params}】` : ''}`,
    );
  }
  return lines.join('\n');
}
