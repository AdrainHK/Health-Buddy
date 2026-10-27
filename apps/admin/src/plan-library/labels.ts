import type {
  Exercise,
  GoalTemplate,
  LibraryContentRejection,
  LibraryItemType,
  Recipe,
} from '@health-buddy/shared';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';

export type AnyItem = Recipe | Exercise | GoalTemplate;

export function itemName(item: AnyItem): string {
  return 'name' in item ? item.name : item.text;
}

/** 保存和状态流转失败时显示什么；invalid_content 另外列出标出的位置 */
export type LibraryErrorKey =
  | 'version_mismatch'
  | 'not_draft'
  | 'invalid_transition'
  | 'duplicate_code'
  | 'bad_request'
  | 'forbidden'
  | 'network'
  | 'unknown';

export interface LibraryError {
  key: LibraryErrorKey | 'invalid_content';
  issues: LibraryContentRejection['issues'];
}

const CONFLICTS = new Set([
  'version_mismatch',
  'not_draft',
  'invalid_transition',
  'duplicate_code',
]);

export function toLibraryError(err: unknown): LibraryError {
  if (!(err instanceof ApiError)) return { key: 'unknown', issues: [] };
  if (err.code === 'invalid_content') {
    const issues = Array.isArray(err.details.issues)
      ? (err.details.issues as LibraryContentRejection['issues'])
      : [];
    return { key: 'invalid_content', issues };
  }
  if (err.code === 'conflict') {
    const reason = Array.isArray(err.details.reasons) ? String(err.details.reasons[0]) : '';
    return { key: CONFLICTS.has(reason) ? (reason as LibraryErrorKey) : 'unknown', issues: [] };
  }
  if (err.code === 'bad_request' || err.code === 'forbidden' || err.code === 'network') {
    return { key: err.code, issues: [] };
  }
  return { key: 'unknown', issues: [] };
}

const FIELD_KEYS = [
  'code',
  'name',
  'mealTypes',
  'ingredients',
  'steps',
  'tags',
  'allergens',
  'nutritionPerServing',
  'nutritionBasis',
  'sourceNote',
  'category',
  'intensity',
  'setting',
  'equipment',
  'keyPoints',
  'commonMistakes',
  'managerCautions',
  'met',
  'section',
  'text',
  'params',
  'metric',
  'metricParam',
  'energyKcal',
  'proteinG',
  'fatG',
  'carbG',
  'fiberG',
  'sodiumMg',
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

const SUBFIELDS = {
  name: 'ingredientName',
  householdAmount: 'householdAmount',
  overseasAlternative: 'overseasAlternative',
  unit: 'unit',
} as const;

export function useLibraryLabels() {
  const { t, i18n } = useTranslation();
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const field = (key: string): string =>
    (FIELD_KEYS as readonly string[]).includes(key)
      ? t(`planLibrary.fields.${key as FieldKey}`)
      : key;

  /** 字段路径（如 steps.1、ingredients.0.name）→ “做法 · 第 2 项” */
  const fieldPath = (path: string): string => {
    const [head = '', index, sub] = path.split('.');
    const parts = [field(head)];
    if (index !== undefined && /^\d+$/.test(index)) {
      parts.push(t('planLibrary.fields.item', { n: Number(index) + 1 }));
    }
    if (sub && Object.hasOwn(SUBFIELDS, sub)) {
      parts.push(t(`planLibrary.fields.${SUBFIELDS[sub as keyof typeof SUBFIELDS]}`));
    }
    return parts.join(' · ');
  };

  const errorText = (e: LibraryError): string[] => {
    if (e.key !== 'invalid_content') return [t(`planLibrary.errors.${e.key}`)];
    return [
      t('planLibrary.errors.invalid_content'),
      ...e.issues.map((i) =>
        t('planLibrary.errors.issue', { field: fieldPath(i.path), term: i.term }),
      ),
    ];
  };

  /** 列表里“类别”一列：食谱写餐次，运动写类别和强度，目标模板写部分 */
  const kind = (type: LibraryItemType, item: AnyItem): string => {
    if (type === 'recipe') {
      return (item as Recipe).mealTypes
        .map((m) => t(`planLibrary.meals.${m}`))
        .join(t('planLibrary.separator'));
    }
    if (type === 'exercise') {
      const e = item as Exercise;
      return `${t(`planLibrary.categories.${e.category}`)} · ${t(`planLibrary.intensities.${e.intensity}`)}`;
    }
    return t(`planLibrary.sections.${(item as GoalTemplate).section}`);
  };

  return {
    field,
    fieldPath,
    errorText,
    kind,
    formatTime: (iso: string) => time.format(new Date(iso)),
  };
}
