import {
  MEAL_TYPES,
  VISIT_FOCUS_MAX,
  VISIT_MAX_AHEAD_MONTHS,
  VISIT_METHODS,
  VISIT_SCHEDULE_ROWS_MAX,
  CARE_PLAN_EXERCISES_MAX,
  CARE_PLAN_GOALS_PER_SECTION_MAX,
  CARE_PLAN_RECIPES_MAX,
  defaultGoalParams,
  validateGoalParams,
  type CarePlanStructured,
  type ExerciseManagerView,
  type GoalParam,
  type GoalTemplateManagerView,
  type MealType,
  type RecipeManagerView,
  type VisitRecordStructured,
  type VisitScheduleRow,
  type VisitScheduleStructured,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listExercises, listGoalTemplates, listRecipes } from '../api/care';
import { isAbortError } from '../api/http';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';
import { addMonths, localToday } from './dates';

/**
 * 产物标签里的结构化内容编辑器（M5 规格 2.3、2.7、2.9）：
 * - 方案：替换、删除、新增示例食谱和动作（只能选已发布的库条目），改行为目标的参数（在模板范围内）；
 * - 随访计划：可编辑的日程表（日期不早于今天、不超过 6 个月后、不重复）；
 * - 随访记录：补填随访日期和方式。
 * 前端先校验，后端保存和确认时再按同样的规则校验。手机宽度只能改内容和替换条目，没有拖动排序。
 */

/** 结构化内容里前端能看出的问题，对应 care.editor.problems.* 文案 */
export type StructuredProblem =
  | 'goalUnavailable'
  | 'goalRange'
  | 'itemUnavailable'
  | 'exerciseRange'
  | 'scheduleEmpty'
  | 'scheduleRange'
  | 'scheduleDuplicate'
  | 'focusTooLong'
  | 'recordIncomplete'
  | 'recordFuture'
  | 'replyEmpty'
  | 'replyTooLong';

export interface LibraryData {
  status: 'loading' | 'ready' | 'error';
  recipes: RecipeManagerView[];
  exercises: ExerciseManagerView[];
  templates: GoalTemplateManagerView[];
}

/** 读方案库（只有已发布的条目）。只在打开方案草稿时读一次 */
export function useLibraryData(enabled: boolean): LibraryData {
  const [data, setData] = useState<LibraryData>({
    status: 'loading',
    recipes: [],
    exercises: [],
    templates: [],
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([listRecipes({}, signal), listExercises({}, signal), listGoalTemplates({}, signal)])
      .then(([recipes, exercises, templates]) =>
        setData({ status: 'ready', recipes, exercises, templates }),
      )
      .catch((err: unknown) => {
        if (!isAbortError(err)) setData((d) => ({ ...d, status: 'error' }));
      });
    return () => controller.abort();
  }, [enabled]);
  return data;
}

/** 方案结构化内容里有问题的地方（参数超范围、条目不在库中）；有问题时不能保存 */
export function carePlanProblems(
  value: CarePlanStructured,
  library: LibraryData,
): StructuredProblem[] {
  if (library.status !== 'ready') return [];
  const problems: StructuredProblem[] = [];
  const templates = new Map(library.templates.map((t) => [t.id, t]));
  for (const s of value.sections)
    for (const g of s.goals) {
      const tpl = templates.get(g.templateId);
      if (!tpl) problems.push('goalUnavailable');
      else if (validateGoalParams(tpl.params, g.params).length) problems.push('goalRange');
    }
  const recipeIds = new Set(library.recipes.map((r) => r.id));
  if (value.recipes.some((r) => !recipeIds.has(r.recipeId))) problems.push('itemUnavailable');
  const exerciseIds = new Set(library.exercises.map((e) => e.id));
  if (value.exercises.some((e) => !exerciseIds.has(e.exerciseId))) problems.push('itemUnavailable');
  return [...new Set(problems)];
}

export function CarePlanEditor({
  value,
  library,
  disabled,
  onChange,
}: {
  value: CarePlanStructured;
  library: LibraryData;
  disabled: boolean;
  onChange: (next: CarePlanStructured) => void;
}) {
  const { t } = useTranslation();
  if (library.status === 'loading') {
    return (
      <p className={styles.muted} role="status">
        {t('library.loading')}
      </p>
    );
  }
  if (library.status === 'error') {
    return (
      <p className={styles.error} role="alert">
        {t('care.editor.libraryFailed')}
      </p>
    );
  }
  const recipeName = new Map(library.recipes.map((r) => [r.id, r.name]));
  const exerciseName = new Map(library.exercises.map((e) => [e.id, e.name]));
  const templates = new Map(library.templates.map((tpl) => [tpl.id, tpl]));
  const hasDiet = value.sections.some((s) => s.section === 'diet');
  const hasMovement = value.sections.some((s) => s.section === 'exercise' || s.section === 'mind');
  const usedSlots = new Set(value.recipes.map((r) => `${r.day}:${r.meal}`));
  const freeSlot = (() => {
    for (let day = 1; day <= 7; day++)
      for (const meal of MEAL_TYPES) if (!usedSlots.has(`${day}:${meal}`)) return { day, meal };
    return null;
  })();

  return (
    <div className={care.editor} data-testid="care-plan-editor">
      <p className={styles.muted}>{t('care.editor.planNote')}</p>

      <h5 className={styles.sectionTitle}>{t('care.editor.goals')}</h5>
      {value.sections.map((section, si) => {
        const available = library.templates.filter((tpl) => tpl.section === section.section);
        const setGoals = (goals: typeof section.goals) =>
          onChange({
            ...value,
            sections: value.sections.map((s, i) => (i === si ? { ...s, goals } : s)),
          });
        return (
          <fieldset key={section.section} className={care.editorGroup}>
            <legend className={care.subTitle}>{t(`care.sections.${section.section}`)}</legend>
            {section.goals.length === 0 && <p className={styles.muted}>{t('care.plan.noGoals')}</p>}
            {section.goals.map((goal, gi) => {
              const tpl = templates.get(goal.templateId);
              return (
                <div key={`${goal.templateId}-${gi}`} className={care.editorRow}>
                  {tpl ? (
                    <GoalParams
                      template={tpl}
                      values={goal.params}
                      disabled={disabled}
                      onChange={(params) =>
                        setGoals(section.goals.map((g, i) => (i === gi ? { ...g, params } : g)))
                      }
                    />
                  ) : (
                    <span className={styles.error}>{t('care.editor.goalUnavailable')}</span>
                  )}
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    aria-label={t('care.editor.removeGoal', {
                      section: t(`care.sections.${section.section}`),
                      index: gi + 1,
                    })}
                    onClick={() => setGoals(section.goals.filter((_, i) => i !== gi))}
                  >
                    {t('care.editor.remove')}
                  </Button>
                </div>
              );
            })}
            {available.length > 0 && section.goals.length < CARE_PLAN_GOALS_PER_SECTION_MAX && (
              <label className={styles.label}>
                {t('care.editor.addGoal')}
                <select
                  className={styles.select}
                  value=""
                  disabled={disabled}
                  onChange={(e) => {
                    const tpl = templates.get(e.target.value);
                    if (tpl)
                      setGoals([
                        ...section.goals,
                        { templateId: tpl.id, params: defaultGoalParams(tpl.params) },
                      ]);
                  }}
                >
                  <option value="">{t('care.editor.choose')}</option>
                  {available.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.text}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        );
      })}

      {hasDiet && (
        <fieldset className={care.editorGroup}>
          <legend className={care.subTitle}>{t('care.editor.recipes')}</legend>
          {value.recipes.length === 0 && (
            <p className={styles.muted}>{t('care.editor.noRecipes')}</p>
          )}
          {value.recipes.map((r, ri) => {
            const options = library.recipes.filter((x) => x.mealTypes.includes(r.meal));
            const slot = t('care.editor.slot', {
              day: r.day,
              meal: t(`library.meals.${r.meal}`),
            });
            return (
              <div key={`${r.day}:${r.meal}`} className={care.editorRow}>
                <label className={styles.label}>
                  {slot}
                  <select
                    className={styles.select}
                    value={r.recipeId}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        recipes: value.recipes.map((x, i) =>
                          i === ri ? { ...x, recipeId: e.target.value } : x,
                        ),
                      })
                    }
                  >
                    {!recipeName.has(r.recipeId) && (
                      <option value={r.recipeId}>{t('care.editor.itemUnavailable')}</option>
                    )}
                    {options.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  aria-label={t('care.editor.removeItem', { name: slot })}
                  onClick={() =>
                    onChange({ ...value, recipes: value.recipes.filter((_, i) => i !== ri) })
                  }
                >
                  {t('care.editor.remove')}
                </Button>
              </div>
            );
          })}
          {freeSlot && value.recipes.length < CARE_PLAN_RECIPES_MAX && (
            <AddRecipe
              recipes={library.recipes}
              usedSlots={usedSlots}
              disabled={disabled}
              onAdd={(entry) => onChange({ ...value, recipes: [...value.recipes, entry] })}
            />
          )}
        </fieldset>
      )}

      {hasMovement && (
        <fieldset className={care.editorGroup}>
          <legend className={care.subTitle}>{t('care.editor.exercises')}</legend>
          {value.exercises.length === 0 && (
            <p className={styles.muted}>{t('care.editor.noExercises')}</p>
          )}
          {value.exercises.map((x, xi) => {
            const name = exerciseName.get(x.exerciseId) ?? t('care.editor.itemUnavailable');
            const update = (patch: Partial<typeof x>) =>
              onChange({
                ...value,
                exercises: value.exercises.map((e, i) => (i === xi ? { ...e, ...patch } : e)),
              });
            return (
              <div key={`${x.exerciseId}-${xi}`} className={care.editorRow}>
                <label className={styles.label}>
                  {t('care.editor.exercise', { index: xi + 1 })}
                  <select
                    className={styles.select}
                    value={x.exerciseId}
                    disabled={disabled}
                    onChange={(e) => update({ exerciseId: e.target.value })}
                  >
                    {!exerciseName.has(x.exerciseId) && (
                      <option value={x.exerciseId}>{name}</option>
                    )}
                    {library.exercises.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <NumberField
                  label={t('care.editor.frequency')}
                  value={x.frequencyPerWeek}
                  min={1}
                  max={7}
                  disabled={disabled}
                  onChange={(v) => update({ frequencyPerWeek: v })}
                />
                <NumberField
                  label={t('care.editor.minutes')}
                  value={x.minutes}
                  min={1}
                  max={120}
                  disabled={disabled}
                  onChange={(v) => update({ minutes: v })}
                />
                <Button
                  variant="ghost"
                  disabled={disabled}
                  aria-label={t('care.editor.removeItem', { name })}
                  onClick={() =>
                    onChange({ ...value, exercises: value.exercises.filter((_, i) => i !== xi) })
                  }
                >
                  {t('care.editor.remove')}
                </Button>
              </div>
            );
          })}
          {library.exercises.length > 0 && value.exercises.length < CARE_PLAN_EXERCISES_MAX && (
            <label className={styles.label}>
              {t('care.editor.addExercise')}
              <select
                className={styles.select}
                value=""
                disabled={disabled}
                onChange={(e) => {
                  if (e.target.value)
                    onChange({
                      ...value,
                      exercises: [
                        ...value.exercises,
                        { exerciseId: e.target.value, frequencyPerWeek: 3, minutes: 20 },
                      ],
                    });
                }}
              >
                <option value="">{t('care.editor.choose')}</option>
                {library.exercises.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      )}
    </div>
  );
}

function AddRecipe({
  recipes,
  usedSlots,
  disabled,
  onAdd,
}: {
  recipes: RecipeManagerView[];
  usedSlots: ReadonlySet<string>;
  disabled: boolean;
  onAdd: (entry: CarePlanStructured['recipes'][number]) => void;
}) {
  const { t } = useTranslation();
  const [day, setDay] = useState(1);
  const [meal, setMeal] = useState<MealType>('breakfast');
  const taken = usedSlots.has(`${day}:${meal}`);
  const options = recipes.filter((r) => r.mealTypes.includes(meal));
  return (
    <div className={care.editorRow}>
      <label className={styles.label}>
        {t('care.editor.day')}
        <select
          className={styles.select}
          value={day}
          disabled={disabled}
          onChange={(e) => setDay(Number(e.target.value))}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <option key={d} value={d}>
              {t('care.editor.dayN', { day: d })}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.label}>
        {t('library.meal')}
        <select
          className={styles.select}
          value={meal}
          disabled={disabled}
          onChange={(e) => setMeal(e.target.value as MealType)}
        >
          {MEAL_TYPES.map((m) => (
            <option key={m} value={m}>
              {t(`library.meals.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.label}>
        {t('care.editor.addRecipe')}
        <select
          className={styles.select}
          value=""
          disabled={disabled || taken}
          onChange={(e) => {
            if (e.target.value) onAdd({ day, meal, recipeId: e.target.value });
          }}
        >
          <option value="">{taken ? t('care.editor.slotTaken') : t('care.editor.choose')}</option>
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** 目标参数：整数在模板的最小值到最大值之间，时间是 HH:MM（同样有范围） */
function GoalParams({
  template,
  values,
  disabled,
  onChange,
}: {
  template: GoalTemplateManagerView;
  values: Record<string, number | string>;
  disabled: boolean;
  onChange: (values: Record<string, number | string>) => void;
}) {
  const { t } = useTranslation();
  const issues = validateGoalParams(template.params, values);
  const bad = new Set(issues.map((i) => i.param));
  return (
    <div className={care.goalEditor}>
      <span className={care.goalText}>{template.text}</span>
      {template.params.map((p: GoalParam) => (
        <label key={p.name} className={styles.label}>
          {t('care.editor.param', {
            name: p.name,
            min: p.min,
            max: p.max,
            unit: p.type === 'int' && p.unit ? ` ${p.unit}` : '',
          })}
          <input
            className={styles.input}
            type={p.type === 'int' ? 'number' : 'time'}
            min={p.min}
            max={p.max}
            disabled={disabled}
            value={values[p.name] ?? ''}
            aria-invalid={bad.has(p.name) ? true : undefined}
            onChange={(e) =>
              onChange({
                ...values,
                [p.name]:
                  p.type === 'int'
                    ? e.target.value === ''
                      ? Number.NaN
                      : Number(e.target.value)
                    : e.target.value,
              })
            }
          />
        </label>
      ))}
      {issues.length > 0 && (
        <p className={styles.error} role="alert">
          {t('care.editor.paramOutOfRange')}
        </p>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.label}>
      {label}
      <input
        className={styles.input}
        type="number"
        min={min}
        max={max}
        value={Number.isNaN(value) ? '' : value}
        disabled={disabled}
        aria-invalid={!(value >= min && value <= max) ? true : undefined}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
    </label>
  );
}

/** 方案里动作的频率和时长超出范围（前端校验，后端用 schema 再校验） */
export function exerciseProblems(value: CarePlanStructured): boolean {
  return value.exercises.some(
    (e) =>
      !Number.isInteger(e.frequencyPerWeek) ||
      e.frequencyPerWeek < 1 ||
      e.frequencyPerWeek > 7 ||
      !Number.isInteger(e.minutes) ||
      e.minutes < 1 ||
      e.minutes > 120,
  );
}

// ---------- 随访计划 ----------

/** 随访日程表的问题：日期为空、早于今天、超过 6 个月后、重复，或没有一行 */
export function scheduleProblems(value: VisitScheduleStructured): StructuredProblem[] {
  const today = localToday();
  const max = addMonths(today, VISIT_MAX_AHEAD_MONTHS);
  const problems = new Set<StructuredProblem>();
  if (value.rows.length === 0) problems.add('scheduleEmpty');
  const dates = value.rows.map((r) => r.dueDate);
  if (dates.some((d) => !d || d < today || d > max)) problems.add('scheduleRange');
  if (new Set(dates).size !== dates.length) problems.add('scheduleDuplicate');
  if (value.rows.some((r) => (r.focus ?? '').length > VISIT_FOCUS_MAX))
    problems.add('focusTooLong');
  return [...problems];
}

export function ScheduleEditor({
  value,
  disabled,
  onChange,
}: {
  value: VisitScheduleStructured;
  disabled: boolean;
  onChange: (next: VisitScheduleStructured) => void;
}) {
  const { t } = useTranslation();
  const today = localToday();
  const max = addMonths(today, VISIT_MAX_AHEAD_MONTHS);
  const counts = new Map<string, number>();
  for (const r of value.rows) counts.set(r.dueDate, (counts.get(r.dueDate) ?? 0) + 1);
  const setRow = (index: number, patch: Partial<VisitScheduleRow>) =>
    onChange({ rows: value.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  return (
    <div className={care.editor} data-testid="schedule-editor">
      <p className={styles.muted}>{t('care.editor.scheduleNote')}</p>
      <ol className={care.scheduleList} aria-label={t('care.editor.schedule')}>
        {value.rows.map((row, i) => {
          const badDate =
            !row.dueDate ||
            row.dueDate < today ||
            row.dueDate > max ||
            counts.get(row.dueDate)! > 1;
          return (
            <li key={i} className={care.scheduleRow}>
              <label className={styles.label}>
                {t('care.editor.rowDate', { index: i + 1 })}
                <input
                  className={styles.input}
                  type="date"
                  min={today}
                  max={max}
                  value={row.dueDate}
                  disabled={disabled}
                  aria-invalid={badDate ? true : undefined}
                  onChange={(e) => setRow(i, { dueDate: e.target.value })}
                />
              </label>
              <label className={styles.label}>
                {t('care.visits.form.method')}
                <select
                  className={styles.select}
                  value={row.method}
                  disabled={disabled}
                  onChange={(e) =>
                    setRow(i, { method: e.target.value as VisitScheduleRow['method'] })
                  }
                >
                  {VISIT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`care.visits.methods.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.label}>
                {t('care.visits.form.purpose')}
                <select
                  className={styles.select}
                  value={row.purpose}
                  disabled={disabled}
                  onChange={(e) =>
                    setRow(i, { purpose: e.target.value as VisitScheduleRow['purpose'] })
                  }
                >
                  {(['routine', 'plan_review', 'follow_up'] as const).map((p) => (
                    <option key={p} value={p}>
                      {t(`care.visits.purposes.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${styles.label} ${care.wide}`}>
                {t('care.visits.form.focus', { max: VISIT_FOCUS_MAX })}
                <input
                  className={styles.input}
                  value={row.focus ?? ''}
                  maxLength={VISIT_FOCUS_MAX}
                  disabled={disabled}
                  onChange={(e) => setRow(i, { focus: e.target.value || null })}
                />
              </label>
              <Button
                variant="ghost"
                disabled={disabled || value.rows.length <= 1}
                aria-label={t('care.editor.removeRow', { index: i + 1 })}
                onClick={() => onChange({ rows: value.rows.filter((_, j) => j !== i) })}
              >
                {t('care.editor.remove')}
              </Button>
            </li>
          );
        })}
      </ol>
      {value.rows.length < VISIT_SCHEDULE_ROWS_MAX && (
        <div>
          <Button
            disabled={disabled}
            onClick={() =>
              onChange({
                rows: [
                  ...value.rows,
                  { dueDate: '', method: 'phone', purpose: 'routine', focus: null },
                ],
              })
            }
          >
            {t('care.editor.addRow')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- 随访记录 ----------

export function recordProblems(value: VisitRecordStructured): StructuredProblem[] {
  if (!value.visitDate || !value.method) return ['recordIncomplete'];
  return value.visitDate > localToday() ? ['recordFuture'] : [];
}

/** 随访记录：补填随访日期和方式（素材里看不出来时 AI 留空，2.9 第 4 条） */
export function RecordEditor({
  value,
  disabled,
  onChange,
}: {
  value: VisitRecordStructured;
  disabled: boolean;
  onChange: (next: VisitRecordStructured) => void;
}) {
  const { t } = useTranslation();
  const today = localToday();
  return (
    <div className={care.editor} data-testid="record-editor">
      <div className={care.formRow}>
        <label className={styles.label}>
          {t('care.editor.visitDate')}
          <input
            className={styles.input}
            type="date"
            max={today}
            value={value.visitDate ?? ''}
            disabled={disabled}
            aria-invalid={!value.visitDate || value.visitDate > today ? true : undefined}
            onChange={(e) => onChange({ ...value, visitDate: e.target.value || null })}
          />
        </label>
        <label className={styles.label}>
          {t('care.visits.form.method')}
          <select
            className={styles.select}
            value={value.method ?? ''}
            disabled={disabled}
            aria-invalid={!value.method ? true : undefined}
            onChange={(e) =>
              onChange({
                ...value,
                method: (e.target.value || null) as VisitRecordStructured['method'],
              })
            }
          >
            <option value="">{t('care.editor.choose')}</option>
            {VISIT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`care.visits.methods.${m}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
