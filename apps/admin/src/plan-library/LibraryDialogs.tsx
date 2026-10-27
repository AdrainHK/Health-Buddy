import type {
  Exercise,
  GoalTemplate,
  LibraryItemEvent,
  LibraryItemType,
  Recipe,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { listLibraryEvents } from '../api/planLibrary';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import { itemName, toLibraryError, useLibraryLabels, type AnyItem } from './labels';
import own from './PlanLibrary.module.css';

function List({ items }: { items: readonly string[] }) {
  return (
    <ol>
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

/** 条目详情（只读）：所有后台角色都能看，平台管理员审定前也用它核对全文 */
export function LibraryItemView({
  type,
  item,
  onClose,
}: {
  type: LibraryItemType;
  item: AnyItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const labels = useLibraryLabels();
  const none = t('planLibrary.view.none');
  const sep = t('planLibrary.separator');
  const rows: [string, ReactNode][] = [[labels.field('code'), item.code]];

  if (type === 'recipe') {
    const r = item as Recipe;
    rows.push(
      [labels.field('mealTypes'), labels.kind(type, r)],
      [
        labels.field('ingredients'),
        <ul key="ing">
          {r.ingredients.map((i, n) => (
            <li key={n}>
              {t('planLibrary.view.ingredient', { name: i.name, amount: i.householdAmount })}
              {i.overseasAlternative
                ? t('planLibrary.view.alternative', { alt: i.overseasAlternative })
                : ''}
            </li>
          ))}
        </ul>,
      ],
      [labels.field('steps'), <List key="steps" items={r.steps} />],
      [labels.field('tags'), r.tags.map((v) => t(`planLibrary.tags.${v}`)).join(sep) || none],
      [
        labels.field('allergens'),
        r.allergens.map((v) => t(`planLibrary.allergens.${v}`)).join(sep) ||
          t('planLibrary.noAllergens'),
      ],
      [
        labels.field('nutritionPerServing'),
        r.nutritionPerServing
          ? Object.entries(r.nutritionPerServing)
              .map(([k, v]) =>
                t('planLibrary.view.nutritionItem', { field: labels.field(k), value: v }),
              )
              .join(t('planLibrary.view.nutritionSeparator'))
          : t('planLibrary.view.notFilled'),
      ],
      [labels.field('nutritionBasis'), r.nutritionBasis ?? t('planLibrary.view.notFilled')],
    );
  } else if (type === 'exercise') {
    const e = item as Exercise;
    rows.push(
      [labels.field('category'), labels.kind(type, e)],
      [labels.field('setting'), e.setting.map((s) => t(`planLibrary.settings.${s}`)).join(sep)],
      [labels.field('equipment'), e.equipment.join(sep) || none],
      [labels.field('steps'), <List key="steps" items={e.steps} />],
      [labels.field('keyPoints'), <List key="kp" items={e.keyPoints} />],
      [
        labels.field('commonMistakes'),
        e.commonMistakes.length ? <List key="cm" items={e.commonMistakes} /> : none,
      ],
      [labels.field('managerCautions'), e.managerCautions],
      [labels.field('met'), e.met ?? t('planLibrary.view.notFilled')],
    );
  } else {
    const g = item as GoalTemplate;
    rows.push(
      [labels.field('section'), labels.kind(type, g)],
      [labels.field('text'), g.text],
      [
        labels.field('params'),
        g.params.length ? (
          <ul key="params">
            {g.params.map((p) => (
              <li key={p.name}>
                {t('planLibrary.view.paramRange', {
                  name: p.name,
                  min: p.min,
                  max: p.max,
                  default: p.default,
                })}
                {p.type === 'int' && p.unit ? ` ${p.unit}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          none
        ),
      ],
      [
        labels.field('metric'),
        g.metric
          ? t('planLibrary.view.metricWithParam', {
              metric: t(`planLibrary.metrics.${g.metric}`),
              param: g.metricParam ?? '',
            })
          : t('planLibrary.metrics.none'),
      ],
    );
  }
  rows.push(
    [labels.field('sourceNote'), item.sourceNote],
    [
      labels.field('reviewed'),
      item.reviewedByLabel && item.reviewedOn
        ? t('planLibrary.view.reviewedBy', { name: item.reviewedByLabel, date: item.reviewedOn })
        : t('planLibrary.view.notFilled'),
    ],
  );

  return (
    <Dialog wide title={itemName(item)} onClose={onClose}>
      <dl className={own.detail}>
        {rows.map(([k, v]) => (
          <div key={k} className={own.detailRow}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.dialogActions}>
        <Button autoFocus onClick={onClose}>
          {t('planLibrary.view.close')}
        </Button>
      </div>
    </Dialog>
  );
}

/** 发布：必须填审定人和审定日期（规格 2.4） */
export function PublishDialog({
  item,
  onSubmit,
  onCancel,
}: {
  item: AnyItem;
  onSubmit: (reviewer: { reviewedByLabel: string; reviewedOn: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const labels = useLibraryLabels();
  const id = useId();
  const [reviewer, setReviewer] = useState('');
  const [date, setDate] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string[] | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reviewer.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError([t('planLibrary.publish.required')]);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await onSubmit({ reviewedByLabel: reviewer.trim(), reviewedOn: date });
    } catch (err) {
      setError(labels.errorText(toLibraryError(err)));
      setWorking(false);
    }
  };

  return (
    <Dialog title={t('planLibrary.publish.title', { name: itemName(item) })} onClose={onCancel}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <p className={styles.dialogBody}>{t('planLibrary.publish.body')}</p>
        <div className={styles.field}>
          <label htmlFor={`${id}-reviewer`}>{t('planLibrary.publish.reviewer')}</label>
          <input
            id={`${id}-reviewer`}
            value={reviewer}
            maxLength={60}
            autoFocus
            onChange={(e) => setReviewer(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-date`}>{t('planLibrary.publish.reviewedOn')}</label>
          <input
            id={`${id}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
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
          <Button onClick={onCancel} disabled={working}>
            {t('planLibrary.publish.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={working}>
            {working ? t('planLibrary.publish.working') : t('planLibrary.publish.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function show(v: unknown, empty: string): string {
  if (v === null || v === undefined || v === '') return empty;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 修改记录（只有平台管理员）：新的在前，列出改前改后 */
export function LibraryHistory({
  type,
  item,
  onClose,
}: {
  type: LibraryItemType;
  item: AnyItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const labels = useLibraryLabels();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; events: LibraryItemEvent[] }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listLibraryEvents(type, item.id)
      .then((events) => !cancelled && setState({ status: 'ready', events }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [type, item.id]);

  const empty = t('planLibrary.history.empty_value');
  return (
    <Dialog wide title={t('planLibrary.history.title', { name: itemName(item) })} onClose={onClose}>
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('planLibrary.history.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <p className={styles.error} role="alert">
          {t('planLibrary.history.loadFailed')}
        </p>
      )}
      {state.status === 'ready' && state.events.length === 0 && (
        <p className={styles.muted}>{t('planLibrary.history.empty')}</p>
      )}
      {state.status === 'ready' && state.events.length > 0 && (
        <ol className={own.history}>
          {state.events.map((e) => (
            <li key={e.id}>
              <div className={own.historyMeta}>
                <strong>{t(`planLibrary.history.actions.${e.action}`)}</strong>
                <span>{e.actorName ?? t('planLibrary.history.system')}</span>
                <time dateTime={e.createdAt}>{labels.formatTime(e.createdAt)}</time>
                <span>{t(`planLibrary.status.${e.status}`)}</span>
                <span>{t('planLibrary.versionValue', { version: e.version })}</span>
              </div>
              {e.changes.length > 0 && (
                <ul className={own.changes}>
                  {e.changes.map((c) => (
                    <li key={c.field}>
                      {t('planLibrary.history.change', {
                        field: labels.field(c.field),
                        before:
                          c.field === 'status'
                            ? t(`planLibrary.status.${String(c.before) as Recipe['status']}`)
                            : show(c.before, empty),
                        after:
                          c.field === 'status'
                            ? t(`planLibrary.status.${String(c.after) as Recipe['status']}`)
                            : show(c.after, empty),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className={styles.dialogActions}>
        <Button autoFocus onClick={onClose}>
          {t('planLibrary.history.close')}
        </Button>
      </div>
    </Dialog>
  );
}
