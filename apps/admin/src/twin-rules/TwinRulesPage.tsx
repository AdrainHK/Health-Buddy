import type { CurrentUser, TwinStatusRuleRecord } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createTwinRule, listTwinRules, resetTwinRules, updateTwinRule } from '../api/twinRules';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import { sortTwinRules, toTwinRuleError, useTwinRuleLabels } from './labels';
import { TwinRuleForm, type TwinRuleFormValues } from './TwinRuleForm';
import own from './TwinRules.module.css';

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; version: number; items: TwinStatusRuleRecord[] };

type Editor = { mode: 'create' } | { mode: 'edit'; rule: TwinStatusRuleRecord } | null;

/**
 * 孪生状态规则（M4 规格 2.10，Q1）。全平台一套：平台管理员可以新增、修改、停用、恢复默认值；
 * 协会和机构管理员只读。修改后所有客户在后台按新规则重算（不生成跟进项）。
 * 界面只决定显示哪些按钮，真正的权限在后端（其他角色写接口返回 403）和行级安全。
 */
export function TwinRulesPage({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const labels = useTwinRuleLabels();
  const canEdit = user.role === 'platform_admin';

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<Editor>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTwinRules()
      .then(
        (res) =>
          !cancelled &&
          setList({ status: 'ready', version: res.version, items: sortTwinRules(res.rules) }),
      )
      .catch(() => !cancelled && setList({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = () => {
    setList({ status: 'loading' });
    setReloadKey((v) => v + 1);
  };

  /** 每次修改规则版本加一（以后端为准；这里先在界面上加一，刷新后对齐） */
  const upsert = useCallback((saved: TwinStatusRuleRecord) => {
    setList((current) => {
      if (current.status !== 'ready') return current;
      const others = current.items.filter((x) => x.id !== saved.id);
      return {
        status: 'ready',
        version: current.version + 1,
        items: sortTwinRules([...others, saved]),
      };
    });
  }, []);

  const startAction = () => {
    setActionError(null);
    setNotice(null);
  };

  const save = async (values: TwinRuleFormValues) => {
    const saved =
      editor?.mode === 'edit'
        ? await updateTwinRule(editor.rule.id, {
            ...(values.method === 'threshold'
              ? { comparator: values.comparator, value: values.value }
              : {}),
            ...(values.source !== 'report' ? { windowDays: values.windowDays } : {}),
            ...(values.method === 'observation_count' ? { minCount: values.minCount } : {}),
            level: values.level,
            enabled: values.enabled,
          })
        : await createTwinRule(values);
    upsert(saved);
    setEditor(null);
    setNotice(t('twinRules.saved'));
  };

  const toggle = async (item: TwinStatusRuleRecord) => {
    startAction();
    setBusyId(item.id);
    try {
      upsert(await updateTwinRule(item.id, { enabled: !item.enabled }));
      setNotice(t('twinRules.saved'));
    } catch (err) {
      setActionError(labels.errorText(toTwinRuleError(err, false)));
    } finally {
      setBusyId(null);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      const res = await resetTwinRules();
      setList({ status: 'ready', version: res.version, items: sortTwinRules(res.rules) });
      setConfirmingReset(false);
      setNotice(t('twinRules.resetDone'));
    } catch (err) {
      setConfirmingReset(false);
      setActionError(labels.errorText(toTwinRuleError(err, false)));
    } finally {
      setResetting(false);
    }
  };

  const updatedByLabel = (item: TwinStatusRuleRecord) => {
    if (item.updatedBy === null) return t('twinRules.updatedBy.system');
    // 只有平台管理员能改规则；接口只给出修改人 id，不暴露姓名
    if (item.updatedBy === user.id) return t('twinRules.updatedBy.self');
    return t('twinRules.updatedBy.platform');
  };

  const ruleName = (item: TwinStatusRuleRecord) => ({
    domain: labels.domainName(item.domain),
    metric: labels.ruleSubject(item),
    source: labels.sourceName(item.source),
    method: labels.methodName(item.method),
  });

  return (
    <section className={styles.page} aria-labelledby="twin-rules-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('twinRules.disclaimer')}</span>
      </p>

      <div className={styles.titleRow}>
        <div>
          <h1 id="twin-rules-title" className={styles.title}>
            {t('twinRules.title')}
          </h1>
          <p className={styles.subtitle}>
            {canEdit ? t('twinRules.editHint') : t('twinRules.readOnlyHint')}
          </p>
          {list.status === 'ready' && (
            <p className={own.version}>{t('twinRules.version', { version: list.version })}</p>
          )}
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
              {t('twinRules.reset')}
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={16} aria-hidden />}
              onClick={() => {
                startAction();
                setEditor({ mode: 'create' });
              }}
            >
              {t('twinRules.add')}
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
          {t('twinRules.loading')}
        </p>
      )}
      {list.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('twinRules.loadFailed')}</span>
          <Button variant="ghost" onClick={reload}>
            {t('twinRules.retry')}
          </Button>
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <p className={styles.muted}>{t('twinRules.empty')}</p>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('twinRules.columns.domain')}</th>
              <th scope="col">{t('twinRules.columns.metric')}</th>
              <th scope="col">{t('twinRules.columns.source')}</th>
              <th scope="col">{t('twinRules.columns.method')}</th>
              <th scope="col">{t('twinRules.columns.threshold')}</th>
              <th scope="col">{t('twinRules.columns.level')}</th>
              <th scope="col">{t('twinRules.columns.enabled')}</th>
              <th scope="col">{t('twinRules.columns.updated')}</th>
              {canEdit && <th scope="col">{t('twinRules.columns.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {list.items.map((item) => {
              const name = ruleName(item);
              return (
                <tr key={item.id} className={item.enabled ? undefined : styles.disabledRow}>
                  <td data-label={t('twinRules.columns.domain')}>{name.domain}</td>
                  <th scope="row" data-label={t('twinRules.columns.metric')}>
                    {name.metric}
                  </th>
                  <td data-label={t('twinRules.columns.source')}>{name.source}</td>
                  <td data-label={t('twinRules.columns.method')}>
                    <span>{name.method}</span>
                    {item.windowDays !== null && (
                      <span className={own.window}>
                        {t('twinRules.window', { days: item.windowDays })}
                      </span>
                    )}
                  </td>
                  <td data-label={t('twinRules.columns.threshold')} className={styles.value}>
                    {item.method === 'observation_count' && item.category && item.minCount ? (
                      <>
                        <span>
                          {t('twinRules.observationRule', {
                            days: item.windowDays,
                            category: labels.categoryName(item.category),
                            count: item.minCount,
                          })}
                        </span>
                        <small className={own.window}>{t('twinRules.observationPending')}</small>
                      </>
                    ) : item.comparator !== null && item.value !== null && item.metric ? (
                      `${labels.symbol(item.comparator)} ${item.value} ${labels.unitLabel(item.metric)}`
                    ) : (
                      t('twinRules.noThreshold')
                    )}
                  </td>
                  <td data-label={t('twinRules.columns.level')}>
                    <span className={`${styles.level} ${own[item.level]}`}>
                      {labels.levelName(item.level)}
                    </span>
                  </td>
                  <td data-label={t('twinRules.columns.enabled')}>
                    {item.enabled ? t('twinRules.status.enabled') : t('twinRules.status.disabled')}
                  </td>
                  <td data-label={t('twinRules.columns.updated')} className={styles.updated}>
                    <span>{updatedByLabel(item)}</span>
                    <time dateTime={item.updatedAt}>{labels.formatTime(item.updatedAt)}</time>
                  </td>
                  {canEdit && (
                    <td data-label={t('twinRules.columns.actions')}>
                      <div className={styles.rowActions}>
                        <Button
                          variant="ghost"
                          aria-label={t('twinRules.actions.editRule', name)}
                          onClick={() => {
                            startAction();
                            setEditor({ mode: 'edit', rule: item });
                          }}
                        >
                          {t('twinRules.actions.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busyId === item.id}
                          aria-label={t(
                            item.enabled
                              ? 'twinRules.actions.disableRule'
                              : 'twinRules.actions.enableRule',
                            name,
                          )}
                          onClick={() => void toggle(item)}
                        >
                          {item.enabled
                            ? t('twinRules.actions.disable')
                            : t('twinRules.actions.enable')}
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
        <TwinRuleForm
          {...(editor.mode === 'edit' ? { initial: editor.rule } : {})}
          onSubmit={save}
          onCancel={() => setEditor(null)}
        />
      )}

      {canEdit && confirmingReset && (
        <Dialog
          title={t('twinRules.resetConfirm.title')}
          onClose={() => !resetting && setConfirmingReset(false)}
        >
          <p className={styles.dialogBody}>{t('twinRules.resetConfirm.body')}</p>
          <div className={styles.dialogActions}>
            <Button autoFocus disabled={resetting} onClick={() => setConfirmingReset(false)}>
              {t('twinRules.resetConfirm.cancel')}
            </Button>
            <Button variant="primary" disabled={resetting} onClick={() => void reset()}>
              {resetting
                ? t('twinRules.resetConfirm.working')
                : t('twinRules.resetConfirm.confirm')}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
