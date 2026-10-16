import type { ClientRecord as RecordData, ClientSummary } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getClientRecord } from '../api/clients';
import { isAbortError } from '../api/http';
import { StatusBadge } from '../artifacts/ArtifactView';
import { useDynamicT, useSkillName } from '../i18n/dynamic';
import { ClientForm } from './ClientForm';
import styles from './ClientRecord.module.css';
import { displayDate, recordErrorKey, type RecordErrorKey } from './errors';
import { HealthHistorySection } from './HealthHistorySection';
import { RiskTierSection } from './RiskTierSection';

export interface ClientRecordProps {
  /** 客户列表里的基本信息，档案加载出来之前先显示 */
  client: ClientSummary;
  /** 改变时重新加载（比如对话里生成了新产物） */
  refreshKey?: string;
  onClientSaved: (client: ClientSummary) => void;
  onNewClient: () => void;
}

/**
 * 结果区“档案”标签：统一客户档案（M2 规格 2.2）。
 * 从上到下：基本信息、风险分层、健康史、体检报告、指标趋势、日常监测、产物。
 * 每个数值旁注明来源和日期。
 */
export function ClientRecord({
  client,
  refreshKey,
  onClientSaved,
  onNewClient,
}: ClientRecordProps) {
  const { t } = useTranslation();
  const [record, setRecord] = useState<RecordData | null>(null);
  const [error, setError] = useState<RecordErrorKey | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);

  const clientId = client.id;
  useEffect(() => {
    setEditing(false);
    setRecord((current) => (current?.client.id === clientId ? current : null));
  }, [clientId]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    getClientRecord(clientId, controller.signal)
      .then(setRecord)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(recordErrorKey(err));
      });
    return () => controller.abort();
  }, [clientId, refreshKey, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const shown = record?.client.id === clientId ? record : null;
  const basic = shown?.client ?? client;
  const readOnly = shown?.readOnly ?? true;

  return (
    <div className={styles.record}>
      <div className={styles.header}>
        <h3 id="hb-client-name" className={styles.name}>
          {basic.displayName}
          {basic.isSynthetic && <span className={styles.tag}>{t('record.synthetic')}</span>}
        </h3>
        <Button variant="ghost" icon={<Plus size={16} />} onClick={onNewClient}>
          {t('record.newClient')}
        </Button>
      </div>

      {editing ? (
        <div className={styles.section}>
          <ClientForm
            client={basic}
            onCancel={() => setEditing(false)}
            onSaved={(saved) => {
              setEditing(false);
              onClientSaved(saved);
              reload();
            }}
          />
        </div>
      ) : (
        <BasicInfo client={basic} onEdit={shown && !readOnly ? () => setEditing(true) : null} />
      )}

      {error && !shown && (
        <div className={styles.section} role="alert">
          <p className={styles.error}>
            {error === 'notFound' ? t('record.errors.notFound') : t('record.loadFailed')}
          </p>
          <div>
            <Button onClick={reload}>{t('record.retry')}</Button>
          </div>
        </div>
      )}
      {!error && !shown && (
        <p className={styles.status} role="status">
          {t('record.loading')}
        </p>
      )}
      {shown && (
        <>
          <RiskTierSection
            clientId={clientId}
            current={shown.riskTier}
            readOnly={readOnly}
            onChanged={reload}
          />
          <HealthHistorySection
            clientId={clientId}
            items={shown.healthHistory}
            readOnly={readOnly}
            onChanged={reload}
          />
          <Reports record={shown} />
          <Indicators record={shown} />
          <Monitoring record={shown} />
          <Artifacts record={shown} />
          <p className={styles.note}>{t('record.sourceNote')}</p>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h4 id={id} className={styles.sectionTitle}>
        {title}
      </h4>
      {children}
    </section>
  );
}

function BasicInfo({ client, onEdit }: { client: ClientSummary; onEdit: (() => void) | null }) {
  const { t } = useTranslation();
  const id = useId();
  const age = client.birthYear === null ? null : new Date().getFullYear() - client.birthYear;
  const rows: [string, string][] = [
    [
      t('record.basic.gender'),
      client.gender ? t(`record.basic.genders.${client.gender}`) : t('record.basic.unknown'),
    ],
    [
      t('record.basic.birthYear'),
      client.birthYear === null || age === null
        ? t('record.basic.unknown')
        : t('record.basic.birthYearValue', { year: client.birthYear, age }),
    ],
  ];
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <h4 id={id} className={styles.sectionTitle}>
          {t('record.sections.basic')}
        </h4>
        {onEdit && (
          <Button onClick={onEdit} aria-label={t('record.basic.editLabel')}>
            {t('record.edit')}
          </Button>
        )}
      </div>
      <dl className={styles.fields}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.field}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Reports({ record }: { record: RecordData }) {
  const { t } = useTranslation();
  return (
    <Section title={t('record.sections.reports')}>
      {record.reports.length === 0 ? (
        <p className={styles.empty}>{t('record.reports.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {record.reports.map((r) => (
            <li key={r.id} className={styles.item}>
              <span className={styles.itemMain}>
                {t('record.reports.item', { date: r.reportDate })}
              </span>
              <span className={styles.meta}>
                {t('record.reports.indicatorCount', { count: r.indicatorCount })} ·{' '}
                {t(`record.reports.source.${r.source}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Indicators({ record }: { record: RecordData }) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  return (
    <Section title={t('record.sections.indicators')}>
      {record.indicators.length === 0 ? (
        <p className={styles.empty}>{t('record.indicators.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {record.indicators.map((series) => (
            <li key={series.code} className={styles.form}>
              <h5 className={styles.subTitle}>{dt(`indicators.${series.code}`, series.code)}</h5>
              <ul className={styles.points}>
                {series.points.map((p) => (
                  <li key={p.reportId}>
                    <span className={styles.value}>
                      {t('record.indicators.value', { value: p.value, unit: p.unit })}
                    </span>{' '}
                    <span className={styles.meta}>
                      {t('record.indicators.meta', {
                        date: p.reportDate,
                        source: t(`record.reports.source.${p.source}`),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Monitoring({ record }: { record: RecordData }) {
  const { t } = useTranslation();
  const dt = useDynamicT();
  return (
    <Section title={t('record.sections.monitoring')}>
      {record.monitoring.length === 0 ? (
        <p className={styles.empty}>{t('record.monitoring.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {record.monitoring.map((m) => (
            <li key={m.metric} className={styles.item}>
              <span className={styles.itemMain}>
                {dt(`indicators.${m.metric}`, m.metric)}{' '}
                <span className={styles.value}>
                  {t('record.monitoring.latest', { value: m.latest.value, unit: m.unit })}
                </span>
              </span>
              <span className={styles.meta}>
                {t('record.monitoring.meta', {
                  date: displayDate(m.latest.measuredAt),
                  source: t(`record.monitoring.source.${m.latest.source}`),
                  count: m.count,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Artifacts({ record }: { record: RecordData }) {
  const { t } = useTranslation();
  const skillName = useSkillName();
  if (record.readOnly) return null;
  return (
    <Section title={t('record.sections.artifacts')}>
      {record.artifacts.length === 0 ? (
        <p className={styles.empty}>{t('record.artifacts.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {record.artifacts.map((a) => (
            <li key={a.id} className={styles.item}>
              <span className={styles.itemMain}>
                {t('results.artifacts.item', { name: skillName(a.skillId), version: a.version })}
              </span>
              <span className={styles.meta}>
                {t('record.artifacts.meta', { date: displayDate(a.createdAt) })}
              </span>
              <StatusBadge status={a.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
