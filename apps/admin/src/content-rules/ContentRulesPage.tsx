import {
  CONTENT_RULE_GROUPS_MAX,
  CONTENT_RULE_TERMS_MAX,
  contentRulesSchema,
  type ContentRuleGroup,
  type ContentRulesResponse,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getContentRules, saveContentRules } from '../api/contentRules';
import { ApiError } from '../api/http';
import styles from '../thresholds/Thresholds.module.css';
import page from './ContentRules.module.css';

type State =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: ContentRulesResponse };

/** 编辑中的一组：词语用一个文本框，每行一个 */
interface Draft extends Omit<ContentRuleGroup, 'terms'> {
  termsText: string;
}

const toDraft = (g: ContentRuleGroup): Draft => {
  const { terms, ...rest } = g;
  return { ...rest, termsText: terms.join('\n') };
};
const toGroup = ({ termsText, ...rest }: Draft): ContentRuleGroup => ({
  ...rest,
  terms: [
    ...new Set(
      termsText
        .split(/[\n,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ],
});

/** 内置检查项：不能在后台关掉（M8 规格 2.3） */
const BUILTINS = ['banned', 'invisible', 'drug', 'citation'] as const;

/**
 * 平台“科普合规规则”页（M8 规格 2.3，Q3）：按组维护科普的合规词表，每次保存生成一个新版本，
 * 之后的检查按新版本执行。只用于科普，不改动原有禁用词表。内置检查项只读列出。
 */
export function ContentRulesPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<'invalid' | 'changed' | 'unknown' | null>(null);

  useEffect(() => {
    let cancelled = false;
    getContentRules()
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data });
        setDrafts(data.rules.map(toDraft));
      })
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const save = async () => {
    if (state.status !== 'ready') return;
    setNotice(null);
    setError(null);
    const parsed = contentRulesSchema.safeParse(drafts.map(toGroup));
    if (!parsed.success) {
      setError('invalid');
      return;
    }
    // 删除或放宽“禁止”类的组时先确认（合规审查 S5）；保存本身会留操作记录
    const weakened = state.data.rules.filter(
      (g) =>
        g.category === 'forbid' &&
        !parsed.data.some((n) => n.id === g.id && n.category === 'forbid'),
    );
    if (
      weakened.length &&
      !window.confirm(t('contentRules.confirmWeaken', { names: weakened.map((g) => g.label).join('、') }))
    ) {
      return;
    }
    setSaving(true);
    try {
      const data = await saveContentRules(state.data.version, parsed.data);
      setState({ status: 'ready', data });
      setDrafts(data.rules.map(toDraft));
      setNotice(t('contentRules.saved', { version: data.version }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') setError('changed');
      else if (err instanceof ApiError && err.code === 'bad_request') setError('invalid');
      else setError('unknown');
    } finally {
      setSaving(false);
    }
  };

  const addGroup = () => {
    let n = drafts.length + 1;
    while (drafts.some((d) => d.id === `custom_${n}`)) n++;
    setDrafts((list) => [
      ...list,
      {
        id: `custom_${n}`,
        category: 'review',
        label: '',
        reason: '',
        termsText: '',
        negatable: false,
      },
    ]);
  };

  return (
    <section className={styles.page} aria-labelledby="content-rules-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('contentRules.disclaimer')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="content-rules-title" className={styles.title}>
            {t('contentRules.title')}
          </h1>
          {state.status === 'ready' && (
            <p className={styles.subtitle}>
              {t('contentRules.version', {
                version: state.data.version,
                date: state.data.createdAt.slice(0, 10),
              })}
            </p>
          )}
        </div>
        {state.status === 'ready' && (
          <div className={styles.toolbar}>
            <Button
              icon={<Plus size={16} aria-hidden />}
              disabled={drafts.length >= CONTENT_RULE_GROUPS_MAX}
              onClick={addGroup}
            >
              {t('contentRules.addGroup')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {t('contentRules.save')}
            </Button>
          </div>
        )}
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <span>{t(`contentRules.errors.${error}`)}</span>
          {error === 'changed' && (
            <Button onClick={() => setReloadKey((k) => k + 1)}>{t('contentRules.reload')}</Button>
          )}
        </div>
      )}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('contentRules.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('contentRules.loadFailed')}</span>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t('contentRules.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <section aria-labelledby="content-rules-builtin" className={page.builtin}>
            <h2 id="content-rules-builtin" className={page.heading}>
              {t('contentRules.builtinTitle')}
            </h2>
            <ul className={page.builtinList}>
              {BUILTINS.map((b) => (
                <li key={b}>{t(`contentRules.builtin.${b}`)}</li>
              ))}
            </ul>
          </section>
          <ol className={page.groups} aria-label={t('contentRules.groups')}>
            {drafts.map((d, i) => (
              <GroupEditor
                key={i}
                draft={d}
                onChange={(patch) => update(i, patch)}
                onRemove={
                  drafts.length > 1
                    ? () => setDrafts((list) => list.filter((_, j) => j !== i))
                    : undefined
                }
              />
            ))}
          </ol>
          <p className={styles.muted}>
            {t('contentRules.history', {
              versions: state.data.history.map((h) => `v${h.version}`).join('、'),
            })}
          </p>
        </>
      )}
    </section>
  );
}

function GroupEditor({
  draft,
  onChange,
  onRemove,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onRemove?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const id = useId();
  const count = toGroup(draft).terms.length;
  const name = draft.label || draft.id;
  return (
    <li className={page.group} aria-label={name}>
      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span>{t('contentRules.label')}</span>
          <input
            value={draft.label}
            maxLength={30}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('contentRules.category')}</span>
          <select
            value={draft.category}
            onChange={(e) => onChange({ category: e.target.value as Draft['category'] })}
          >
            <option value="forbid">{t('contentRules.categories.forbid')}</option>
            <option value="review">{t('contentRules.categories.review')}</option>
          </select>
        </label>
      </div>
      <label className={styles.field}>
        <span>{t('contentRules.reason')}</span>
        <input
          value={draft.reason}
          maxLength={80}
          onChange={(e) => onChange({ reason: e.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>{t('contentRules.terms', { count, max: CONTENT_RULE_TERMS_MAX })}</span>
        <textarea
          id={`${id}-terms`}
          rows={4}
          value={draft.termsText}
          onChange={(e) => onChange({ termsText: e.target.value })}
        />
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={draft.negatable}
          onChange={(e) => onChange({ negatable: e.target.checked })}
        />
        <span>{t('contentRules.negatable')}</span>
      </label>
      {onRemove && (
        <div className={styles.rowActions}>
          <Button
            variant="ghost"
            icon={<Trash2 size={16} aria-hidden />}
            aria-label={t('contentRules.removeGroup', { name })}
            onClick={onRemove}
          >
            {t('contentRules.remove')}
          </Button>
        </div>
      )}
    </li>
  );
}
