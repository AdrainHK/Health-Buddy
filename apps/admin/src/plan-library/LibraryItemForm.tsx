import {
  ALLERGENS,
  EXERCISE_CATEGORIES,
  EXERCISE_INTENSITIES,
  EXERCISE_SETTINGS,
  GOAL_METRICS,
  LIBRARY_TAGS,
  MEAL_TYPES,
  PLAN_SECTIONS,
  type ExerciseContent,
  type GoalParam,
  type GoalTemplateContent,
  type LibraryItemType,
  type RecipeContent,
} from '@health-buddy/shared';
import { Button, IconButton } from '@health-buddy/ui';
import { X } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryContentByType, LibraryItemByType } from '../api/planLibrary';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import { toLibraryError, useLibraryLabels, type LibraryError } from './labels';
import own from './PlanLibrary.module.css';

export interface LibraryItemFormProps<T extends LibraryItemType> {
  type: T;
  /** 有值时是修改草稿：编码不能改；没有时是新增 */
  initial?: LibraryItemByType[T];
  onSubmit: (content: LibraryContentByType[T]) => Promise<void>;
  onCancel: () => void;
}

/** 前端发现的格式问题（行格式、数字）；内容检查以后端为准 */
class FormatError extends Error {
  constructor(
    readonly field: string,
    readonly kind: 'lines' | 'number',
  ) {
    super(field);
  }
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function numberOrNull(field: string, text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new FormatError(field, 'number');
  return n;
}

function toggle<T>(set: readonly T[], value: T, on: boolean): T[] {
  return on ? [...set.filter((v) => v !== value), value] : set.filter((v) => v !== value);
}

const NUTRITION_KEYS = ['energyKcal', 'proteinG', 'fatG', 'carbG', 'fiberG', 'sodiumMg'] as const;

/**
 * 新增或修改一个方案库条目（M5 规格 2.4、2.12）。只能改草稿；编码保存后不能改。
 * 列表类字段每行一条；食材每行“名称 | 家庭常用量 | 海外常见替代”。
 * 禁用词、疾病名称、药名和功效承诺由后端检查，不合格时在这里列出标出的位置。
 */
export function LibraryItemForm<T extends LibraryItemType>({
  type,
  initial,
  onSubmit,
  onCancel,
}: LibraryItemFormProps<T>) {
  const { t } = useTranslation();
  const labels = useLibraryLabels();
  const id = useId();
  const editing = Boolean(initial);

  const recipe = type === 'recipe' ? (initial as RecipeContent | undefined) : undefined;
  const exercise = type === 'exercise' ? (initial as ExerciseContent | undefined) : undefined;
  const goal = type === 'goal_template' ? (initial as GoalTemplateContent | undefined) : undefined;

  const [code, setCode] = useState(initial?.code ?? '');
  const [sourceNote, setSourceNote] = useState(initial?.sourceNote ?? '');
  // 食谱
  const [name, setName] = useState(recipe?.name ?? exercise?.name ?? '');
  const [mealTypes, setMealTypes] = useState<RecipeContent['mealTypes']>(recipe?.mealTypes ?? []);
  const [ingredients, setIngredients] = useState(
    (recipe?.ingredients ?? [])
      .map((i) =>
        [i.name, i.householdAmount, i.overseasAlternative ?? ''].join(' | ').replace(/ \| $/, ''),
      )
      .join('\n'),
  );
  const [steps, setSteps] = useState((recipe?.steps ?? exercise?.steps ?? []).join('\n'));
  const [tags, setTags] = useState<RecipeContent['tags']>(recipe?.tags ?? []);
  const [allergens, setAllergens] = useState<RecipeContent['allergens']>(recipe?.allergens ?? []);
  const [nutrition, setNutrition] = useState<Record<(typeof NUTRITION_KEYS)[number], string>>(
    () =>
      Object.fromEntries(
        NUTRITION_KEYS.map((k) => [k, recipe?.nutritionPerServing?.[k]?.toString() ?? '']),
      ) as Record<(typeof NUTRITION_KEYS)[number], string>,
  );
  const [nutritionBasis, setNutritionBasis] = useState(recipe?.nutritionBasis ?? '');
  // 运动
  const [category, setCategory] = useState<ExerciseContent['category']>(
    exercise?.category ?? 'aerobic',
  );
  const [intensity, setIntensity] = useState<ExerciseContent['intensity']>(
    exercise?.intensity ?? 'low',
  );
  const [setting, setSetting] = useState<ExerciseContent['setting']>(exercise?.setting ?? []);
  const [equipment, setEquipment] = useState((exercise?.equipment ?? []).join('\n'));
  const [keyPoints, setKeyPoints] = useState((exercise?.keyPoints ?? []).join('\n'));
  const [mistakes, setMistakes] = useState((exercise?.commonMistakes ?? []).join('\n'));
  const [cautions, setCautions] = useState(exercise?.managerCautions ?? '');
  const [met, setMet] = useState(exercise?.met?.toString() ?? '');
  // 目标模板
  const [section, setSection] = useState<GoalTemplateContent['section']>(goal?.section ?? 'diet');
  const [text, setText] = useState(goal?.text ?? '');
  const [params, setParams] = useState<ParamRow[]>((goal?.params ?? []).map(toRow));
  const [metric, setMetric] = useState<string>(goal?.metric ?? 'none');
  const [metricParam, setMetricParam] = useState(goal?.metricParam ?? '');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string[] | null>(null);

  const build = (): LibraryContentByType[T] => {
    if (type === 'recipe') {
      const parsedIngredients = lines(ingredients).map((line) => {
        const [n = '', amount = '', alt = ''] = line.split('|').map((p) => p.trim());
        if (!n || !amount) throw new FormatError('ingredients', 'lines');
        return { name: n, householdAmount: amount, grams: null, overseasAlternative: alt || null };
      });
      const values = NUTRITION_KEYS.map((k) => numberOrNull(k, nutrition[k]));
      const filled = values.filter((v) => v !== null).length;
      if (filled !== 0 && filled !== NUTRITION_KEYS.length) {
        throw new FormatError('nutritionPerServing', 'number');
      }
      const content: RecipeContent = {
        code: code.trim(),
        name: name.trim(),
        mealTypes,
        ingredients: parsedIngredients,
        steps: lines(steps),
        nutritionPerServing:
          filled === 0
            ? null
            : (Object.fromEntries(
                NUTRITION_KEYS.map((k, i) => [k, values[i]]),
              ) as RecipeContent['nutritionPerServing']),
        nutritionBasis: nutritionBasis.trim() || null,
        tags,
        allergens,
        sourceNote: sourceNote.trim(),
      };
      return content as LibraryContentByType[T];
    }
    if (type === 'exercise') {
      const content: ExerciseContent = {
        code: code.trim(),
        name: name.trim(),
        category,
        intensity,
        setting,
        equipment: lines(equipment),
        steps: lines(steps),
        keyPoints: lines(keyPoints),
        commonMistakes: lines(mistakes),
        managerCautions: cautions.trim(),
        met: numberOrNull('met', met),
        sourceNote: sourceNote.trim(),
      };
      return content as LibraryContentByType[T];
    }
    const content: GoalTemplateContent = {
      code: code.trim(),
      section,
      text: text.trim(),
      params: params.map(fromRow),
      metric: metric === 'none' ? null : (metric as GoalTemplateContent['metric']),
      metricParam: metric === 'none' ? null : metricParam || null,
      sourceNote: sourceNote.trim(),
    };
    return content as LibraryContentByType[T];
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let content: LibraryContentByType[T];
    try {
      content = build();
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      setError([
        t(
          err.kind === 'lines' ? 'planLibrary.form.invalidLines' : 'planLibrary.form.invalidNumber',
          {
            field: labels.field(err.field),
          },
        ),
      ]);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(content);
    } catch (err) {
      const e2: LibraryError = toLibraryError(err);
      setError(labels.errorText(e2));
      setSubmitting(false);
    }
  };

  const typeName = t(`planLibrary.tabs.${type}`);
  const textField = (
    key: string,
    value: string,
    onChange: (v: string) => void,
    opts: { multiline?: boolean; hint?: string; disabled?: boolean } = {},
  ) => (
    <div className={styles.field}>
      <label htmlFor={`${id}-${key}`}>{labels.field(key)}</label>
      {opts.multiline ? (
        <textarea
          id={`${id}-${key}`}
          className={own.textarea}
          rows={4}
          value={value}
          aria-describedby={opts.hint ? `${id}-${key}-hint` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={`${id}-${key}`}
          value={value}
          disabled={opts.disabled}
          aria-describedby={opts.hint ? `${id}-${key}-hint` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {opts.hint && (
        <small id={`${id}-${key}-hint`} className={styles.hint}>
          {opts.hint}
        </small>
      )}
    </div>
  );

  const checkGroup = <V extends string>(
    key: string,
    options: readonly V[],
    selected: readonly V[],
    onChange: (v: V[]) => void,
    label: (v: V) => string,
    hint?: string,
  ): ReactNode => (
    <fieldset className={own.fieldset}>
      <legend>{labels.field(key)}</legend>
      <div className={own.checks}>
        {options.map((o) => (
          <label key={o} className={styles.checkbox}>
            <input
              type="checkbox"
              checked={selected.includes(o)}
              onChange={(e) => onChange(toggle(selected, o, e.target.checked))}
            />
            <span>{label(o)}</span>
          </label>
        ))}
      </div>
      {hint && <small className={styles.hint}>{hint}</small>}
    </fieldset>
  );

  return (
    <Dialog
      wide
      title={t(editing ? 'planLibrary.form.editTitle' : 'planLibrary.form.createTitle', {
        type: typeName,
      })}
      onClose={onCancel}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {!editing && <small className={styles.hint}>{t('planLibrary.form.draftHint')}</small>}
        {textField('code', code, setCode, {
          hint: t('planLibrary.form.codeHint'),
          disabled: editing,
        })}

        {type === 'recipe' && (
          <>
            {textField('name', name, setName)}
            {checkGroup('mealTypes', MEAL_TYPES, mealTypes, setMealTypes, (m) =>
              t(`planLibrary.meals.${m}`),
            )}
            {textField('ingredients', ingredients, setIngredients, {
              multiline: true,
              hint: t('planLibrary.form.ingredientsHint'),
            })}
            {textField('steps', steps, setSteps, {
              multiline: true,
              hint: t('planLibrary.form.linesHint'),
            })}
            {checkGroup('tags', LIBRARY_TAGS, tags, setTags, (v) => t(`planLibrary.tags.${v}`))}
            {checkGroup(
              'allergens',
              ALLERGENS,
              allergens,
              setAllergens,
              (v) => t(`planLibrary.allergens.${v}`),
              t('planLibrary.form.allergensHint'),
            )}
            <fieldset className={own.fieldset}>
              <legend>{labels.field('nutritionPerServing')}</legend>
              <div className={own.grid}>
                {NUTRITION_KEYS.map((k) => (
                  <div key={k} className={styles.field}>
                    <label htmlFor={`${id}-${k}`}>{t(`planLibrary.fields.${k}`)}</label>
                    <input
                      id={`${id}-${k}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={nutrition[k]}
                      onChange={(e) => setNutrition((n) => ({ ...n, [k]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              <small className={styles.hint}>{t('planLibrary.form.nutritionHint')}</small>
            </fieldset>
            {textField('nutritionBasis', nutritionBasis, setNutritionBasis)}
          </>
        )}

        {type === 'exercise' && (
          <>
            {textField('name', name, setName)}
            <div className={own.grid}>
              <div className={styles.field}>
                <label htmlFor={`${id}-category`}>{labels.field('category')}</label>
                <select
                  id={`${id}-category`}
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ExerciseContent['category'])}
                >
                  {EXERCISE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`planLibrary.categories.${c}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-intensity`}>{labels.field('intensity')}</label>
                <select
                  id={`${id}-intensity`}
                  value={intensity}
                  onChange={(e) => setIntensity(e.target.value as ExerciseContent['intensity'])}
                >
                  {EXERCISE_INTENSITIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`planLibrary.intensities.${c}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {checkGroup('setting', EXERCISE_SETTINGS, setting, setSetting, (v) =>
              t(`planLibrary.settings.${v}`),
            )}
            {textField('equipment', equipment, setEquipment, {
              multiline: true,
              hint: t('planLibrary.form.linesHint'),
            })}
            {textField('steps', steps, setSteps, {
              multiline: true,
              hint: t('planLibrary.form.linesHint'),
            })}
            {textField('keyPoints', keyPoints, setKeyPoints, {
              multiline: true,
              hint: t('planLibrary.form.linesHint'),
            })}
            {textField('commonMistakes', mistakes, setMistakes, {
              multiline: true,
              hint: t('planLibrary.form.linesHint'),
            })}
            {textField('managerCautions', cautions, setCautions, {
              multiline: true,
              hint: t('planLibrary.form.cautionsHint'),
            })}
            {textField('met', met, setMet)}
          </>
        )}

        {type === 'goal_template' && (
          <>
            <div className={styles.field}>
              <label htmlFor={`${id}-section`}>{labels.field('section')}</label>
              <select
                id={`${id}-section`}
                value={section}
                onChange={(e) => setSection(e.target.value as GoalTemplateContent['section'])}
              >
                {PLAN_SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {t(`planLibrary.sections.${s}`)}
                  </option>
                ))}
              </select>
            </div>
            {textField('text', text, setText, { hint: t('planLibrary.form.textHint') })}
            <ParamsEditor rows={params} onChange={setParams} />
            <div className={own.grid}>
              <div className={styles.field}>
                <label htmlFor={`${id}-metric`}>{labels.field('metric')}</label>
                <select
                  id={`${id}-metric`}
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                >
                  {(['none', ...GOAL_METRICS] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`planLibrary.metrics.${m}`)}
                    </option>
                  ))}
                </select>
              </div>
              {metric !== 'none' && (
                <div className={styles.field}>
                  <label htmlFor={`${id}-metricParam`}>{labels.field('metricParam')}</label>
                  <select
                    id={`${id}-metricParam`}
                    value={metricParam}
                    onChange={(e) => setMetricParam(e.target.value)}
                  >
                    <option value="" />
                    {params
                      .filter((p) => p.type === 'int' && p.name)
                      .map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>
          </>
        )}

        {textField('sourceNote', sourceNote, setSourceNote, { multiline: true })}

        {error && (
          <div className={styles.error} role="alert">
            <ul className={own.issues}>
              {error.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.dialogActions}>
          <Button onClick={onCancel} disabled={submitting}>
            {t('planLibrary.form.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? t('planLibrary.form.saving') : t('planLibrary.form.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- 目标模板的参数 ----------

interface ParamRow {
  name: string;
  type: GoalParam['type'];
  min: string;
  max: string;
  default: string;
  unit: string;
}

function toRow(p: GoalParam): ParamRow {
  return {
    name: p.name,
    type: p.type,
    min: String(p.min),
    max: String(p.max),
    default: String(p.default),
    unit: p.type === 'int' ? (p.unit ?? '') : '',
  };
}

function fromRow(r: ParamRow): GoalParam {
  if (r.type === 'time') {
    return { name: r.name.trim(), type: 'time', min: r.min, max: r.max, default: r.default };
  }
  const num = (v: string) => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isInteger(n)) throw new FormatError('params', 'number');
    return n;
  };
  return {
    name: r.name.trim(),
    type: 'int',
    min: num(r.min),
    max: num(r.max),
    default: num(r.default),
    unit: r.unit.trim() || null,
  };
}

const MAX_PARAMS = 3;

function ParamsEditor({ rows, onChange }: { rows: ParamRow[]; onChange: (r: ParamRow[]) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const set = (i: number, patch: Partial<ParamRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className={own.fieldset}>
      <legend>{t('planLibrary.fields.params')}</legend>
      {rows.map((r, i) => (
        <div key={i} className={own.paramRow}>
          <div className={styles.field}>
            <label htmlFor={`${id}-${i}-name`}>{t('planLibrary.form.paramName')}</label>
            <input
              id={`${id}-${i}-name`}
              value={r.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-${i}-type`}>{t('planLibrary.form.paramType')}</label>
            <select
              id={`${id}-${i}-type`}
              value={r.type}
              onChange={(e) => set(i, { type: e.target.value as GoalParam['type'] })}
            >
              <option value="int">{t('planLibrary.paramTypes.int')}</option>
              <option value="time">{t('planLibrary.paramTypes.time')}</option>
            </select>
          </div>
          {(['min', 'max', 'default'] as const).map((k) => (
            <div key={k} className={styles.field}>
              <label htmlFor={`${id}-${i}-${k}`}>{t(`planLibrary.form.${k}`)}</label>
              <input
                id={`${id}-${i}-${k}`}
                value={r[k]}
                placeholder={r.type === 'time' ? 'HH:MM' : undefined}
                onChange={(e) => set(i, { [k]: e.target.value })}
              />
            </div>
          ))}
          {r.type === 'int' && (
            <div className={styles.field}>
              <label htmlFor={`${id}-${i}-unit`}>{t('planLibrary.fields.unit')}</label>
              <input
                id={`${id}-${i}-unit`}
                value={r.unit}
                onChange={(e) => set(i, { unit: e.target.value })}
              />
            </div>
          )}
          <IconButton
            label={t('planLibrary.form.removeParam', { n: i + 1 })}
            icon={<X size={16} aria-hidden />}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      {rows.length < MAX_PARAMS && (
        <Button
          variant="ghost"
          onClick={() =>
            onChange([...rows, { name: '', type: 'int', min: '', max: '', default: '', unit: '' }])
          }
        >
          {t('planLibrary.form.addParam')}
        </Button>
      )}
    </fieldset>
  );
}
