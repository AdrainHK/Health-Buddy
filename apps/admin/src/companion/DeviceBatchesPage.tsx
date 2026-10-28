import {
  COMPANION_BATCH_MAX_DEVICES,
  importDeviceBatchRequestSchema,
  type DeviceBatch,
  type ImportDeviceBatchRequest,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Info, Upload } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { importDeviceBatch, listDeviceBatches } from '../api/companion';
import { ApiError } from '../api/http';
import { Dialog } from '../thresholds/Dialog';
import styles from '../thresholds/Thresholds.module.css';
import own from './Companion.module.css';

type State =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; batches: DeviceBatch[] };

/**
 * 每行一台设备：序列号、设备密钥、激活码，用逗号或制表符分隔（厂商导出的表格可以直接粘贴）。
 * 空行和以 # 开头的行忽略。返回解析结果，或第几行格式不对。
 */
export function parseDeviceLines(
  text: string,
): { devices: ImportDeviceBatchRequest['devices'] } | { badLines: number[] } {
  const devices: ImportDeviceBatchRequest['devices'] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/[,\t，]/).map((p) => p.trim());
    if (parts.length !== 3) {
      badLines.push(i + 1);
      return;
    }
    const [serialNo, deviceSecret, activationCode] = parts as [string, string, string];
    devices.push({ serialNo, deviceSecret, activationCode });
  });
  return badLines.length ? { badLines } : { devices };
}

/**
 * 伴侣“福宝”的出厂设备批次（M6 规格 2.10、N2）。只有平台管理员。
 * 平台只看每批的数量和绑定数，看不到设备绑给了谁；设备密钥导入后加密保存，激活码只存哈希。
 */
export function DeviceBatchesPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDeviceBatches()
      .then((batches) => !cancelled && setState({ status: 'ready', batches }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className={styles.page} aria-labelledby="device-batches-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('deviceBatches.disclaimer')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="device-batches-title" className={styles.title}>
            {t('deviceBatches.title')}
          </h1>
          <p className={styles.subtitle}>{t('deviceBatches.subtitle')}</p>
        </div>
        <div className={styles.toolbar}>
          <Button
            variant="primary"
            icon={<Upload size={16} aria-hidden />}
            onClick={() => {
              setNotice(null);
              setImporting(true);
            }}
          >
            {t('deviceBatches.import')}
          </Button>
        </div>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {state.status === 'loading' && (
        <p className={styles.muted} role="status">
          {t('deviceBatches.loading')}
        </p>
      )}
      {state.status === 'error' && (
        <div className={styles.error} role="alert">
          <span>{t('deviceBatches.loadFailed')}</span>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t('deviceBatches.retry')}</Button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.batches.length === 0 ? (
          <p className={styles.muted}>{t('deviceBatches.empty')}</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('deviceBatches.columns.name')}</th>
                <th scope="col">{t('deviceBatches.columns.count')}</th>
                <th scope="col">{t('deviceBatches.columns.bound')}</th>
                <th scope="col">{t('deviceBatches.columns.importedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {state.batches.map((b) => (
                <tr key={b.id}>
                  <th scope="row" data-label={t('deviceBatches.columns.name')}>
                    {b.name}
                  </th>
                  <td data-label={t('deviceBatches.columns.count')}>{b.deviceCount}</td>
                  <td data-label={t('deviceBatches.columns.bound')}>{b.boundCount}</td>
                  <td data-label={t('deviceBatches.columns.importedAt')}>
                    {b.importedAt.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(batch) => {
            setImporting(false);
            setNotice(t('deviceBatches.imported', { name: batch.name, count: batch.deviceCount }));
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </section>
  );
}

function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (b: DeviceBatch) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [lines, setLines] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseDeviceLines(lines);
    if ('badLines' in parsed) {
      setError(
        t('deviceBatches.errors.badLines', { lines: parsed.badLines.slice(0, 10).join('、') }),
      );
      return;
    }
    const body = { name: name.trim(), devices: parsed.devices };
    if (!body.name) {
      setError(t('deviceBatches.errors.name'));
      return;
    }
    if (!body.devices.length || body.devices.length > COMPANION_BATCH_MAX_DEVICES) {
      setError(t('deviceBatches.errors.count', { max: COMPANION_BATCH_MAX_DEVICES }));
      return;
    }
    const serials = body.devices.map((d) => d.serialNo);
    if (new Set(serials).size !== serials.length) {
      setError(t('deviceBatches.errors.repeated'));
      return;
    }
    const valid = importDeviceBatchRequestSchema.safeParse(body);
    if (!valid.success) {
      setError(t('deviceBatches.errors.format'));
      return;
    }
    setBusy(true);
    setError(null);
    importDeviceBatch(valid.data)
      .then(onImported)
      .catch((err: unknown) => {
        const serialsTaken =
          err instanceof ApiError && Array.isArray(err.details.serials)
            ? (err.details.serials as unknown[]).filter((s): s is string => typeof s === 'string')
            : [];
        if (serialsTaken.length) {
          setError(
            t('deviceBatches.errors.duplicates', { serials: serialsTaken.slice(0, 10).join('、') }),
          );
        } else if (err instanceof ApiError && err.code === 'bad_request') {
          setError(t('deviceBatches.errors.format'));
        } else if (err instanceof ApiError && err.code === 'not_configured') {
          setError(t('deviceBatches.errors.notConfigured'));
        } else {
          setError(t('deviceBatches.errors.unknown'));
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <Dialog title={t('deviceBatches.importTitle')} onClose={onClose} wide>
      <form className={styles.form} onSubmit={submit} noValidate>
        <label className={styles.field}>
          {t('deviceBatches.nameLabel')}
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>
          {t('deviceBatches.linesLabel')}
          <textarea
            className={own.noticeArea}
            value={lines}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setLines(e.target.value)}
          />
        </label>
        <p className={styles.hint}>
          {t('deviceBatches.linesHint', { max: COMPANION_BATCH_MAX_DEVICES })}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('deviceBatches.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t('deviceBatches.importing') : t('deviceBatches.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
