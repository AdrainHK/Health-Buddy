import {
  LIBRARY_ITEM_STATUSES,
  LIBRARY_ITEM_TYPES,
  LIBRARY_STATUS_TRANSITIONS,
  type CurrentUser,
  type LibraryItemStatus,
  type LibraryItemType,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createLibraryItem,
  listLibrary,
  setLibraryStatus,
  updateLibraryItem,
  type LibraryContentByType,
  type LibraryItemByType,
} from '../api/planLibrary';
import styles from '../thresholds/Thresholds.module.css';
import { itemName, toLibraryError, useLibraryLabels, type AnyItem } from './labels';
import { LibraryHistory, LibraryItemView, PublishDialog } from './LibraryDialogs';
import { LibraryItemForm } from './LibraryItemForm';
import own from './PlanLibrary.module.css';

type ListState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: AnyItem[] };

type Overlay =
  | { kind: 'create' }
  | { kind: 'edit'; item: AnyItem }
  | { kind: 'view'; item: AnyItem }
  | { kind: 'history'; item: AnyItem }
  | { kind: 'publish'; item: AnyItem }
  | null;

/** 状态流转按钮的文字：送审、发布、停用、退回草稿 */
const TRANSITION_ACTION: Record<LibraryItemStatus, 'submit' | 'publish' | 'retire' | 'toDraft'> = {
  review: 'submit',
  published: 'publish',
  retired: 'retire',
  draft: 'toDraft',
};

/**
 * 方案库（M5 规格 2.4、2.12）：食谱、运动和放松练习、目标模板三个标签。
 * 平台管理员新增、修改（只能改草稿）、送审、发布（填审定人和日期）、停用、看修改记录；
 * 协会和机构管理员只读浏览已发布的条目。界面只决定显示哪些按钮，真正的权限在后端和行级安全。
 */
export function PlanLibraryPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const labels = useLibraryLabels();
  const id = useId();
  const canEdit = user.role === 'platform_admin';

  const [type, setType] = useState<LibraryItemType>('recipe');
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState<LibraryItemStatus | ''>('');
  const [query, setQuery] = useState('');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    listLibrary(type)
      .then((items) => !cancelled && setList({ status: 'ready', items }))
      .catch(() => !cancelled && setList({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [type, reloadKey]);

  const visible = useMemo(() => {
    if (list.status !== 'ready') return [];
    const q = query.trim().toLowerCase();
    return list.items.filter(
      (i) =>
        (!statusFilter || i.status === statusFilter) &&
        (!q || itemName(i).toLowerCase().includes(q)),
    );
  }, [list, statusFilter, query]);

  const upsert = (saved: AnyItem) =>
    setList((current) => {
      if (current.status !== 'ready') return current;
      const exists = current.items.some((x) => x.id === saved.id);
      return {
        status: 'ready',
        items: exists
          ? current.items.map((x) => (x.id === saved.id ? saved : x))
          : [...current.items, saved],
      };
    });

  const startAction = () => {
    setActionError(null);
    setNotice(null);
  };

  const switchType = (next: LibraryItemType) => {
    startAction();
    setOverlay(null);
    // 筛选条件只对当前库有意义，换库时清空
    setQuery('');
    setStatusFilter('');
    setType(next);
  };

  const save = async (content: LibraryContentByType[LibraryItemType]) => {
    const saved =
      overlay?.kind === 'edit'
        ? await updateLibraryItem(type, overlay.item.id, overlay.item.version, content)
        : await createLibraryItem(type, content);
    upsert(saved as AnyItem);
    setOverlay(null);
    setNotice(t('planLibrary.saved'));
  };

  const transition = async (item: AnyItem, status: LibraryItemStatus) => {
    if (status === 'published') {
      startAction();
      setOverlay({ kind: 'publish', item });
      return;
    }
    startAction();
    setBusyId(item.id);
    try {
      upsert((await setLibraryStatus(type, item.id, { version: item.version, status })) as AnyItem);
      setNotice(t('planLibrary.statusChanged'));
    } catch (err) {
      setActionError(labels.errorText(toLibraryError(err)));
    } finally {
      setBusyId(null);
    }
  };

  const publish = async (
    item: AnyItem,
    reviewer: { reviewedByLabel: string; reviewedOn: string },
  ) => {
    const saved = await setLibraryStatus(type, item.id, {
      version: item.version,
      status: 'published',
      ...reviewer,
    });
    upsert(saved as AnyItem);
    setOverlay(null);
    setNotice(t('planLibrary.statusChanged'));
  };

  const updatedCell = (item: AnyItem) => (
    <>
      {canEdit && <span>{item.updatedByName ?? t('planLibrary.seedImport')}</span>}
      <time dateTime={item.updatedAt}>{labels.formatTime(item.updatedAt)}</time>
    </>
  );

  return (
    <section className={styles.page} aria-labelledby="plan-library-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('planLibrary.disclaimer')}</span>
      </p>

      <div className={styles.titleRow}>
        <div>
          <h1 id="plan-library-title" className={styles.title}>
            {t('planLibrary.title')}
          </h1>
          <p className={styles.subtitle}>
            {canEdit ? t('planLibrary.editHint') : t('planLibrary.readOnlyHint')}
          </p>
        </div>
        {canEdit && (
          <div className={styles.toolbar}>
            <Button
              variant="primary"
              icon={<Plus size={16} aria-hidden />}
              onClick={() => {
                startAction();
                setOverlay({ kind: 'create' });
              }}
            >
              {t('planLibrary.add')}
            </Button>
          </div>
        )}
      </div>

      <div className={own.tabs} role="tablist" aria-label={t('planLibrary.tabsLabel')}>
        {LIBRARY_ITEM_TYPES.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            className={own.tab}
            aria-selected={x === type}
            onClick={() => switchType(x)}
          >
            {t(`planLibrary.tabs.${x}`)}
          </button>
        ))}
      </div>

      <div className={own.filters}>
        <div className={styles.field}>
          <label htmlFor={`${id}-q`}>{t('planLibrary.search')}</label>
          <input
            id={`${id}-q`}
            type="search"
            value={query}
            maxLength={40}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {canEdit && (
          <div className={styles.field}>
            <label htmlFor={`${id}-status`}>{t('planLibrary.statusFilter')}</label>
            <select
              id={`${id}-status`}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as LibraryItemStatus | '')}
            >
              <option value="">{t('planLibrary.allStatuses')}</option>
              {LIBRARY_ITEM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`planLibrary.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
        )}
        {list.status === 'ready' && (
          <p className={own.count}>{t('planLibrary.count', { count: visible.length })}</p>
        )}
      </div>

      {actionError && (
        <div className={styles.error} role="alert">
          <ul className={own.issues}>
            {actionError.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {list.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('planLibrary.loading')}
        </p>
      )}
      {list.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('planLibrary.loadFailed')}</span>
          <Button variant="ghost" onClick={() => setReloadKey((v) => v + 1)}>
            {t('planLibrary.retry')}
          </Button>
        </div>
      )}
      {list.status === 'ready' && visible.length === 0 && (
        <p className={styles.muted}>{t('planLibrary.empty')}</p>
      )}
      {list.status === 'ready' && visible.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('planLibrary.columns.name')}</th>
              <th scope="col">{t('planLibrary.columns.kind')}</th>
              <th scope="col">{t('planLibrary.columns.status')}</th>
              <th scope="col">{t('planLibrary.columns.version')}</th>
              <th scope="col">{t('planLibrary.columns.updated')}</th>
              <th scope="col">{t('planLibrary.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const name = itemName(item);
              return (
                <tr
                  key={item.id}
                  className={item.status === 'retired' ? styles.disabledRow : undefined}
                >
                  <th scope="row" data-label={t('planLibrary.columns.name')}>
                    {name}
                  </th>
                  <td data-label={t('planLibrary.columns.kind')}>{labels.kind(type, item)}</td>
                  <td data-label={t('planLibrary.columns.status')}>
                    <span
                      className={`${own.status} ${item.status === 'draft' ? '' : own[item.status]}`}
                    >
                      {t(`planLibrary.status.${item.status}`)}
                    </span>
                  </td>
                  <td data-label={t('planLibrary.columns.version')} className={styles.value}>
                    {t('planLibrary.versionValue', { version: item.version })}
                  </td>
                  <td data-label={t('planLibrary.columns.updated')} className={styles.updated}>
                    {updatedCell(item)}
                  </td>
                  <td data-label={t('planLibrary.columns.actions')}>
                    <div className={own.rowActions}>
                      <Button
                        variant="ghost"
                        aria-label={t('planLibrary.actions.viewItem', { name })}
                        onClick={() => setOverlay({ kind: 'view', item })}
                      >
                        {t('planLibrary.actions.view')}
                      </Button>
                      {canEdit && item.status === 'draft' && (
                        <Button
                          variant="ghost"
                          aria-label={t('planLibrary.actions.editItem', { name })}
                          onClick={() => {
                            startAction();
                            setOverlay({ kind: 'edit', item });
                          }}
                        >
                          {t('planLibrary.actions.edit')}
                        </Button>
                      )}
                      {canEdit &&
                        LIBRARY_STATUS_TRANSITIONS[item.status].map((next) => {
                          const action = t(`planLibrary.actions.${TRANSITION_ACTION[next]}`);
                          return (
                            <Button
                              key={next}
                              variant="ghost"
                              disabled={busyId === item.id}
                              aria-label={t('planLibrary.actions.statusItem', { action, name })}
                              onClick={() => void transition(item, next)}
                            >
                              {action}
                            </Button>
                          );
                        })}
                      {canEdit && (
                        <Button
                          variant="ghost"
                          aria-label={t('planLibrary.actions.historyItem', { name })}
                          onClick={() => setOverlay({ kind: 'history', item })}
                        >
                          {t('planLibrary.actions.history')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {overlay?.kind === 'view' && (
        <LibraryItemView type={type} item={overlay.item} onClose={() => setOverlay(null)} />
      )}
      {canEdit && overlay?.kind === 'history' && (
        <LibraryHistory type={type} item={overlay.item} onClose={() => setOverlay(null)} />
      )}
      {canEdit && overlay?.kind === 'publish' && (
        <PublishDialog
          item={overlay.item}
          onSubmit={(reviewer) => publish(overlay.item, reviewer)}
          onCancel={() => setOverlay(null)}
        />
      )}
      {canEdit && (overlay?.kind === 'create' || overlay?.kind === 'edit') && (
        <LibraryItemForm
          key={`${type}-${overlay.kind === 'edit' ? overlay.item.id : 'new'}`}
          type={type}
          {...(overlay.kind === 'edit'
            ? { initial: overlay.item as LibraryItemByType[LibraryItemType] }
            : {})}
          onSubmit={save}
          onCancel={() => setOverlay(null)}
        />
      )}
    </section>
  );
}
