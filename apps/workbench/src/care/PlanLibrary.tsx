import {
  EXERCISE_CATEGORIES,
  EXERCISE_INTENSITIES,
  LIBRARY_TAGS,
  MEAL_TYPES,
  PLAN_SECTIONS,
  type ExerciseCategory,
  type ExerciseManagerView,
  type GoalParam,
  type GoalTemplateManagerView,
  type LibraryTag,
  type MealType,
  type PlanSection,
  type RecipeManagerView,
} from '@health-buddy/shared';
import { Button, EmptyState, IconButton } from '@health-buddy/ui';
import { BookOpen, Menu } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listExercises, listGoalTemplates, listRecipes } from '../api/care';
import { isAbortError } from '../api/http';
import { formatNumber } from '../twin/format';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';

const TABS = ['recipes', 'exercises', 'goals'] as const;
type Tab = (typeof TABS)[number];

type Item =
  | { type: 'recipe'; item: RecipeManagerView }
  | { type: 'exercise'; item: ExerciseManagerView }
  | { type: 'goal'; item: GoalTemplateManagerView };

interface ListState {
  status: 'loading' | 'ready' | 'error';
  items: Item[];
}

/** 搜索框输入后等一会儿再查，避免每个字都请求一次 */
const SEARCH_DELAY_MS = 300;

export interface PlanLibraryProps {
  narrow: boolean;
  onOpenMenu: () => void;
}

/**
 * 中间区域的“方案库”（M5 规格 2.4）：健管师浏览已发布的食谱、运动和放松练习、目标模板，
 * 按餐次、类别、标签筛选和搜索；点开看详情；不能编辑。只读平台级数据，不含客户数据，不调用大模型。
 */
export function PlanLibrary({ narrow, onOpenMenu }: PlanLibraryProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('recipes');
  const [meal, setMeal] = useState<MealType | ''>('');
  const [tag, setTag] = useState<LibraryTag | ''>('');
  const [category, setCategory] = useState<ExerciseCategory | ''>('');
  const [intensity, setIntensity] = useState<'low' | 'moderate' | ''>('');
  const [section, setSection] = useState<PlanSection | ''>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [list, setList] = useState<ListState>({ status: 'loading', items: [] });
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<Item | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const listId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setList((l) => ({ status: 'loading', items: l.items }));
    const load = async (): Promise<Item[]> => {
      if (tab === 'recipes') {
        const items = await listRecipes(
          { meal: meal || null, tags: tag ? [tag] : [], q: q || null },
          signal,
        );
        return items.map((item) => ({ type: 'recipe', item }));
      }
      if (tab === 'exercises') {
        const items = await listExercises(
          { category: category || null, intensity: intensity || null, q: q || null },
          signal,
        );
        return items.map((item) => ({ type: 'exercise', item }));
      }
      const items = await listGoalTemplates({ section: section || null }, signal);
      return items.map((item) => ({ type: 'goal', item }));
    };
    load()
      .then((items) => setList({ status: 'ready', items }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setList({ status: 'error', items: [] });
      });
    return () => controller.abort();
  }, [tab, meal, tag, category, intensity, section, q, reload]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setOpen(null);
    setSearch('');
    setQ('');
    setList({ status: 'loading', items: [] });
  };

  const onTabKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? 'recipes';
    switchTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <main className={styles.center}>
      <header className={styles.topbar}>
        {narrow && (
          <IconButton
            label={t('nav.openMenu')}
            icon={<Menu size={18} />}
            aria-controls="hb-sidebar"
            onClick={onOpenMenu}
          />
        )}
        <h1 className={styles.topbarTitle}>{t('library.title')}</h1>
      </header>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <p className={styles.muted}>{t('library.intro')}</p>
          <div className={care.libraryTabs} role="tablist" aria-label={t('library.title')}>
            {TABS.map((id) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={listId}
                tabIndex={tab === id ? 0 : -1}
                className={care.libraryTab}
                onClick={() => switchTab(id)}
                onKeyDown={onTabKeyDown}
              >
                {t(`library.tabs.${id}`)}
              </button>
            ))}
          </div>
          <div id={listId} role="tabpanel">
            {open ? (
              <div className={care.detail}>
                <div>
                  <Button variant="ghost" onClick={() => setOpen(null)}>
                    {t('library.back')}
                  </Button>
                </div>
                <ItemDetail entry={open} />
              </div>
            ) : (
              <>
                <div className={care.filters}>
                  {tab !== 'goals' && (
                    <label className={styles.label}>
                      {t('library.search')}
                      <input
                        type="search"
                        className={styles.input}
                        value={search}
                        maxLength={40}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                  )}
                  {tab === 'recipes' && (
                    <>
                      <Select
                        label={t('library.meal')}
                        value={meal}
                        options={MEAL_TYPES.map((m) => [m, t(`library.meals.${m}`)])}
                        onChange={(v) => setMeal(v as MealType | '')}
                      />
                      <Select
                        label={t('library.tags')}
                        value={tag}
                        options={LIBRARY_TAGS.map((g) => [g, t(`library.tagNames.${g}`)])}
                        onChange={(v) => setTag(v as LibraryTag | '')}
                      />
                    </>
                  )}
                  {tab === 'exercises' && (
                    <>
                      <Select
                        label={t('library.category')}
                        value={category}
                        options={EXERCISE_CATEGORIES.map((c) => [c, t(`library.categories.${c}`)])}
                        onChange={(v) => setCategory(v as ExerciseCategory | '')}
                      />
                      <Select
                        label={t('library.intensity')}
                        value={intensity}
                        options={EXERCISE_INTENSITIES.map((i) => [
                          i,
                          t(`library.intensities.${i}`),
                        ])}
                        onChange={(v) => setIntensity(v as 'low' | 'moderate' | '')}
                      />
                    </>
                  )}
                  {tab === 'goals' && (
                    <Select
                      label={t('library.section')}
                      value={section}
                      options={PLAN_SECTIONS.map((s) => [s, t(`library.sections.${s}`)])}
                      onChange={(v) => setSection(v as PlanSection | '')}
                    />
                  )}
                </div>
                <ItemList state={list} onRetry={() => setReload((v) => v + 1)} onOpen={setOpen} />
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className={styles.label}>
      {label}
      <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('library.all')}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function ItemList({
  state,
  onRetry,
  onOpen,
}: {
  state: ListState;
  onRetry: () => void;
  onOpen: (item: Item) => void;
}) {
  const { t } = useTranslation();
  if (state.status === 'error') {
    return (
      <div role="alert">
        <p className={styles.error}>{t('library.loadFailed')}</p>
        <Button onClick={onRetry}>{t('library.retry')}</Button>
      </div>
    );
  }
  if (state.status === 'loading' && state.items.length === 0) {
    return (
      <p className={styles.muted} role="status">
        {t('library.loading')}
      </p>
    );
  }
  if (state.items.length === 0) {
    return <EmptyState icon={<BookOpen size={20} />} title={t('library.empty')} />;
  }
  return (
    <>
      <p className={styles.muted} role="status">
        {t('library.count', { count: state.items.length })}
      </p>
      <ul className={care.itemList} aria-label={t('library.title')}>
        {state.items.map((entry) => (
          <li key={entry.item.id}>
            <button type="button" className={care.itemButton} onClick={() => onOpen(entry)}>
              <ItemSummary entry={entry} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 目标模板的文字：占位换成参数范围，如“每天步行 [4000–10000] 步” */
function goalTemplateText(item: GoalTemplateManagerView): string {
  const byName = new Map(item.params.map((p) => [p.name, p]));
  return item.text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, name: string) => {
    const p = byName.get(name);
    return p ? `[${paramValue(p, p.min)}–${paramValue(p, p.max)}]` : whole;
  });
}

function paramValue(p: GoalParam, v: number | string): string {
  return p.type === 'int' && typeof v === 'number' ? formatNumber(v) : String(v);
}

function ItemSummary({ entry }: { entry: Item }) {
  const { t } = useTranslation();
  if (entry.type === 'recipe') {
    const r = entry.item;
    return (
      <>
        <span className={care.itemName}>{r.name}</span>
        <ul className={care.chips}>
          {r.mealTypes.map((m) => (
            <li key={m} className={care.chip}>
              {t(`library.meals.${m}`)}
            </li>
          ))}
          {r.tags.map((g) => (
            <li key={g} className={care.chip}>
              {t(`library.tagNames.${g}`)}
            </li>
          ))}
          {r.allergens.map((a) => (
            <li key={a} className={care.chip} data-kind="allergen">
              {t(`library.allergenNames.${a}`)}
            </li>
          ))}
        </ul>
      </>
    );
  }
  if (entry.type === 'exercise') {
    const e = entry.item;
    return (
      <>
        <span className={care.itemName}>{e.name}</span>
        <ul className={care.chips}>
          <li className={care.chip}>{t(`library.categories.${e.category}`)}</li>
          <li className={care.chip}>{t(`library.intensities.${e.intensity}`)}</li>
          {e.setting.map((s) => (
            <li key={s} className={care.chip}>
              {t(`library.settings.${s}`)}
            </li>
          ))}
        </ul>
      </>
    );
  }
  const g = entry.item;
  return (
    <>
      <span className={care.itemName}>{goalTemplateText(g)}</span>
      <ul className={care.chips}>
        <li className={care.chip}>{t(`library.sections.${g.section}`)}</li>
        {g.metric && <li className={care.chip}>{t(`care.adherence.metrics.${g.metric}`)}</li>}
      </ul>
    </>
  );
}

function TextList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <h6 className={care.subTitle}>{title}</h6>
      <ul className={care.goalList}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

function ItemDetail({ entry }: { entry: Item }) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [entry]);
  const version = (
    <p className={styles.muted}>{t('library.version', { version: entry.item.version })}</p>
  );
  if (entry.type === 'recipe') {
    const r = entry.item;
    const n = r.nutritionPerServing;
    return (
      <>
        <h2 ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          {r.name}
        </h2>
        {version}
        <ItemSummary entry={entry} />
        <div>
          <h6 className={care.subTitle}>{t('library.recipe.ingredients')}</h6>
          <ul className={care.goalList}>
            {r.ingredients.map((ing, i) => (
              <li key={i}>
                {ing.name} {ing.householdAmount}
                {ing.grams !== null && (
                  <span className={styles.muted}>
                    {' '}
                    {t('library.recipe.grams', { grams: formatNumber(ing.grams) })}
                  </span>
                )}
                {ing.overseasAlternative && (
                  <span className={styles.muted}>
                    {' '}
                    {t('library.recipe.overseas', { alt: ing.overseasAlternative })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <TextList title={t('library.recipe.steps')} items={r.steps} />
        <div>
          <h6 className={care.subTitle}>{t('library.recipe.nutrition')}</h6>
          {n ? (
            <>
              <p className={styles.followUpBasis}>
                {t('library.recipe.nutritionLine', {
                  energy: formatNumber(n.energyKcal),
                  protein: formatNumber(n.proteinG),
                  fat: formatNumber(n.fatG),
                  carb: formatNumber(n.carbG),
                  fiber: formatNumber(n.fiberG),
                  sodium: formatNumber(n.sodiumMg),
                })}
              </p>
              {r.nutritionBasis && (
                <p className={styles.muted}>
                  {t('library.recipe.nutritionBasis', { basis: r.nutritionBasis })}
                </p>
              )}
            </>
          ) : (
            <p className={styles.muted}>{t('library.recipe.noNutrition')}</p>
          )}
        </div>
        <div>
          <h6 className={care.subTitle}>{t('library.recipe.allergens')}</h6>
          <p className={styles.followUpBasis}>
            {r.allergens.length
              ? r.allergens.map((a) => t(`library.allergenNames.${a}`)).join(t('care.separator'))
              : t('library.recipe.noAllergens')}
          </p>
        </div>
        <div>
          <h6 className={care.subTitle}>{t('library.recipe.source')}</h6>
          <p className={styles.muted}>{r.sourceNote}</p>
        </div>
      </>
    );
  }
  if (entry.type === 'exercise') {
    const e = entry.item;
    return (
      <>
        <h2 ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          {e.name}
        </h2>
        {version}
        <ItemSummary entry={entry} />
        <p className={styles.followUpBasis}>
          {t('library.exercise.equipmentLine', {
            list: e.equipment.length
              ? e.equipment.join(t('care.separator'))
              : t('library.exercise.noEquipment'),
          })}
        </p>
        <TextList title={t('library.exercise.steps')} items={e.steps} />
        <TextList title={t('library.exercise.keyPoints')} items={e.keyPoints} />
        {e.commonMistakes.length > 0 && (
          <TextList title={t('library.exercise.mistakes')} items={e.commonMistakes} />
        )}
        <div className={care.cautions}>
          <h6 className={care.subTitle}>{t('library.exercise.cautions')}</h6>
          <p className={styles.followUpBasis}>{e.managerCautions}</p>
        </div>
        {e.met !== null && (
          <p className={styles.muted}>{t('library.exercise.met', { met: formatNumber(e.met) })}</p>
        )}
        <div>
          <h6 className={care.subTitle}>{t('library.exercise.source')}</h6>
          <p className={styles.muted}>{e.sourceNote}</p>
        </div>
      </>
    );
  }
  const g = entry.item;
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
        {goalTemplateText(g)}
      </h2>
      {version}
      <ItemSummary entry={entry} />
      {g.params.length > 0 && (
        <TextList
          title={t('library.goal.params')}
          items={g.params.map((p) =>
            t('library.goal.param', {
              name: p.name,
              min: paramValue(p, p.min),
              max: paramValue(p, p.max),
              def: paramValue(p, p.default),
              unit: p.type === 'int' && p.unit ? ` ${p.unit}` : '',
            }),
          )}
        />
      )}
      {g.metric && (
        <p className={styles.muted}>
          {t('library.goal.metric', { metric: t(`care.adherence.metrics.${g.metric}`) })}
        </p>
      )}
      <div>
        <h6 className={care.subTitle}>{t('library.goal.source')}</h6>
        <p className={styles.muted}>{g.sourceNote}</p>
      </div>
    </>
  );
}
