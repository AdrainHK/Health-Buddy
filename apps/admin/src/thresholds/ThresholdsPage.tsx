import type { CriticalThreshold, CurrentUser } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createThreshold,
  listThresholds,
  resetThresholds,
  updateThreshold,
} from '../api/thresholds';
import { Dialog } from './Dialog';
import { sortThresholds, toThresholdError, useThresholdLabels } from './labels';
import { ThresholdForm, type ThresholdFormValues } from './ThresholdForm';
import styles from './Thresholds.module.css';

type ListState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: CriticalThreshold[] };

type Editor = { mode: 'create' } | { mode: 'edit'; threshold: CriticalThreshold } | null;

/**
 * 危急指标设置（M1 规格第五节之二，Q12）。
 * 全平台一套阈值：平台管理员可以新增、修改、停用、恢复默认值；协会和机构管理员只读。
 * 界面只决定显示哪些按钮，真正的权限在后端（其他角色写接口返回 404）和行级安全。
 */
export function ThresholdsPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const labels = useThresholdLabels();
  const canEdit = user.role === 'platform_admin';

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<Editor>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listThresholds()
      .then((items) => !cancelled && setList({ status: 'ready', items: sortThresholds(items) }))
      .catch(() => !cancelled && setList({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const reload = () => {
    setList({ status: 'loading' });
    setVersion((v) => v + 1);
  };

  const upsert = useCallback((saved: CriticalThreshold) => {
    setList((current) => {
      if (current.status !== 'ready') return current;
      const others = current.items.filter((x) => x.id !== saved.id);
      return { status: 'ready', items: sortThresholds([...others, saved]) };
    });
  }, []);

  const startAction = () => {
    setActionError(null);
    setNotice(null);
  };

  const save = async (values: ThresholdFormValues) => {
    const saved =
      editor?.mode === 'edit'
        ? await updateThreshold(editor.threshold.id, {
            comparator: values.comparator,
            value: values.value,
            level: values.level,
            enabled: values.enabled,
          })
        : await createThreshold(values);
    upsert(saved);
    setEditor(null);
    setNotice(t('thresholds.saved'));
  };

  const toggle = async (item: CriticalThreshold) => {
    startAction();
    setBusyId(item.id);
    try {
      upsert(await updateThreshold(item.id, { enabled: !item.enabled }));
      setNotice(t('thresholds.saved'));
    } catch (err) {
      setActionError(labels.errorText(toThresholdError(err, true), item.metric));
    } finally {
      setBusyId(null);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      const items = await resetThresholds();
      setList({ status: 'ready', items: sortThresholds(items) });
      setConfirmingReset(false);
      setNotice(t('thresholds.resetDone'));
    } catch (err) {
      setConfirmingReset(false);
      setActionError(labels.errorText(toThresholdError(err, false)));
    } finally {
      setResetting(false);
    }
  };

  const updatedByLabel = (item: CriticalThreshold) => {
    if (item.updatedBy === null) return t('thresholds.updatedBy.system');
    // 只有平台管理员能改阈值；接口只给出修改人 id，不暴露姓名
    if (item.updatedBy === user.id) return t('thresholds.updatedBy.self');
    return t('thresholds.updatedBy.platform');
  };

  return (
    <section className={styles.page} aria-labelledby="thresholds-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('thresholds.disclaimer')}</span>
      </p>

      <div className={styles.titleRow}>
        <div>
          <h1 id="thresholds-title" className={styles.title}>
            {t('thresholds.title')}
          </h1>
          <p className={styles.subtitle}>
            {canEdit ? t('thresholds.editHint') : t('thresholds.readOnlyHint')}
          </p>
        </div>
        {canEdit && list.status === 'ready' && (
          <div className={styles.toolbar}>
            <Button
              icon={<RotateCcw size={16} aria-hidden />}
              onClick={() => {
                startAction();
                setConfirmingReset(true);
              }}
            >
              {t('thresholds.reset')}
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={16} aria-hidden />}
              onClick={() => {
                startAction();
                setEditor({ mode: 'create' });
              }}
            >
              {t('thresholds.add')}
            </Button>
          </div>
        )}
      </div>

      {actionError && (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {list.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('thresholds.loading')}
        </p>
      )}
      {list.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('thresholds.loadFailed')}</span>
          <Button variant="ghost" onClick={reload}>
            {t('thresholds.retry')}
          </Button>
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <p className={styles.muted}>{t('thresholds.empty')}</p>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('thresholds.columns.metric')}</th>
              <th scope="col">{t('thresholds.columns.direction')}</th>
              <th scope="col">{t('thresholds.columns.value')}</th>
              <th scope="col">{t('thresholds.columns.unit')}</th>
              <th scope="col">{t('thresholds.columns.level')}</th>
              <th scope="col">{t('thresholds.columns.enabled')}</th>
              <th scope="col">{t('thresholds.columns.updated')}</th>
              {canEdit && <th scope="col">{t('thresholds.columns.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {list.items.map((item) => {
              const metric = labels.metricName(item.metric);
              const direction = labels.direction(item.comparator);
              return (
                <tr key={item.id} className={item.enabled ? undefined : styles.disabledRow}>
                  <th scope="row" data-label={t('thresholds.columns.metric')}>
                    {metric}
                  </th>
                  <td data-label={t('thresholds.columns.direction')}>{direction}</td>
                  <td data-label={t('thresholds.columns.value')} className={styles.value}>
                    {`${labels.symbol(item.comparator)} ${item.value}`}
                  </td>
                  <td data-label={t('thresholds.columns.unit')}>{labels.unitLabel(item.metric)}</td>
                  <td data-label={t('thresholds.columns.level')}>
                    <span className={`${styles.level} ${styles[item.level]}`}>
                      {labels.levelName(item.level)}
                    </span>
                  </td>
                  <td data-label={t('thresholds.columns.enabled')}>
                    {item.enabled
                      ? t('thresholds.status.enabled')
                      : t('thresholds.status.disabled')}
                  </td>
                  <td data-label={t('thresholds.columns.updated')} className={styles.updated}>
                    <span>{updatedByLabel(item)}</span>
                    <time dateTime={item.updatedAt}>{labels.formatTime(item.updatedAt)}</time>
                  </td>
                  {canEdit && (
                    <td data-label={t('thresholds.columns.actions')}>
                      <div className={styles.rowActions}>
                        <Button
                          variant="ghost"
                          aria-label={t('thresholds.actions.editRule', { metric, direction })}
                          onClick={() => {
                            startAction();
                            setEditor({ mode: 'edit', threshold: item });
                          }}
                        >
                          {t('thresholds.actions.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busyId === item.id}
                          aria-label={t(
                            item.enabled
                              ? 'thresholds.actions.disableRule'
                              : 'thresholds.actions.enableRule',
                            { metric, direction },
                          )}
                          onClick={() => void toggle(item)}
                        >
                          {item.enabled
                            ? t('thresholds.actions.disable')
                            : t('thresholds.actions.enable')}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {canEdit && editor && (
        <ThresholdForm
          {...(editor.mode === 'edit' ? { initial: editor.threshold } : {})}
          onSubmit={save}
          onCancel={() => setEditor(null)}
        />
      )}

      {canEdit && confirmingReset && (
        <Dialog
          title={t('thresholds.resetConfirm.title')}
          onClose={() => !resetting && setConfirmingReset(false)}
        >
          <p className={styles.dialogBody}>{t('thresholds.resetConfirm.body')}</p>
          <div className={styles.dialogActions}>
            <Button autoFocus disabled={resetting} onClick={() => setConfirmingReset(false)}>
              {t('thresholds.resetConfirm.cancel')}
            </Button>
            <Button variant="primary" disabled={resetting} onClick={() => void reset()}>
              {resetting
                ? t('thresholds.resetConfirm.working')
                : t('thresholds.resetConfirm.confirm')}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
