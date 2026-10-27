import {
  CARE_PLAN_EXERCISES_MAX,
  CARE_PLAN_GOALS_PER_SECTION_MAX,
  CARE_PLAN_RECIPES_MAX,
  MEAL_TYPES,
  PLAN_SECTIONS,
  renderGoal,
  validateGoalParams,
  type CarePlanStructured,
  type GoalParamValues,
  type PlanSection,
} from '@health-buddy/shared';
import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import { CRISIS_NOTICE, findRiskTierMentions } from '../guardrails.js';
import {
  EXERCISE_CATEGORY_ZH,
  MEAL_ZH,
  PLAN_SECTION_ZH,
  describeLibrary,
  describePlanContext,
  type GoalTemplateCandidate,
  type PlanLibraryContext,
} from '../plan-input.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import { TWIN_PROMPT_RULES, describeTwin } from '../twin-input.js';
import {
  checkPlanClientText,
  checkPlanProfessionalText,
  wordingCategories,
  type WordingCategory,
  type WordingIssue,
} from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/**
 * /方案生成（M5 规格 2.2–2.5、5.2–5.4）：有专业版和通俗版，产物 kind = care_plan。
 * 示例食谱、动作和目标只能从后端给的候选里选 id（Q15），参数在模板范围内（Q3）；
 * 食谱和动作的做法由后端按库条目渲染进通俗版。结构不合格（库外 id、参数超范围、部分不对）时重试一次。
 */
const goalOutputSchema = z.object({
  templateId: z.string(),
  /** 参数写成名称和文字值：整数写数字，时间写 HH:MM（由后端按模板换成数值） */
  params: z.array(z.object({ name: z.string(), value: z.string() })),
});

export const carePlanOutputSchema = z.object({
  sections: z.array(
    z.object({
      section: z.enum(PLAN_SECTIONS),
      professional: z.string(),
      clientFacing: z.string(),
      goals: z.array(goalOutputSchema),
    }),
  ),
  // 整数用 z.number()：zod 的 .int() 会带上 minimum/maximum，Claude 的结构化输出不接受；整数和范围由 validateCarePlan 校验
  recipes: z.array(z.object({ day: z.number(), meal: z.enum(MEAL_TYPES), recipeId: z.string() })),
  exercises: z.array(
    z.object({
      exerciseId: z.string(),
      frequencyPerWeek: z.number(),
      minutes: z.number(),
    }),
  ),
  overview: z.object({
    basis: z.array(z.string()),
    focus: z.array(z.string()),
    medicalReview: z.string().nullable(),
    changes: z.array(z.string()),
  }),
  followUpFocus: z.array(z.string()),
  referral: z.array(z.string()),
  dataGaps: z.array(z.string()),
  notes: z.array(z.string()),
  crisisSignal: z.boolean(),
});
export type CarePlanOutput = z.output<typeof carePlanOutputSchema>;

/** 模型写的参数换成模板的类型：整数参数转成数字（转不了的留成 NaN，校验会拦下） */
export function goalParamValues(
  template: Pick<GoalTemplateCandidate, 'params'>,
  params: readonly { name: string; value: string }[],
): GoalParamValues {
  const out: GoalParamValues = {};
  for (const p of params) {
    const def = template.params.find((x) => x.name === p.name);
    out[p.name] = def?.type === 'int' ? Number(p.value.trim()) : p.value.trim();
  }
  return out;
}

function libraryOf(input?: SkillInput): PlanLibraryContext | null {
  return input?.plan?.library ?? null;
}

/**
 * 结构校验（5.2、5.4 第 5 条）。返回不合格的类别：
 * section_mismatch（部分和选项不一致）、goal_invalid（模板不在候选、部分不对、参数超范围）、
 * library_ref（条目不在候选、餐次不对、同一餐两份、次数时长超范围、心理部分选了非放松练习）、
 * exercise_restricted（有运动安全规则却选了动作、设了运动目标，或没写需要先就医评估的原因）
 */
export function validateCarePlan(output: CarePlanOutput, input: SkillInput): string[] {
  const lib = libraryOf(input);
  if (!lib) return ['section_mismatch'];
  const issues = new Set<string>();
  const wanted = lib.options.sections;
  const got = output.sections.map((s) => s.section);
  // 有心理危机信号时不写心理部分（5.3），写了也不算错（渲染时去掉）
  const required = output.crisisSignal ? wanted.filter((s) => s !== 'mind') : wanted;
  if (
    got.some((s) => !wanted.includes(s)) ||
    new Set(got).size !== got.length ||
    required.some((s) => !got.includes(s))
  ) {
    issues.add('section_mismatch');
  }
  const templates = new Map(lib.goalTemplates.map((t) => [t.id, t]));
  for (const s of output.sections) {
    if (s.goals.length > CARE_PLAN_GOALS_PER_SECTION_MAX) issues.add('goal_invalid');
    for (const g of s.goals) {
      const t = templates.get(g.templateId);
      if (!t || t.section !== s.section) issues.add('goal_invalid');
      else if (validateGoalParams(t.params, goalParamValues(t, g.params)).length) {
        issues.add('goal_invalid');
      }
    }
  }
  const recipes = new Map(lib.recipes.map((r) => [r.id, r]));
  const slots = new Set<string>();
  if (output.recipes.length > CARE_PLAN_RECIPES_MAX) issues.add('library_ref');
  if (output.recipes.length && !wanted.includes('diet')) issues.add('library_ref');
  for (const r of output.recipes) {
    const c = recipes.get(r.recipeId);
    const slot = `${r.day}:${r.meal}`;
    if (
      !c ||
      !c.mealTypes.includes(r.meal) ||
      !Number.isInteger(r.day) ||
      r.day < 1 ||
      r.day > 7 ||
      slots.has(slot)
    ) {
      issues.add('library_ref');
    }
    slots.add(slot);
  }
  const exercises = new Map(lib.exercises.map((e) => [e.id, e]));
  if (output.exercises.length > CARE_PLAN_EXERCISES_MAX) issues.add('library_ref');
  for (const x of output.exercises) {
    const c = exercises.get(x.exerciseId);
    const allowed =
      c &&
      (wanted.includes('exercise') || (wanted.includes('mind') && c.category === 'relaxation'));
    if (
      !allowed ||
      !Number.isInteger(x.frequencyPerWeek) ||
      !Number.isInteger(x.minutes) ||
      x.frequencyPerWeek < 1 ||
      x.frequencyPerWeek > 7 ||
      x.minutes < 1 ||
      x.minutes > 120
    ) {
      issues.add('library_ref');
    }
  }
  if (
    lib.exerciseRestriction &&
    (!output.overview.medicalReview?.trim() ||
      output.sections.some((s) => s.section === 'exercise' && s.goals.length > 0) ||
      output.exercises.some((x) => exercises.get(x.exerciseId)?.category !== 'relaxation'))
  ) {
    issues.add('exercise_restricted');
  }
  return [...issues];
}

/**
 * 只选了心理又有危机信号：方案至少要有一部分，心理部分只给健管师一句处理提示，通俗版留空
 * （不给客户任何心理相关的内容，5.3、红线 4）
 */
const CRISIS_MIND_SECTION: CarePlanStructured['sections'][number] = {
  section: 'mind',
  professional: '请先按危机提示处理，暂不安排心理部分的内容。',
  clientFacing: '',
  goals: [],
};

/** 运动安全规则（Q8）下运动部分给客户的固定说法 */
export const EXERCISE_MEDICAL_REVIEW = '建议先就医评估再开始运动。';

/**
 * 方案草稿的结构化内容（artifacts.structured），健管师可以在编辑器里替换条目、改参数。
 * 有心理危机信号时去掉心理部分和放松练习（5.3）
 */
export function carePlanStructured(output: CarePlanOutput, input?: SkillInput): CarePlanStructured {
  const lib = libraryOf(input);
  const templates = new Map(lib?.goalTemplates.map((t) => [t.id, t]) ?? []);
  const relaxation = new Set(
    lib?.exercises.filter((e) => e.category === 'relaxation').map((e) => e.id) ?? [],
  );
  const order = (s: PlanSection) => PLAN_SECTIONS.indexOf(s);
  const restricted = Boolean(lib?.exerciseRestriction);
  const sections = output.sections
    .filter((s) => !(output.crisisSignal && s.section === 'mind'))
    .sort((a, b) => order(a.section) - order(b.section))
    .map((s) => ({
      section: s.section,
      professional: s.professional.trim(),
      // 运动安全规则：运动部分的通俗版由后端固定成一句，不给强度、频率和时长
      clientFacing:
        restricted && s.section === 'exercise' ? EXERCISE_MEDICAL_REVIEW : s.clientFacing.trim(),
      goals: (restricted && s.section === 'exercise' ? [] : s.goals).flatMap((g) => {
        const t = templates.get(g.templateId);
        return t ? [{ templateId: g.templateId, params: goalParamValues(t, g.params) }] : [];
      }),
    }));
  // 只选了心理又有危机信号：方案至少要有一部分，心理部分只留一句转给健管师的话
  if (!sections.length) sections.push({ ...CRISIS_MIND_SECTION, goals: [] });
  return {
    sections,
    recipes: [...output.recipes].sort(
      (a, b) => a.day - b.day || MEAL_TYPES.indexOf(a.meal) - MEAL_TYPES.indexOf(b.meal),
    ),
    exercises: output.exercises.filter(
      (x) =>
        !(output.crisisSignal && relaxation.has(x.exerciseId)) &&
        !(restricted && !relaxation.has(x.exerciseId)),
    ),
  };
}

function goalLine(t: GoalTemplateCandidate | undefined, params: GoalParamValues): string | null {
  if (!t) return null;
  try {
    return renderGoal(t, params);
  } catch {
    return null;
  }
}

/** 通俗版：每部分的文字、行为目标、后端从库里渲染的示例食谱和动作 */
function clientText(structured: CarePlanStructured, lib: PlanLibraryContext | null): string {
  const templates = new Map(lib?.goalTemplates.map((t) => [t.id, t]) ?? []);
  const recipes = new Map(lib?.recipes.map((r) => [r.id, r]) ?? []);
  const exercises = new Map(lib?.exercises.map((e) => [e.id, e]) ?? []);
  const parts: string[] = [];
  for (const s of structured.sections) {
    // 危机信号下只留给健管师的心理部分：通俗版不出现
    if (!s.clientFacing && !s.goals.length) continue;
    const lines = [`## ${PLAN_SECTION_ZH[s.section]}`, s.clientFacing];
    const goals = s.goals.flatMap((g) => goalLine(templates.get(g.templateId), g.params) ?? []);
    if (goals.length) lines.push('', '**行为小目标**', ...goals.map((g) => `- ${g}`));
    if (s.section === 'diet' && structured.recipes.length) {
      lines.push('', '**示例食谱**');
      for (const r of structured.recipes) {
        const c = recipes.get(r.recipeId);
        if (!c) continue;
        const ingredients = c.ingredients.map((i) => `${i.name}${i.householdAmount}`).join('、');
        lines.push(
          `- 第 ${r.day} 天${MEAL_ZH[r.meal]}：${c.name}（${ingredients}）。做法：${c.steps.join('；')}`,
        );
      }
    }
    const moves = structured.exercises.filter((x) => {
      const c = exercises.get(x.exerciseId);
      if (!c) return false;
      return s.section === 'mind'
        ? c.category === 'relaxation'
        : s.section === 'exercise' && c.category !== 'relaxation';
    });
    if (moves.length) {
      lines.push('', s.section === 'mind' ? '**放松练习**' : '**推荐的活动**');
      for (const x of moves) {
        const c = exercises.get(x.exerciseId)!;
        lines.push(
          `- ${c.name}：每周 ${x.frequencyPerWeek} 次，每次约 ${x.minutes} 分钟。做法：${c.steps.join('；')}。要点：${c.keyPoints.join('；')}`,
        );
      }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/** 专业版：依据、重点、每部分的说明和条目（含给健管师看的注意事项）、执行和复评、转介、数据缺口 */
function professionalText(
  output: CarePlanOutput,
  structured: CarePlanStructured,
  lib: PlanLibraryContext | null,
): string {
  const templates = new Map(lib?.goalTemplates.map((t) => [t.id, t]) ?? []);
  const recipes = new Map(lib?.recipes.map((r) => [r.id, r]) ?? []);
  const exercises = new Map(lib?.exercises.map((e) => [e.id, e]) ?? []);
  const o = output.overview;
  const lines: string[] = [];
  if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
  if (output.notes.length) lines.push('## 说明', ...output.notes.map((n) => `- ${n}`), '');
  lines.push('## 总体', '**方案依据**', ...list(o.basis), '', '**本周期的重点**', ...list(o.focus));
  if (o.medicalReview) lines.push('', '**需要先就医评估**', o.medicalReview);
  if (o.changes.length) lines.push('', '**和当前方案相比的主要调整**', ...list(o.changes));
  if (lib?.exerciseRestriction) {
    lines.push('', `**运动安全规则**：${lib.exerciseRestriction}，运动部分只写“先就医评估”。`);
  }
  for (const s of structured.sections) {
    lines.push('', `## ${PLAN_SECTION_ZH[s.section]}`, s.professional);
    const goals = s.goals.flatMap((g) => goalLine(templates.get(g.templateId), g.params) ?? []);
    if (goals.length) lines.push('', '**行为目标**', ...list(goals));
    if (s.section === 'diet' && structured.recipes.length) {
      lines.push('', '**示例食谱**');
      for (const r of structured.recipes) {
        const c = recipes.get(r.recipeId);
        if (c) lines.push(`- 第 ${r.day} 天${MEAL_ZH[r.meal]}：${c.name}`);
      }
    }
    if (s.section === 'exercise' || s.section === 'mind') {
      const moves = structured.exercises.filter((x) => {
        const c = exercises.get(x.exerciseId);
        return c && (s.section === 'mind') === (c.category === 'relaxation');
      });
      if (moves.length) lines.push('', '**动作和练习**');
      for (const x of moves) {
        const c = exercises.get(x.exerciseId)!;
        lines.push(
          `- ${c.name}（${EXERCISE_CATEGORY_ZH[c.category]}）：每周 ${x.frequencyPerWeek} 次，每次约 ${x.minutes} 分钟。注意事项：${c.managerCautions}`,
        );
      }
    }
  }
  lines.push(
    '',
    '## 执行和复评',
    `- 周期：${lib?.options.cycleWeeks ?? 8} 周；生效后在周期结束那天自动排一次“方案复评”随访`,
  );
  if (output.followUpFocus.length)
    lines.push('- 建议的随访重点：', ...list(output.followUpFocus, '  '));
  if (output.referral.length) lines.push('', '## 转介建议', ...list(output.referral));
  if (output.dataGaps.length) lines.push('', '## 数据缺口', ...list(output.dataGaps));
  return lines.join('\n');
}

function list(items: readonly string[], indent = ''): string[] {
  return items.map((i) => `${indent}- ${i}`);
}

/** 通俗版的每一段（措辞检查用） */
export function carePlanClientTexts(output: CarePlanOutput): string[] {
  return output.sections.map((s) => s.clientFacing);
}

/** 专业版里模型写的文字（措辞检查用） */
export function carePlanProfessionalTexts(output: CarePlanOutput): string[] {
  const o = output.overview;
  return [
    ...output.sections.map((s) => s.professional),
    ...o.basis,
    ...o.focus,
    ...(o.medicalReview ? [o.medicalReview] : []),
    ...o.changes,
    ...output.followUpFocus,
    ...output.referral,
    ...output.dataGaps,
    ...output.notes,
  ];
}

const VALIDATION_NOTE: Record<string, string> = {
  section_mismatch: 'sections 必须正好是“方案选项”里选中的几部分，每部分一条',
  goal_invalid:
    '有行为目标不在“目标模板”里、放错了部分，或参数超出模板写明的范围；只能用目标模板的 id，参数在范围内',
  library_ref:
    '有食谱或动作不在候选里、餐次不对、同一天同一餐有两份，或次数时长超出范围；只能用候选的 id',
  exercise_restricted:
    '有运动安全规则时 exercises 只能有心理部分的放松练习，运动部分不设目标，overview.medicalReview 必须写明需要先就医评估的原因',
};

const WORDING_NOTE: Partial<Record<WordingCategory, string>> = {
  banned_term: '方案里出现了禁用词（如“诊断”“筛查”“治愈”“根治”“确诊”）',
  presumed_disease: '通俗版里出现了疾病名称或人群说法（如“三高”“焦虑”）；只写生活习惯',
  judgment: '通俗版里用了“风险”“患有”“疑似”这类判断说法',
  drug_name: '方案里点名了具体药物；用药写“用药调整由医生评估”',
  drug_advice: '方案里出现了用药建议、剂量或保健品、代餐',
  twin_term: '通俗版里出现了孪生状态颜色或“预测”字样；状态和预测只写在专业版',
  risk_tier: '通俗版里出现了风险分层字样；分层只写在专业版',
  efficacy_claim: '方案里写了功效承诺（如“降血糖”“控制血压”“保证见效”）；写“有助于养成……的习惯”',
};

function note(lines: readonly string[]): string {
  return [
    '## 上一次生成的方案没有通过检查，请重新生成',
    ...lines.map((l) => `- ${l}`),
    '- 其余要求不变；输出前逐条检查一遍。',
  ].join('\n');
}

export const carePlan: SkillDefinition<typeof carePlanOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: `${TWIN_PROMPT_RULES}\n\n${body}`,
  outputSchema: carePlanOutputSchema,
  planContext: 'care_plan',
  experts: 'none',
  runStepLabel: 'steps.generateCarePlan',

  buildUserMessage(input) {
    const parts = [describeReportClient(input, { includeCriteria: false })];
    if (input.client.twin) parts.push('', describeTwin(input.client.twin));
    if (input.plan) {
      parts.push('', describePlanContext(input.plan));
      if (input.plan.library) parts.push('', describeLibrary(input.plan.library));
    }
    return appendRequest(parts, input);
  },

  render(output, input) {
    const lib = libraryOf(input);
    const structured = carePlanStructured(output, input);
    return {
      professional: professionalText(output, structured, lib),
      clientFacing: clientText(structured, lib),
      crisisSignal: output.crisisSignal,
      structured,
    };
  },

  checkOutput(output) {
    const issues: WordingIssue[] = [];
    for (const t of carePlanClientTexts(output)) {
      issues.push(...checkPlanClientText(t));
      for (const m of findRiskTierMentions(t)) {
        issues.push({ category: 'risk_tier', term: m.text, index: m.index });
      }
    }
    for (const t of carePlanProfessionalTexts(output)) issues.push(...checkPlanProfessionalText(t));
    return issues;
  },

  correctionNote(issues) {
    return note(
      wordingCategories(issues).flatMap((c) => (WORDING_NOTE[c] ? [WORDING_NOTE[c]] : [])),
    );
  },

  validateOutput: validateCarePlan,

  validationNote(categories) {
    return note(categories.flatMap((c) => (VALIDATION_NOTE[c] ? [VALIDATION_NOTE[c]] : [])));
  },
};
