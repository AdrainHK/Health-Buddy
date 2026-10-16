import type { ReportUpload } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REPORT_ACCEPT, uploadReport } from '../api/reports';
import { uploadErrorKey } from './errors';
import styles from './Reports.module.css';

export interface UploadButtonProps {
  clientId: string;
  taskId?: string | null;
  label: string;
  icon?: ReactNode;
  onUploaded?: (upload: ReportUpload) => void;
}

/** 选择报告文件并上传（一次选择的多个文件算一份报告）。出错时在按钮下方提示 */
export function UploadButton({ clientId, taskId, label, icon, onUploaded }: UploadButtonProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded?.(await uploadReport(clientId, files, taskId));
    } catch (err) {
      setError(t(`reports.errors.${uploadErrorKey(err)}`));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={styles.uploadButton}>
      <Button icon={icon} onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? t('reports.upload.uploading') : label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={REPORT_ACCEPT}
        aria-label={label}
        data-testid="report-file-input"
        onChange={(e) => void onFiles([...(e.target.files ?? [])])}
      />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
