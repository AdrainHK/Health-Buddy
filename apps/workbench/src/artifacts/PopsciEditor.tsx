import {
  POPSCI_FOOTER,
  type ContentCheckHit,
  type ContentCheckResult,
  type PopsciContent,
  type PopsciLocation,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useTranslation } from 'react-i18next';
import { displayDateTime } from '../twin/errors';
import styles from './PopsciEditor.module.css';

/**
 * 科普产物的预览和编辑（M8 规格 2.1 第 5、7、8 条）：文章、讲座 PPT、社群稿按结构逐项编辑。
 * 末尾两句固定提示由后端在导出时拼接，这里只显示、不能改。保存后后端重新做合规检查。
 */
export function PopsciEditor({
  value,
  disabled,
  onChange,
}: {
  value: PopsciContent;
  disabled: boolean;
  onChange: (value: PopsciContent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.editor} data-testid="popsci-editor">
      {value.kind === 'popsci_article' && (
        <>
          <Field
            label={t('popsci.fields.title')}
            value={value.title}
            max={60}
            disabled={disabled}
            onChange={(title) => onChange({ ...value, title })}
          />
          <ol className={styles.list}>
            {value.sections.map((s, i) => (
              <li key={i} className={styles.card} aria-label={t('popsci.section', { n: i + 1 })}>
                <Field
                  label={t('popsci.fields.heading', { n: i + 1 })}
                  value={s.heading}
                  max={40}
                  disabled={disabled}
                  onChange={(heading) =>
                    onChange({
                      ...value,
                      sections: value.sections.map((x, j) => (j === i ? { ...x, heading } : x)),
                    })
                  }
                />
                <Field
                  multiline
                  label={t('popsci.fields.body', { n: i + 1 })}
                  value={s.body}
                  max={2000}
                  disabled={disabled}
                  onChange={(body) =>
                    onChange({
                      ...value,
                      sections: value.sections.map((x, j) => (j === i ? { ...x, body } : x)),
                    })
                  }
                />
                {value.sections.length > 1 && (
                  <Remove
                    label={t('popsci.removeSection', { n: i + 1 })}
                    disabled={disabled}
                    onClick={() =>
                      onChange({ ...value, sections: value.sections.filter((_, j) => j !== i) })
                    }
                  />
                )}
              </li>
            ))}
          </ol>
          {value.sections.length < 12 && (
            <Button
              disabled={disabled}
              onClick={() =>
                onChange({ ...value, sections: [...value.sections, { heading: '', body: '' }] })
              }
            >
              {t('popsci.addSection')}
            </Button>
          )}
          <Field
            multiline
            label={t('popsci.fields.summary')}
            value={value.summary}
            max={300}
            disabled={disabled}
            onChange={(summary) => onChange({ ...value, summary })}
          />
        </>
      )}
      {value.kind === 'lecture_deck' && (
        <>
          <Field
            label={t('popsci.fields.title')}
            value={value.title}
            max={60}
            disabled={disabled}
            onChange={(title) => onChange({ ...value, title })}
          />
          <ol className={styles.list}>
            {value.slides.map((s, i) => {
              const setSlide = (patch: Partial<typeof s>) =>
                onChange({
                  ...value,
                  slides: value.slides.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                });
              return (
                <li key={i} className={styles.card} aria-label={t('popsci.slide', { n: i + 1 })}>
                  <Field
                    label={t('popsci.fields.slideTitle', { n: i + 1 })}
                    value={s.title}
                    max={40}
                    disabled={disabled}
                    onChange={(title) => setSlide({ title })}
                  />
                  {s.bullets.map((b, k) => (
                    <div key={k} className={styles.row}>
                      <Field
                        label={t('popsci.fields.bullet', { n: i + 1, k: k + 1 })}
                        value={b}
                        max={80}
                        disabled={disabled}
                        onChange={(text) =>
                          setSlide({ bullets: s.bullets.map((x, m) => (m === k ? text : x)) })
                        }
                      />
                      {s.bullets.length > 1 && (
                        <Remove
                          label={t('popsci.removeBullet', { n: i + 1, k: k + 1 })}
                          disabled={disabled}
                          onClick={() => setSlide({ bullets: s.bullets.filter((_, m) => m !== k) })}
                        />
                      )}
                    </div>
                  ))}
                  {s.bullets.length < 6 && (
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => setSlide({ bullets: [...s.bullets, ''] })}
                    >
                      {t('popsci.addBullet')}
                    </Button>
                  )}
                  <Field
                    multiline
                    label={t('popsci.fields.notes', { n: i + 1 })}
                    value={s.notes}
                    max={600}
                    disabled={disabled}
                    onChange={(notes) => setSlide({ notes })}
                  />
                  {value.slides.length > 1 && (
                    <Remove
                      label={t('popsci.removeSlide', { n: i + 1 })}
                      disabled={disabled}
                      onClick={() =>
                        onChange({ ...value, slides: value.slides.filter((_, j) => j !== i) })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ol>
          {value.slides.length < 30 && (
            <Button
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...value,
                  slides: [...value.slides, { title: '', bullets: [''], notes: '' }],
                })
              }
            >
              {t('popsci.addSlide')}
            </Button>
          )}
        </>
      )}
      {value.kind === 'community_post' && (
        <>
          <ol className={styles.list}>
            {value.paragraphs.map((p, i) => (
              <li key={i} className={styles.card}>
                <Field
                  multiline
                  label={t('popsci.fields.paragraph', { n: i + 1 })}
                  value={p}
                  max={600}
                  disabled={disabled}
                  onChange={(text) =>
                    onChange({
                      ...value,
                      paragraphs: value.paragraphs.map((x, j) => (j === i ? text : x)),
                    })
                  }
                />
                {value.paragraphs.length > 1 && (
                  <Remove
                    label={t('popsci.removeParagraph', { n: i + 1 })}
                    disabled={disabled}
                    onClick={() =>
                      onChange({
                        ...value,
                        paragraphs: value.paragraphs.filter((_, j) => j !== i),
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ol>
          {value.paragraphs.length < 8 && (
            <Button
              disabled={disabled}
              onClick={() => onChange({ ...value, paragraphs: [...value.paragraphs, ''] })}
            >
              {t('popsci.addParagraph')}
            </Button>
          )}
          <Field
            label={t('popsci.fields.interaction')}
            value={value.interaction}
            max={200}
            disabled={disabled}
            onChange={(interaction) => onChange({ ...value, interaction })}
          />
        </>
      )}
      <div className={styles.footer} role="note" aria-label={t('popsci.footerLabel')}>
        {POPSCI_FOOTER.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className={styles.muted}>{t('popsci.footerNote')}</p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  max,
  disabled,
  multiline = false,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  disabled: boolean;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const over = value.length > max;
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        {label}
        <span className={over ? styles.over : styles.muted}>
          {' '}
          {value.length}/{max}
        </span>
      </span>
      {multiline ? (
        <textarea
          className={styles.input}
          rows={4}
          value={value}
          disabled={disabled}
          aria-invalid={over || !value.trim() ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={styles.input}
          value={value}
          disabled={disabled}
          aria-invalid={over || !value.trim() ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

function Remove({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" aria-label={label} disabled={disabled} onClick={onClick}>
      {t('popsci.remove')}
    </Button>
  );
}

/** 命中项的位置：“第 2 节正文”“第 3 页第 1 条要点”“第 1 段” */
function useLocationLabel(): (l: PopsciLocation) => string {
  const { t } = useTranslation();
  return (l) =>
    t(`popsci.locations.${l.field}`, {
      n: (l.index ?? 0) + 1,
      k: (l.item ?? 0) + 1,
    });
}

/**
 * 合规检查结果（M8 规格 2.1 第 5、7 条，2.3）：禁止类必须改掉；需要人工判断的逐条看过后勾选“已核对”，
 * 系统记下核对人。结果以后端为准，保存后重新检查。
 */
export function ContentCheckPanel({
  check,
  dirty,
  disabled,
  busy,
  onAck,
}: {
  check: ContentCheckResult;
  /** 有未保存的修改：结果对应的是已保存的内容 */
  dirty: boolean;
  disabled: boolean;
  busy: boolean;
  onAck: () => void;
}) {
  const { t } = useTranslation();
  const where = useLocationLabel();
  const forbid = check.hits.filter((h) => h.category === 'forbid');
  const review = check.hits.filter((h) => h.category === 'review');
  const item = (h: ContentCheckHit, i: number) => (
    <li key={`${h.ruleId}-${h.term}-${i}`}>
      <span className={styles.where}>{where(h.location)}</span>
      {h.term && <mark className={styles.term}>{h.term}</mark>}
      <span className={styles.reason}>{h.reason}</span>
    </li>
  );
  return (
    <section className={styles.check} aria-label={t('popsci.check.title')}>
      <h3 className={styles.checkTitle}>{t('popsci.check.title')}</h3>
      {dirty && <p className={styles.muted}>{t('popsci.check.dirty')}</p>}
      {check.hits.length === 0 && <p className={styles.ok}>{t('popsci.check.passed')}</p>}
      {forbid.length > 0 && (
        <>
          <p className={styles.forbidTitle}>{t('popsci.check.forbid', { count: forbid.length })}</p>
          <ul className={styles.hits} aria-label={t('popsci.check.forbidList')}>
            {forbid.map(item)}
          </ul>
        </>
      )}
      {review.length > 0 && (
        <>
          <p className={styles.reviewTitle}>{t('popsci.check.review', { count: review.length })}</p>
          <ul className={styles.hits} aria-label={t('popsci.check.reviewList')}>
            {review.map(item)}
          </ul>
          {check.ackedAt ? (
            <p className={styles.ok}>
              {t('popsci.check.acked', { time: displayDateTime(check.ackedAt) })}
            </p>
          ) : (
            <Button disabled={disabled || busy || dirty || forbid.length > 0} onClick={onAck}>
              {busy ? t('popsci.check.acking') : t('popsci.check.ack')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
