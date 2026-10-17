import {
  REPORT_INDICATORS,
  type CriticalFlag,
  type ExtractedValue,
  type ReportUpload,
  type VerifyRejection,
} from '@health-buddy/shared';
import { Button, IconButton } from '@health-buddy/ui';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAbortError } from '../api/http';
import {
  addValue,
  discardUpload,
  fileContentUrl,
  getUpload,
  updateValue,
  VerifyRejectedError,
  verifyUpload,
} from '../api/reports';
import { useDynamicT } from '../i18n/dynamic';
import { uploadErrorKey } from './errors';
import styles from './Reports.module.css';
import { statusText } from './UploadCard';

export interface ReviewViewProps {
  uploadId: string;
  /** 识别记录有变化（确认、放弃、修改），列表和角标需要刷新 */
  onChanged?: () => void;
  onBack?: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';

interface RowDraft {
  rawName: string;
  /** 指标编码；null 表示作为未收录指标保存；AUTO 表示按名称自动对应 */
  code: string | null;
  rawValue: string;
  rawUnit: string;
  refText: string;
}

const UNMAPPED = '';
/** 按名称自动对应指标（补录的行、原来是未收录指标的行默认用它，验收反馈 7） */
const AUTO = '__auto';

function draftOf(v?: ExtractedValue): RowDraft {
  return {
    rawName: v?.rawName ?? '',
    code: v?.code ?? AUTO,
    rawValue: v?.rawValue ?? '',
    rawUnit: v?.rawUnit ?? '',
    refText: v?.refText ?? '',
  };
}

/**
 * 核对界面（规格 2.4）：上面是原件（逐页），下面是识别结果。
 * 需特别注意的行必须逐行勾选“已核对”（Q18）；同一日期已有报告时选择是否作为新报告保存（Q17）；
 * 命中危急指标时勾选“已知悉”。所有校验后端也做，前端只是提前提示。
 *
 * 产品负责人的两项决定（验收反馈）：
 * - 原件上方固定提醒“请确认报告上的姓名是本客户”，勾选后才能确认（人工看，系统不读取姓名）；
 * - “确认所有数据”一键把所有行记为已核对并确认，需特别注意的行和危急指标不再单独勾选。
 */
export function ReviewView({ uploadId, onChanged, onBack }: ReviewViewProps) {
  const { t } = useTranslation();
  const [upload, setUpload] = useState<ReportUpload | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [version, setVersion] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reportDate, setReportDate] = useState('');
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [ackCritical, setAckCritical] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  /** 刚确认的这份报告命中的危急指标：确认后醒目列出，提示先电话联系客户（不阻挡操作） */
  const [verifiedCritical, setVerifiedCritical] = useState<CriticalFlag[]>([]);
  const [rejection, setRejection] = useState<VerifyRejection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (upload?.id === uploadId ? s : 'loading'));
    getUpload(uploadId, controller.signal)
      .then((next) => {
        setUpload(next);
        setState('ready');
        setReportDate((d) => d || next.reportDate || '');
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setState('error');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- upload 只用来判断是否换了记录
  }, [uploadId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  if (state === 'error') {
    return (
      <div className={styles.review} role="alert">
        <p className={styles.error}>{t('reports.review.loadFailed')}</p>
        <div className={styles.actions}>
          <Button onClick={reload}>{t('reports.review.retry')}</Button>
          {onBack && (
            <Button variant="ghost" onClick={onBack}>
              {t('reports.review.back')}
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (!upload || upload.id !== uploadId) {
    return (
      <p className={styles.status} role="status">
        {t('reports.review.loading')}
      </p>
    );
  }

  const editable = upload.status === 'needs_review';
  const rows = upload.values.filter((v) => v.reviewStatus !== 'deleted');
  const deletedCount = upload.values.length - rows.length;
  // 用 checked 而不是 reviewStatus：修改过、补录的行勾选后 reviewStatus 仍是 edited、added（验收反馈 5）
  const pendingAttention = rows.filter((v) => v.attention && !v.checked);
  const file = upload.files[fileIndex] ?? upload.files[0];
  const highlighted = new Set(rejection?.valueIds ?? []);

  const replaceValue = (value: ExtractedValue, nextVersion: number) => {
    setUpload((u) =>
      u
        ? {
            ...u,
            version: nextVersion,
            values: u.values.some((v) => v.id === value.id)
              ? u.values.map((v) => (v.id === value.id ? value : v))
              : [...u.values, value],
          }
        : u,
    );
    setRejection(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const key = uploadErrorKey(err);
      setError(t(`reports.errors.${key}`));
      // 别处改过或状态变了：重新加载
      if (key === 'conflict' || key === 'notFound') reload();
    } finally {
      setBusy(false);
    }
  };

  const toggleChecked = (v: ExtractedValue, checked: boolean) =>
    run(async () => {
      const res = await updateValue(upload.id, v.id, { checked });
      replaceValue(res.value, res.version);
    });

  const remove = (v: ExtractedValue) =>
    run(async () => {
      const res = await updateValue(upload.id, v.id, { deleted: true });
      replaceValue(res.value, res.version);
    });

  const saveRow = (v: ExtractedValue | null, d: RowDraft) =>
    run(async () => {
      const body = {
        rawName: d.rawName.trim(),
        // 自动对应时不传，后端按名称对应
        ...(d.code === AUTO ? {} : { code: d.code }),
        rawValue: d.rawValue.trim(),
        rawUnit: d.rawUnit.trim() || null,
        refText: d.refText.trim() || null,
      };
      const res = v ? await updateValue(upload.id, v.id, body) : await addValue(upload.id, body);
      replaceValue(res.value, res.version);
      setEditingId(null);
      setAdding(false);
    });

  const verify = (confirmAll: boolean) =>
    run(async () => {
      try {
        const next = await verifyUpload(upload.id, {
          version: upload.version,
          checkedValueIds: rows.filter((v) => v.checked).map((v) => v.id),
          reportDate,
          acknowledgedCritical: ackCritical,
          saveAsNew,
          identityConfirmed,
          confirmAll,
        });
        setUpload(next.upload);
        setVerifiedCritical(next.critical);
        setRejection(null);
        onChanged?.();
      } catch (err) {
        if (!(err instanceof VerifyRejectedError)) throw err;
        setRejection(err.rejection);
        if (err.rejection.reasons.includes('stale_version')) reload();
      }
    });

  const discard = () =>
    run(async () => {
      const next = await discardUpload(upload.id);
      setUpload({ ...upload, ...next });
      setConfirmDiscard(false);
      onChanged?.();
    });

  const critical = rejection?.critical ?? [];
  const needsSameDate = upload.sameDateReportIds.length > 0;
  const canConfirmAll = editable && !busy && identityConfirmed && rows.length > 0 && !!reportDate;
  const canConfirm = canConfirmAll && pendingAttention.length === 0;
  // 被拒绝时点名需要处理的行（数值缺失、重复指标等）
  const blockedNames = rows.filter((v) => highlighted.has(v.id)).map((v) => v.rawName);

  return (
    <div className={styles.review}>
      <div className={styles.reviewHeader}>
        {onBack && (
          <Button variant="ghost" icon={<ChevronLeft size={16} />} onClick={onBack}>
            {t('reports.review.back')}
          </Button>
        )}
        <p className={styles.muted} role="status">
          {statusText(t, upload)}
        </p>
      </div>

      {editable && (
        <div
          className={styles.identity}
          role="group"
          aria-label={t('reports.review.identityTitle')}
        >
          <p className={styles.identityNotice}>{t('reports.review.identityNotice')}</p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={identityConfirmed}
              onChange={(e) => {
                setIdentityConfirmed(e.target.checked);
                setRejection(null);
              }}
            />
            {t('reports.review.identityConfirm')}
          </label>
        </div>
      )}

      {file && (
        <section className={styles.preview} aria-label={t('reports.review.originalFile')}>
          {upload.files.length > 1 && (
            <div className={styles.fileTabs} role="group" aria-label={t('reports.review.files')}>
              {upload.files.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  className={styles.fileTab}
                  aria-pressed={i === fileIndex}
                  onClick={() => {
                    setFileIndex(i);
                    setPage(1);
                  }}
                >
                  {t('reports.review.fileN', { n: i + 1 })}
                </button>
              ))}
            </div>
          )}
          <p className={styles.fileName} title={file.originalName}>
            {file.originalName}
          </p>
          <div className={styles.frame}>
            {file.mimeType === 'application/pdf' ? (
              <iframe
                key={`${file.id}-${page}`}
                className={styles.pdf}
                src={fileContentUrl(file.id, page)}
                title={t('reports.review.pageTitle', { page, total: file.pageCount })}
              />
            ) : (
              <img
                className={styles.image}
                src={fileContentUrl(file.id, 1)}
                alt={t('reports.review.pageTitle', { page: 1, total: 1 })}
              />
            )}
          </div>
          {file.pageCount > 1 && (
            <div className={styles.pager}>
              <IconButton
                label={t('reports.review.prevPage')}
                icon={<ChevronLeft size={16} />}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              />
              <span>{t('reports.review.pageOf', { page, total: file.pageCount })}</span>
              <IconButton
                label={t('reports.review.nextPage')}
                icon={<ChevronRight size={16} />}
                disabled={page >= file.pageCount}
                onClick={() => setPage((p) => p + 1)}
              />
            </div>
          )}
        </section>
      )}

      <section className={styles.values} aria-label={t('reports.review.values')}>
        {editable && (
          <p className={styles.note}>
            {pendingAttention.length
              ? t('reports.review.attentionLeft', { count: pendingAttention.length })
              : t('reports.review.attentionDone')}
          </p>
        )}
        <ul className={styles.rows}>
          {rows.map((v) =>
            editingId === v.id ? (
              <li key={v.id} className={styles.row}>
                <RowForm
                  initial={draftOf(v)}
                  busy={busy}
                  onCancel={() => setEditingId(null)}
                  onSave={(d) => void saveRow(v, d)}
                />
              </li>
            ) : (
              <ValueRow
                key={v.id}
                value={v}
                editable={editable}
                busy={busy}
                highlighted={highlighted.has(v.id)}
                onShowPage={(p) => {
                  setPage(p);
                }}
                onToggle={(checked) => void toggleChecked(v, checked)}
                onEdit={() => setEditingId(v.id)}
                onDelete={() => void remove(v)}
              />
            ),
          )}
        </ul>
        {deletedCount > 0 && (
          <p className={styles.muted}>
            {t('reports.review.deletedCount', { count: deletedCount })}
          </p>
        )}
        {editable &&
          (adding ? (
            <RowForm
              initial={draftOf()}
              busy={busy}
              onCancel={() => setAdding(false)}
              onSave={(d) => void saveRow(null, d)}
            />
          ) : (
            <div>
              <Button icon={<Plus size={16} />} onClick={() => setAdding(true)} disabled={busy}>
                {t('reports.review.addRow')}
              </Button>
            </div>
          ))}
      </section>

      {editable && (
        <section className={styles.confirm} aria-label={t('reports.review.confirmSection')}>
          <label className={styles.label}>
            {t('reports.review.reportDate')}
            <input
              type="date"
              className={styles.input}
              value={reportDate}
              required
              onChange={(e) => {
                setReportDate(e.target.value);
                setRejection(null);
              }}
            />
          </label>
          {needsSameDate && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={saveAsNew}
                onChange={(e) => setSaveAsNew(e.target.checked)}
              />
              {t('reports.review.saveAsNew')}
            </label>
          )}
          {critical.length > 0 && (
            <CriticalList
              flags={critical}
              acknowledged={ackCritical}
              onAcknowledge={setAckCritical}
            />
          )}
          {rejection && (
            <ul className={styles.reasons} role="alert">
              {rejection.reasons.map((r) => (
                <li key={r}>{t(`reports.verify.${r}`)}</li>
              ))}
              {blockedNames.length > 0 && (
                <li>{t('reports.review.blockedRows', { names: blockedNames.join('、') })}</li>
              )}
            </ul>
          )}
          {!identityConfirmed && <p className={styles.note}>{t('reports.review.identityHint')}</p>}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <Button variant="primary" onClick={() => void verify(false)} disabled={!canConfirm}>
              {t('reports.review.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => void verify(true)} disabled={!canConfirmAll}>
              {t('reports.review.confirmAll')}
            </Button>
            {confirmDiscard ? (
              <>
                <Button variant="secondary" onClick={() => void discard()} disabled={busy}>
                  {t('reports.review.confirmDiscard')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                  {t('reports.review.cancel')}
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={busy}>
                {t('reports.review.discard')}
              </Button>
            )}
          </div>
          <p className={styles.note}>{t('reports.review.confirmAllNote')}</p>
          <p className={styles.note}>{t('reports.review.note')}</p>
        </section>
      )}
      {!editable && verifiedCritical.length > 0 && <CriticalList flags={verifiedCritical} />}
      {!editable && error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ValueRow({
  value: v,
  editable,
  busy,
  highlighted,
  onShowPage,
  onToggle,
  onEdit,
  onDelete,
}: {
  value: ExtractedValue;
  editable: boolean;
  busy: boolean;
  highlighted: boolean;
  onShowPage: (page: number) => void;
  onToggle: (checked: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const checkId = useId();
  const name = v.code ? dt(`indicators.${v.code}`, v.rawName) : v.rawName;
  const converted = v.flags.includes('unit_converted');
  return (
    <li
      className={styles.row}
      data-attention={v.attention || undefined}
      data-highlighted={highlighted || undefined}
    >
      <div className={styles.rowHead}>
        <span className={styles.rowName}>
          {name}
          {v.code && name !== v.rawName && <span className={styles.muted}> · {v.rawName}</span>}
        </span>
        <span className={styles.badges}>
          {v.flags.map((f) => (
            <span key={f} className={styles.flag} data-flag={f}>
              {t(`reports.flags.${f}`)}
            </span>
          ))}
          <AbnormalBadge abnormal={v.abnormal} />
        </span>
      </div>
      <p className={styles.rowValue}>
        <span className={styles.value}>
          {v.value === null
            ? t('reports.review.noValue')
            : t('reports.value', { value: v.value, unit: v.unit ?? '' })}
        </span>
        {(converted || v.value === null) && (
          <span className={styles.muted}>
            {' '}
            {t('reports.review.original', {
              value: v.rawValue,
              unit: v.rawUnit ?? '',
            })}
          </span>
        )}
      </p>
      <p className={styles.muted}>
        {v.refText
          ? t('reports.review.ref', { ref: v.refText })
          : t('reports.abnormal.no_reference')}
        {v.page !== null && (
          <>
            {' · '}
            <button type="button" className={styles.link} onClick={() => onShowPage(v.page ?? 1)}>
              {t('reports.review.page', { page: v.page })}
            </button>
          </>
        )}
      </p>
      {v.sourceSnippet && <p className={styles.snippet}>{v.sourceSnippet}</p>}
      {editable && (
        <div className={styles.rowActions}>
          {v.attention && (
            <label className={styles.check} htmlFor={checkId}>
              <input
                id={checkId}
                type="checkbox"
                checked={v.checked}
                disabled={busy}
                onChange={(e) => onToggle(e.target.checked)}
              />
              {t('reports.review.checked')}
            </label>
          )}
          <Button
            variant="ghost"
            icon={<Pencil size={14} />}
            onClick={onEdit}
            disabled={busy}
            aria-label={t('reports.review.editRow', { name })}
          >
            {t('reports.review.edit')}
          </Button>
          <Button
            variant="ghost"
            icon={<Trash2 size={14} />}
            onClick={onDelete}
            disabled={busy}
            aria-label={t('reports.review.deleteRow', { name })}
          >
            {t('reports.review.delete')}
          </Button>
        </div>
      )}
    </li>
  );
}

export function AbnormalBadge({ abnormal }: { abnormal: ExtractedValue['abnormal'] }) {
  const { t } = useTranslation();
  if (abnormal === 'normal') return null;
  return (
    <span className={styles.abnormal} data-abnormal={abnormal}>
      {t(`reports.abnormal.${abnormal}`)}
    </span>
  );
}

function RowForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: RowDraft;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const [d, setD] = useState(initial);
  const valid = d.rawName.trim() && d.rawValue.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSave(d);
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.label}>
        {t('reports.form.name')}
        <input
          className={styles.input}
          value={d.rawName}
          maxLength={100}
          required
          onChange={(e) => setD({ ...d, rawName: e.target.value })}
        />
      </label>
      <label className={styles.label}>
        {t('reports.form.code')}
        <select
          className={styles.input}
          value={d.code ?? UNMAPPED}
          onChange={(e) => setD({ ...d, code: e.target.value || null })}
        >
          <option value={AUTO}>{t('reports.form.auto')}</option>
          <option value={UNMAPPED}>{t('reports.form.unmapped')}</option>
          {REPORT_INDICATORS.map((i) => (
            <option key={i.code} value={i.code}>
              {dt(`indicators.${i.code}`, i.code)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.formRow}>
        <label className={styles.label}>
          {t('reports.form.value')}
          <input
            className={styles.input}
            value={d.rawValue}
            maxLength={50}
            required
            inputMode="decimal"
            onChange={(e) => setD({ ...d, rawValue: e.target.value })}
          />
        </label>
        <label className={styles.label}>
          {t('reports.form.unit')}
          <input
            className={styles.input}
            value={d.rawUnit}
            maxLength={30}
            onChange={(e) => setD({ ...d, rawUnit: e.target.value })}
          />
        </label>
      </div>
      <label className={styles.label}>
        {t('reports.form.ref')}
        <input
          className={styles.input}
          value={d.refText}
          maxLength={60}
          placeholder={t('reports.form.refPlaceholder')}
          onChange={(e) => setD({ ...d, refText: e.target.value })}
        />
      </label>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {t('reports.form.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('reports.form.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * 危急指标列表。核对前带“已知悉”勾选；确认后（没有 onAcknowledge）只列出，
 * 并提示先电话联系客户（“确认所有数据”不勾选“已知悉”，确认后在这里醒目显示）。
 */
function CriticalList({
  flags,
  acknowledged = false,
  onAcknowledge,
}: {
  flags: CriticalFlag[];
  acknowledged?: boolean;
  onAcknowledge?: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  return (
    <div
      className={styles.critical}
      role="group"
      aria-label={t('results.artifacts.critical.title')}
    >
      <p className={styles.criticalTitle}>{t('results.artifacts.critical.title')}</p>
      <ul className={styles.rows}>
        {flags.map((f) => (
          <li key={`${f.metric}-${f.value}`}>
            {t('results.artifacts.critical.item', {
              metric: dt(`indicators.${f.metric}`, f.metric),
              value: f.value,
              unit: f.unit,
            })}{' '}
            <span className={styles.muted}>
              {t(`results.artifacts.critical.level.${f.rule.level}`)}
            </span>
          </li>
        ))}
      </ul>
      {onAcknowledge ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledge(e.target.checked)}
          />
          {t('results.artifacts.critical.acknowledge')}
        </label>
      ) : (
        <p className={styles.criticalTitle} role="status">
          {t('results.artifacts.critical.callFirst')}
        </p>
      )}
    </div>
  );
}
