import type { Report, ReportIndicator, ReportListItem, ReportUpload } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Pencil, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAbortError } from '../api/http';
import { correctIndicator, getReport } from '../api/reports';
import { useDynamicT } from '../i18n/dynamic';
import { uploadErrorKey } from './errors';
import { AbnormalBadge } from './ReviewView';
import styles from './Reports.module.css';
import { UploadButton } from './UploadButton';

export interface ReportsSectionProps {
  clientId: string;
  reports: ReportListItem[];
  readOnly: boolean;
  /** 上传成功：结果区切到核对标签 */
  onUploaded?: (upload: ReportUpload) => void;
  /** 更正了指标，档案需要重新加载 */
  onChanged?: () => void;
}

/**
 * 档案里的“体检报告”区块（规格 2.2、2.4）：只列已核对的报告，每份可以展开看指标、
 * 高低标记、原值和参考范围、更正历史。健管师可以从这里上传新报告、更正已核对的指标。
 */
export function ReportsSection({
  clientId,
  reports,
  readOnly,
  onUploaded,
  onChanged,
}: ReportsSectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <div className={styles.sectionHeader}>
        <h4 id={titleId} className={styles.sectionTitle}>
          {t('record.sections.reports')}
        </h4>
        {!readOnly && (
          <UploadButton
            clientId={clientId}
            label={t('reports.upload.button')}
            icon={<Upload size={16} />}
            {...(onUploaded ? { onUploaded } : {})}
          />
        )}
      </div>
      {reports.length === 0 ? (
        <p className={styles.muted}>{t('record.reports.empty')}</p>
      ) : (
        <ul className={styles.rows}>
          {reports.map((r) => (
            <li key={r.id} className={styles.reportItem}>
              <button
                type="button"
                className={styles.reportToggle}
                aria-expanded={openId === r.id}
                onClick={() => setOpenId((id) => (id === r.id ? null : r.id))}
              >
                <span className={styles.rowName}>
                  {t('record.reports.item', { date: r.reportDate })}
                  {r.institution && <span className={styles.muted}> · {r.institution}</span>}
                  {r.hasCritical && (
                    <>
                      {' '}
                      <span className={styles.criticalMark}>{t('record.reports.critical')}</span>
                    </>
                  )}
                </span>
                <span className={styles.muted}>
                  {t('record.reports.indicatorCount', { count: r.indicatorCount })}
                  {r.abnormalCount > 0 &&
                    ` · ${t('record.reports.abnormalCount', { count: r.abnormalCount })}`}
                  {' · '}
                  {t(`record.reports.source.${r.source}`)}
                </span>
              </button>
              {openId === r.id && (
                <ReportDetail
                  reportId={r.id}
                  readOnly={readOnly}
                  {...(onChanged ? { onChanged } : {})}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.note}>{t('reports.disclaimer')}</p>
    </section>
  );
}

function ReportDetail({
  reportId,
  readOnly,
  onChanged,
}: {
  reportId: string;
  readOnly: boolean;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [correcting, setCorrecting] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    getReport(reportId, controller.signal)
      .then(setReport)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setFailed(true);
      });
    return () => controller.abort();
  }, [reportId]);

  if (failed) {
    return (
      <p className={styles.error} role="alert">
        {t('reports.detail.loadFailed')}
      </p>
    );
  }
  if (!report) {
    return (
      <p className={styles.muted} role="status">
        {t('reports.detail.loading')}
      </p>
    );
  }
  const canCorrect = !readOnly && report.source === 'upload';
  return (
    <div className={styles.detail}>
      <ul className={styles.rows}>
        {report.indicators.map((i) =>
          correcting === i.id ? (
            <li key={i.id}>
              <CorrectForm
                reportId={report.id}
                indicator={i}
                onCancel={() => setCorrecting(null)}
                onSaved={(next) => {
                  setReport(next);
                  setCorrecting(null);
                  onChanged?.();
                }}
              />
            </li>
          ) : (
            <IndicatorRow
              key={i.id}
              indicator={i}
              {...(canCorrect ? { onCorrect: () => setCorrecting(i.id) } : {})}
            />
          ),
        )}
      </ul>
      {report.corrections.length > 0 && (
        <details className={styles.corrections}>
          <summary>{t('reports.detail.corrections', { count: report.corrections.length })}</summary>
          <ul className={styles.rows}>
            {report.corrections.map((i) => (
              <IndicatorRow key={i.id} indicator={i} superseded />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function IndicatorRow({
  indicator: i,
  superseded,
  onCorrect,
}: {
  indicator: ReportIndicator;
  superseded?: boolean;
  onCorrect?: () => void;
}) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  const name = i.code ? dt(`indicators.${i.code}`, i.rawName ?? i.code) : (i.rawName ?? '');
  const showOriginal =
    i.originalValue !== null &&
    (i.originalUnit !== i.unit || String(i.value ?? '') !== i.originalValue);
  return (
    <li className={styles.indicator} data-superseded={superseded || undefined}>
      <div className={styles.rowHead}>
        <span className={styles.rowName}>
          {name}
          {!i.code && <span className={styles.muted}> · {t('reports.flags.unmapped')}</span>}
        </span>
        <span className={styles.badges}>
          <AbnormalBadge abnormal={i.abnormal} />
        </span>
      </div>
      <p className={styles.rowValue}>
        <span className={styles.value}>
          {i.value === null
            ? (i.originalValue ?? t('reports.review.noValue'))
            : t('reports.value', { value: i.value, unit: i.unit })}
        </span>
        {showOriginal && (
          <span className={styles.muted}>
            {' '}
            {t('reports.review.original', { value: i.originalValue, unit: i.originalUnit ?? '' })}
          </span>
        )}
      </p>
      <p className={styles.muted}>
        {i.refText
          ? t('reports.review.ref', { ref: i.refText })
          : t('reports.abnormal.no_reference')}
        {superseded && ` · ${t('reports.detail.supersededAt', { date: i.createdAt.slice(0, 10) })}`}
      </p>
      {onCorrect && (
        <div className={styles.rowActions}>
          <Button
            variant="ghost"
            icon={<Pencil size={14} />}
            onClick={onCorrect}
            aria-label={t('reports.detail.correctRow', { name })}
          >
            {t('reports.detail.correct')}
          </Button>
        </div>
      )}
    </li>
  );
}

function CorrectForm({
  reportId,
  indicator,
  onSaved,
  onCancel,
}: {
  reportId: string;
  indicator: ReportIndicator;
  onSaved: (report: Report) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [rawValue, setRawValue] = useState(
    indicator.originalValue ?? String(indicator.value ?? ''),
  );
  const [rawUnit, setRawUnit] = useState(indicator.originalUnit ?? indicator.unit);
  const [refText, setRefText] = useState(indicator.refText ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rawValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await correctIndicator(reportId, indicator.id, {
          rawValue: rawValue.trim(),
          rawUnit: rawUnit.trim() || null,
          refText: refText.trim() || null,
        }),
      );
    } catch (err) {
      setError(t(`reports.errors.${uploadErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)}>
      <div className={styles.formRow}>
        <label className={styles.label}>
          {t('reports.form.value')}
          <input
            className={styles.input}
            value={rawValue}
            maxLength={50}
            required
            inputMode="decimal"
            onChange={(e) => setRawValue(e.target.value)}
          />
        </label>
        <label className={styles.label}>
          {t('reports.form.unit')}
          <input
            className={styles.input}
            value={rawUnit}
            maxLength={30}
            onChange={(e) => setRawUnit(e.target.value)}
          />
        </label>
      </div>
      <label className={styles.label}>
        {t('reports.form.ref')}
        <input
          className={styles.input}
          value={refText}
          maxLength={60}
          onChange={(e) => setRefText(e.target.value)}
        />
      </label>
      <p className={styles.note}>{t('reports.detail.correctNote')}</p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || !rawValue.trim()}>
          {t('reports.detail.saveCorrection')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('reports.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
