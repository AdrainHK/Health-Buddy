import {
  COMPANION_SCRIPT_KINDS,
  companionScriptMax,
  type CompanionScript,
  type CompanionScriptKind,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { History, Info, Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listCompanionScripts,
  listCompanionScriptVersions,
  saveCompanionScript,
} from '../api/companion';
import { ApiError } from '../api/http';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import own from './Companion.module.css';

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; scripts: Map<CompanionScriptKind, CompanionScript> };

/** 保存检查不通过时后端标出的类别（packages/skills checkCompanionScript） */
const ISSUE_CATEGORIES = [
  'banned_term',
  'presumed_disease',
  'judgment',
  'drug_name',
  'drug_advice',
  'efficacy_claim',
  'twin_term',
  'reassurance',
  'manager_promise',
  'hospital',
  'expert',
  'missing_required',
  'placeholder',
] as const;
type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

interface Issue {
  category: IssueCategory | 'other';
  term: string;
}

function contentIssues(err: unknown): Issue[] | null {
  if (!(err instanceof ApiError) || err.code !== 'invalid_content') return null;
  const raw = Array.isArray(err.details.issues) ? (err.details.issues as unknown[]) : [];
  return raw.map((i) => {
    const o = (i ?? {}) as { category?: unknown; term?: unknown };
    const category = (ISSUE_CATEGORIES as readonly unknown[]).includes(o.category)
      ? (o.category as IssueCategory)
      : 'other';
    return { category, term: typeof o.term === 'string' ? o.term : '' };
  });
}

/**
 * 伴侣“福宝”的固定话术和线下告知书模板（M6 规格 2.10、Q22、N4）。只有平台管理员。
 * 话术不经模型生成，念给所有客户听：保存时后端按念给客户听的标准检查，每次保存是一个新版本，
 * 新会话生效。内容待产品负责人和医学、心理顾问审定；告知书正文由法务和产品负责人提供。
 */
export function CompanionScriptsPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<CompanionScriptKind | null>(null);
  const [history, setHistory] = useState<CompanionScriptKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCompanionScripts()
      .then(
        (scripts) =>
          !cancelled &&
          setState({ status: 'ready', scripts: new Map(scripts.map((s) => [s.kind, s])) }),
      )
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className={styles.page} aria-labelledby="companion-scripts-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('companionScripts.disclaimer')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="companion-scripts-title" className={styles.title}>
            {t('companionScripts.title')}
          </h1>
          <p className={styles.subtitle}>{t('companionScripts.subtitle')}</p>
        </div>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('companionScripts.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('companionScripts.loadFailed')}</span>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t('companionScripts.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('companionScripts.columns.kind')}</th>
              <th scope="col">{t('companionScripts.columns.text')}</th>
              <th scope="col">{t('companionScripts.columns.version')}</th>
              <th scope="col">{t('companionScripts.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {COMPANION_SCRIPT_KINDS.map((kind) => {
              const script = state.scripts.get(kind);
              return (
                <tr key={kind}>
                  <th scope="row" data-label={t('companionScripts.columns.kind')}>
                    {t(`companionScripts.kinds.${kind}`)}
                  </th>
                  <td data-label={t('companionScripts.columns.text')}>
                    {script ? (
                      <span className={kind === 'notice' ? own.clamped : own.scriptText}>
                        {script.text}
                      </span>
                    ) : (
                      <span className={styles.muted}>{t('companionScripts.none')}</span>
                    )}
                  </td>
                  <td data-label={t('companionScripts.columns.version')}>
                    {script
                      ? t('companionScripts.versionValue', {
                          version: script.version,
                          date: script.updatedAt.slice(0, 10),
                        })
                      : '—'}
                  </td>
                  <td data-label={t('companionScripts.columns.actions')}>
                    <div className={styles.rowActions}>
                      <Button
                        icon={<Pencil size={14} aria-hidden />}
                        aria-label={t('companionScripts.editOf', {
                          kind: t(`companionScripts.kinds.${kind}`),
                        })}
                        onClick={() => {
                          setNotice(null);
                          setEditing(kind);
                        }}
                      >
                        {t('companionScripts.edit')}
                      </Button>
                      {script && (
                        <Button
                          variant="ghost"
                          icon={<History size={14} aria-hidden />}
                          aria-label={t('companionScripts.historyOf', {
                            kind: t(`companionScripts.kinds.${kind}`),
                          })}
                          onClick={() => setHistory(kind)}
                        >
                          {t('companionScripts.history')}
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
      {editing && state.status === 'ready' && (
        <EditDialog
          kind={editing}
          current={state.scripts.get(editing) ?? null}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            const scripts = new Map(state.scripts);
            scripts.set(saved.kind, saved);
            setState({ status: 'ready', scripts });
            setEditing(null);
            setNotice(t('companionScripts.saved', { version: saved.version }));
          }}
        />
      )}
      {history && <HistoryDialog kind={history} onClose={() => setHistory(null)} />}
    </section>
  );
}

function EditDialog({
  kind,
  current,
  onClose,
  onSaved,
}: {
  kind: CompanionScriptKind;
  current: CompanionScript | null;
  onClose: () => void;
  onSaved: (s: CompanionScript) => void;
}) {
  const { t } = useTranslation();
  const max = companionScriptMax(kind);
  const [text, setText] = useState(current?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const trimmed = text.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed.length > max) {
      setError(t('companionScripts.errors.length', { max }));
      return;
    }
    setBusy(true);
    setError(null);
    setIssues([]);
    saveCompanionScript(kind, trimmed)
      .then(onSaved)
      .catch((err: unknown) => {
        const found = contentIssues(err);
        if (found) {
          setIssues(found);
          setError(t('companionScripts.errors.invalidContent'));
        } else if (err instanceof ApiError && err.code === 'forbidden') {
          setError(t('companionScripts.errors.forbidden'));
        } else {
          setError(t('companionScripts.errors.unknown'));
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      title={t('companionScripts.editTitle', { kind: t(`companionScripts.kinds.${kind}`) })}
      onClose={onClose}
      wide={kind === 'notice'}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <p className={styles.hint}>{t(`companionScripts.hints.${kind}`)}</p>
        <label className={styles.field}>
          {t('companionScripts.textLabel')}
          <textarea
            className={kind === 'notice' ? own.noticeArea : own.scriptArea}
            value={text}
            maxLength={max}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p className={styles.hint}>{t('companionScripts.count', { count: trimmed.length, max })}</p>
        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            {issues.length > 0 && (
              <ul className={own.issues}>
                {issues.map((i, n) => (
                  <li key={n}>
                    {t(`companionScripts.issues.${i.category}`)}
                    {i.term ? `：${i.term}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className={styles.dialogActions}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('companionScripts.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t('companionScripts.saving') : t('companionScripts.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HistoryDialog({ kind, onClose }: { kind: CompanionScriptKind; onClose: () => void }) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<CompanionScript[] | 'error' | null>(null);
  useEffect(() => {
    let cancelled = false;
    listCompanionScriptVersions(kind)
      .then((v) => !cancelled && setVersions(v))
      .catch(() => !cancelled && setVersions('error'));
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return (
    <Dialog
      title={t('companionScripts.historyTitle', { kind: t(`companionScripts.kinds.${kind}`) })}
      onClose={onClose}
      wide
    >
      {versions === null && (
        <p className={styles.muted} role="status">
          {t('companionScripts.loading')}
        </p>
      )}
      {versions === 'error' && (
        <p className={styles.error} role="alert">
          {t('companionScripts.loadFailed')}
        </p>
      )}
      {Array.isArray(versions) && (
        <ol className={own.versions}>
          {versions.map((v) => (
            <li key={v.version}>
              <strong>
                {t('companionScripts.versionValue', {
                  version: v.version,
                  date: v.updatedAt.slice(0, 10),
                })}
              </strong>
              <span className={own.scriptText}>{v.text}</span>
            </li>
          ))}
        </ol>
      )}
      <div className={styles.dialogActions}>
        <Button onClick={onClose}>{t('companionScripts.close')}</Button>
      </div>
    </Dialog>
  );
}
