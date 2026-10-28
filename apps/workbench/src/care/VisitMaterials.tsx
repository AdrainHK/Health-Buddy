import {
  CHAT_SCREENSHOT_LIMITS,
  CHAT_TRANSCRIPTION_FAILURES,
  VISIT_MATERIAL_CONSENT_REQUIRED,
  VISIT_MATERIAL_TEXT_MAX,
  VISIT_MATERIALS_PER_RECORD_MAX,
  type ChatTranscriptionFailure,
  type Visit,
  type VisitMaterial,
  type VisitMaterialSource,
} from '@health-buddy/shared';
import { Button, IconButton } from '@health-buddy/ui';
import { MessageSquareText, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createVisitMaterial,
  deleteVisitMaterial,
  listVisitMaterials,
  listVisits,
  transcribeScreenshots,
} from '../api/care';
import { ApiError, isAbortError } from '../api/http';
import styles from '../twin/Twin.module.css';
import care from './Care.module.css';
import { localToday } from './dates';

/** 只读本地的 .txt 文件，内容在浏览器里读出后作为文字上传（Q21），后端不解析文件 */
const TXT_ACCEPT = '.txt,text/plain';
/** 聊天截图：只收图片（后端按文件头再判断一次），原图不保存 */
const SCREENSHOT_ACCEPT = 'image/png,image/jpeg,image/heic,.heic';

type ScreenshotError =
  | ChatTranscriptionFailure
  | 'tooMany'
  | 'tooLarge'
  | 'unsupported'
  | 'notConfigured'
  | 'notFound'
  | 'busy';

function screenshotError(err: unknown): ScreenshotError | 'consent' {
  if (!(err instanceof ApiError)) return 'error';
  if (err.code === 'transcription_failed') {
    const reason = err.reasons.find((r): r is ChatTranscriptionFailure =>
      (CHAT_TRANSCRIPTION_FAILURES as readonly string[]).includes(r),
    );
    return reason ?? 'error';
  }
  if (err.status === 400 && err.reasons.includes(VISIT_MATERIAL_CONSENT_REQUIRED)) return 'consent';
  if (err.status === 413) return err.reasons.includes('too_many_files') ? 'tooMany' : 'tooLarge';
  if (err.status === 415) return 'unsupported';
  if (err.status === 429) return 'busy';
  if (err.code === 'not_configured') return 'notConfigured';
  if (err.status === 404) return 'notFound';
  return 'error';
}

export interface VisitMaterialsProps {
  clientId: string;
  readOnly: boolean;
  /** 上传表单是否打开（输入框里点了“上传随访素材”） */
  uploading: boolean;
  onCloseUpload: () => void;
  /**
   * /随访记录（2.9）：卡片上可以勾选要整理的素材（最多 3 份）。onSelect 带上第一份勾选的素材关联的随访，
   * 记录确认时把那一次随访标为已完成
   */
  selectable?: boolean;
  selected?: readonly string[];
  onSelect?: (ids: string[], visitId: string | null) => void;
}

interface State {
  materials: VisitMaterial[];
  consentRecorded: boolean;
  visits: Visit[];
}

/**
 * 对话区里的随访素材（M5 规格 2.9）：还没整理成记录的素材显示为卡片（日期、字数、关联的随访），
 * 可以删除；上传表单接受粘贴的文字或 .txt 文件，第一次为这位客户上传时必须勾选“已告知客户”。
 * 原文只上传，不在界面上回显，也不进日志和埋点。
 */
export function VisitMaterials({
  clientId,
  readOnly,
  uploading,
  onCloseUpload,
  selectable = false,
  selected = [],
  onSelect,
}: VisitMaterialsProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(null);
  const [version, setVersion] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      listVisitMaterials(clientId, controller.signal),
      listVisits({ clientId }, controller.signal).catch((err: unknown) => {
        if (isAbortError(err)) throw err;
        return [] as Visit[];
      }),
    ])
      .then(([list, visits]) =>
        setState({
          materials: list.materials,
          consentRecorded: list.consentRecorded,
          visits: visits.filter((v) => v.status === 'planned' || v.status === 'missed'),
        }),
      )
      .catch((err: unknown) => {
        if (!isAbortError(err)) setState({ materials: [], consentRecorded: false, visits: [] });
      });
    return () => controller.abort();
  }, [clientId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const visitDate = new Map(state?.visits.map((v) => [v.id, v.dueDate]) ?? []);
  const usable = (state?.materials ?? []).filter((m) => !m.purged && !m.consumedArtifactId);

  const toggle = (m: VisitMaterial, on: boolean) => {
    const ids = on ? [...selected, m.id] : selected.filter((id) => id !== m.id);
    const first = usable.find((x) => x.id === ids[0]);
    onSelect?.(ids.slice(0, VISIT_MATERIALS_PER_RECORD_MAX), first?.visitId ?? null);
  };

  const remove = (m: VisitMaterial) => {
    setDeleting(m.id);
    setError(null);
    deleteVisitMaterial(m.id)
      .then(reload)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) reload();
        else setError(t('care.materials.deleteFailed'));
      })
      .finally(() => setDeleting(null));
  };

  if (!uploading && usable.length === 0 && !error) return null;
  return (
    <div className={care.materials}>
      {usable.length > 0 && (
        <ul className={care.materialList} aria-label={t('care.materials.list')}>
          {usable.map((m) => (
            <li key={m.id} className={care.materialCard}>
              {selectable && !readOnly && (
                <input
                  type="checkbox"
                  aria-label={t('care.materials.select', { date: m.createdAt.slice(0, 10) })}
                  checked={selected.includes(m.id)}
                  disabled={
                    !selected.includes(m.id) && selected.length >= VISIT_MATERIALS_PER_RECORD_MAX
                  }
                  onChange={(e) => toggle(m, e.target.checked)}
                />
              )}
              <MessageSquareText size={16} aria-hidden />
              <span className={care.materialText}>
                {t('care.materials.card', {
                  date: m.createdAt.slice(0, 10),
                  count: m.charCount,
                })}
                {m.visitId && visitDate.get(m.visitId) && (
                  <span className={styles.muted}>
                    {' '}
                    {t('care.materials.linked', { date: visitDate.get(m.visitId) })}
                  </span>
                )}
              </span>
              {!readOnly && (
                <IconButton
                  size="small"
                  label={t('care.materials.delete', { date: m.createdAt.slice(0, 10) })}
                  icon={<X size={14} />}
                  disabled={deleting === m.id}
                  onClick={() => remove(m)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {selectable && usable.length > 0 && !readOnly && (
        <p className={styles.muted}>{t('care.materials.selectHint')}</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {uploading && state && !readOnly && (
        <UploadForm
          clientId={clientId}
          consentRecorded={state.consentRecorded}
          visits={state.visits}
          onCancel={onCloseUpload}
          onUploaded={() => {
            onCloseUpload();
            reload();
          }}
        />
      )}
    </div>
  );
}

/** 读出文本文件的内容（UTF-8） */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

type UploadError = 'tooLong' | 'consent' | 'dailyLimit' | 'notConfigured' | 'notFound' | 'failed';

function uploadError(err: unknown): UploadError {
  if (!(err instanceof ApiError)) return 'failed';
  if (err.status === 413) return 'tooLong';
  if (err.status === 400 && err.reasons.includes(VISIT_MATERIAL_CONSENT_REQUIRED)) return 'consent';
  if (err.status === 429) return 'dailyLimit';
  if (err.code === 'not_configured') return 'notConfigured';
  if (err.status === 404) return 'notFound';
  return 'failed';
}

function UploadForm({
  clientId,
  consentRecorded,
  visits,
  onCancel,
  onUploaded,
}: {
  clientId: string;
  consentRecorded: boolean;
  visits: Visit[];
  onCancel: () => void;
  onUploaded: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const shotRef = useRef<HTMLInputElement>(null);
  const today = localToday();
  const [text, setText] = useState('');
  const [source, setSource] = useState<VisitMaterialSource>('paste');
  const [transcribing, setTranscribing] = useState<number | null>(null);
  const [shotError, setShotError] = useState<ScreenshotError | null>(null);
  // 默认关联今天到期的那次随访（2.9）
  const [visitId, setVisitId] = useState(() => visits.find((v) => v.dueDate === today)?.id ?? '');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UploadError | 'fileFailed' | null>(null);
  const [needConsent, setNeedConsent] = useState(!consentRecorded);

  const length = text.trim().length;
  const problem =
    length === 0
      ? 'empty'
      : length > VISIT_MATERIAL_TEXT_MAX
        ? 'tooLong'
        : needConsent && !consent
          ? 'consent'
          : null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      setText(await readText(file));
      setSource('txt');
    } catch {
      setError('fileFailed');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 截图先转写成文字，填进文本框给健管师核对；第一次为这位客户上传时转写前就要勾选“已告知客户”
  const onScreenshots = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (shotRef.current) shotRef.current.value = '';
    if (!files.length) return;
    setError(null);
    setShotError(null);
    if (files.length > CHAT_SCREENSHOT_LIMITS.maxFiles) {
      setShotError('tooMany');
      return;
    }
    if (files.some((f) => f.size > CHAT_SCREENSHOT_LIMITS.maxFileBytes)) {
      setShotError('tooLarge');
      return;
    }
    if (needConsent && !consent) {
      setError('consent');
      return;
    }
    setTranscribing(files.length);
    try {
      setText(await transcribeScreenshots(clientId, files, needConsent && consent));
      setSource('screenshot');
    } catch (err) {
      const key = screenshotError(err);
      if (key === 'consent') {
        setNeedConsent(true);
        setError('consent');
      } else setShotError(key);
    } finally {
      setTranscribing(null);
    }
  };

  const working = busy || transcribing !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    createVisitMaterial(clientId, {
      text: text.trim(),
      source,
      ...(visitId ? { visitId } : {}),
      ...(needConsent ? { consentConfirmed: consent } : {}),
    })
      .then(() => {
        setText('');
        onUploaded();
      })
      .catch((err: unknown) => {
        const key = uploadError(err);
        if (key === 'consent') setNeedConsent(true);
        setError(key);
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-labelledby={`${formId}-title`}>
      <p id={`${formId}-title`} className={styles.sectionTitle}>
        {t('care.materials.title')}
      </p>
      <p className={styles.muted}>{t('care.materials.note')}</p>
      <label className={styles.label}>
        {t('care.materials.textLabel', { max: VISIT_MATERIAL_TEXT_MAX })}
        <textarea
          className={styles.textarea}
          value={text}
          rows={6}
          disabled={working}
          aria-invalid={
            touched && (problem === 'empty' || problem === 'tooLong') ? true : undefined
          }
          onChange={(e) => {
            setText(e.target.value);
            // 截图转写的文字核对、修改后仍记为截图；改过的 .txt 内容记为粘贴
            setSource((s) => (s === 'screenshot' ? s : 'paste'));
          }}
        />
      </label>
      <p className={styles.muted} role="status">
        {transcribing !== null
          ? t('care.materials.transcribing', { count: transcribing })
          : t('care.materials.count', { count: length, max: VISIT_MATERIAL_TEXT_MAX })}
      </p>
      {source === 'screenshot' && transcribing === null && (
        <p className={styles.muted}>{t('care.materials.reviewTranscript')}</p>
      )}
      {shotError && (
        <p className={styles.error} role="alert">
          {t(`care.materials.screenshotErrors.${shotError}`, {
            max: CHAT_SCREENSHOT_LIMITS.maxFiles,
          })}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="button" disabled={working} onClick={() => fileRef.current?.click()}>
          {t('care.materials.chooseTxt')}
        </Button>
        <Button type="button" disabled={working} onClick={() => shotRef.current?.click()}>
          {t('care.materials.chooseScreenshots', { max: CHAT_SCREENSHOT_LIMITS.maxFiles })}
        </Button>
        <input
          ref={shotRef}
          type="file"
          hidden
          multiple
          accept={SCREENSHOT_ACCEPT}
          aria-label={t('care.materials.chooseScreenshots', {
            max: CHAT_SCREENSHOT_LIMITS.maxFiles,
          })}
          data-testid="material-screenshot-input"
          onChange={(e) => void onScreenshots(e.target.files)}
        />
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={TXT_ACCEPT}
          aria-label={t('care.materials.chooseTxt')}
          data-testid="material-file-input"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      <label className={styles.label}>
        {t('care.materials.visit')}
        <select
          className={styles.select}
          value={visitId}
          disabled={working}
          onChange={(e) => setVisitId(e.target.value)}
        >
          <option value="">{t('care.materials.noVisit')}</option>
          {visits.map((v) => (
            <option key={v.id} value={v.id}>
              {t('care.visits.line', {
                date: v.dueDate,
                purpose: t(`care.visits.purposes.${v.purpose}`),
                method: t(`care.visits.methods.${v.method}`),
              })}
            </option>
          ))}
        </select>
      </label>
      {needConsent && (
        <label className={styles.choice}>
          <input
            type="checkbox"
            checked={consent}
            disabled={working}
            aria-invalid={touched && !consent ? true : undefined}
            onChange={(e) => setConsent(e.target.checked)}
          />
          {t('care.materials.consent')}
        </label>
      )}
      {touched && problem && (
        <p className={styles.error} role="alert">
          {t(`care.materials.problems.${problem}`, { max: VISIT_MATERIAL_TEXT_MAX })}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {t(`care.materials.errors.${error}`, { max: VISIT_MATERIAL_TEXT_MAX })}
        </p>
      )}
      <div className={styles.cardActions}>
        <Button type="submit" variant="primary" disabled={working}>
          {busy ? t('care.materials.uploading') : t('care.materials.upload')}
        </Button>
        <Button type="button" variant="ghost" disabled={working} onClick={onCancel}>
          {t('care.materials.cancel')}
        </Button>
      </div>
    </form>
  );
}
