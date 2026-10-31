import {
  BRAND_GREETING_MAX,
  BRAND_LOGO_MAX_BYTES,
  BRAND_NAME_MAX,
  BRAND_MIN_CONTRAST,
  PRODUCT_NAME,
  brandColorContrastOk,
  brandContentIssues,
  brandDarkVariant,
  contrastRatio,
  isHexColor,
  updateBrandRequestSchema,
  type Brand,
  type BrandContentIssue,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Heart, Info, Upload } from 'lucide-react';
import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getBrand, saveBrand, uploadBrandLogo } from '../api/brand';
import { ApiError } from '../api/http';
import styles from '../thresholds/Thresholds.module.css';
import own from './Brand.module.css';

/** 平台默认主色（packages/ui tokens.css），协会没设主色时预览用 */
const DEFAULT_COLOR = '#0e7c6b';

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; brand: Brand };
type LogoError =
  'unsupported' | 'unsafe' | 'dimensions' | 'too_large' | 'not_configured' | 'failed';

function logoError(err: unknown): LogoError {
  if (!(err instanceof ApiError)) return 'failed';
  if (err.code === 'unsupported_media_type') return 'unsupported';
  if (err.code === 'payload_too_large') return 'too_large';
  if (err.code === 'not_configured') return 'not_configured';
  const reasons = (err.details as { reasons?: unknown }).reasons;
  if (Array.isArray(reasons) && reasons.includes('unsafe_svg')) return 'unsafe';
  if (Array.isArray(reasons) && reasons.includes('bad_dimensions')) return 'dimensions';
  return 'failed';
}

/**
 * 协会品牌（M7 规格 2.2）：显示名称、主色、登录页欢迎语、Logo。只有协会管理员能改（Q16）。
 * 右侧实时预览工作台顶栏和登录页，浅色、深色各一份。禁用词和主色对比度前端先提示，后端再检查。
 * 保存后健管师下次刷新页面生效。
 */
export function BrandPage() {
  const { t } = useTranslation();
  const id = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [values, setValues] = useState({ displayName: '', primaryColor: '', loginGreeting: '' });
  const [issues, setIssues] = useState<BrandContentIssue[]>([]);
  const [saveError, setSaveError] = useState<'bad_request' | 'failed' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoState, setLogoState] = useState<{ busy: boolean; error: LogoError | null }>({
    busy: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    getBrand()
      .then((brand) => {
        if (cancelled) return;
        setState({ status: 'ready', brand });
        setValues({
          displayName: brand.displayName ?? '',
          primaryColor: brand.primaryColor ?? '',
          loginGreeting: brand.loginGreeting ?? '',
        });
      })
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const set = (k: keyof typeof values) => (v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    setIssues([]);
    setNotice(null);
  };
  const color = isHexColor(values.primaryColor) ? values.primaryColor.toLowerCase() : null;
  const lowContrast = color !== null && !brandColorContrastOk(color);
  const issueFor = (field: BrandContentIssue['field']) => issues.find((i) => i.field === field);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setNotice(null);
    const parsed = updateBrandRequestSchema.safeParse({
      displayName: values.displayName,
      primaryColor: values.primaryColor.trim() || null,
      loginGreeting: values.loginGreeting,
    });
    if (!parsed.success) return setSaveError('bad_request');
    const found = brandContentIssues(parsed.data);
    if (found.length) return setIssues(found);
    setSaving(true);
    try {
      const brand = await saveBrand(parsed.data);
      setState({ status: 'ready', brand });
      setNotice(t('brand.saved'));
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { issues?: unknown }) : {};
      if (
        err instanceof ApiError &&
        err.code === 'invalid_content' &&
        Array.isArray(details.issues)
      ) {
        setIssues(details.issues as BrandContentIssue[]);
      } else {
        setSaveError(
          err instanceof ApiError && err.code === 'bad_request' ? 'bad_request' : 'failed',
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > BRAND_LOGO_MAX_BYTES) return setLogoState({ busy: false, error: 'too_large' });
    setLogoState({ busy: true, error: null });
    try {
      const brand = await uploadBrandLogo(file);
      setState({ status: 'ready', brand });
      setLogoState({ busy: false, error: null });
      setNotice(t('brand.logoSaved'));
    } catch (err) {
      setLogoState({ busy: false, error: logoError(err) });
    }
  };

  if (state.status === 'loading') {
    return (
      <p className={styles.muted} role="status">
        {t('brand.loading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.error} role="alert">
        <span>{t('brand.loadFailed')}</span>
        <Button onClick={() => setReloadKey((k) => k + 1)}>{t('brand.retry')}</Button>
      </div>
    );
  }

  const name = values.displayName.trim() || state.brand.operatorName;
  const previewColor = color && !lowContrast ? color : (state.brand.primaryColor ?? DEFAULT_COLOR);

  return (
    <section className={styles.page} aria-labelledby="brand-title">
      <p className={styles.disclaimer} role="note">
        <Info size={16} aria-hidden />
        <span>{t('brand.disclaimer')}</span>
      </p>
      <div className={styles.titleRow}>
        <div>
          <h1 id="brand-title" className={styles.title}>
            {t('brand.title')}
          </h1>
          <p className={styles.subtitle}>{t('brand.subtitle')}</p>
        </div>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div className={own.layout}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={styles.field}>
            <label htmlFor={`${id}-name`}>{t('brand.form.displayName')}</label>
            <input
              id={`${id}-name`}
              value={values.displayName}
              maxLength={BRAND_NAME_MAX}
              placeholder={state.brand.operatorName}
              onChange={(e) => set('displayName')(e.target.value)}
              aria-invalid={issueFor('displayName') ? true : undefined}
            />
            <small className={styles.hint}>
              {t('brand.form.displayNameHint', { max: BRAND_NAME_MAX })}
            </small>
            {issueFor('displayName') && (
              <p className={styles.error} role="alert">
                {t('brand.errors.banned_term')}
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-color`}>{t('brand.form.primaryColor')}</label>
            <div className={own.colorRow}>
              <input
                type="color"
                aria-label={t('brand.form.colorPicker')}
                value={color ?? previewColor}
                onChange={(e) => set('primaryColor')(e.target.value)}
              />
              <input
                id={`${id}-color`}
                value={values.primaryColor}
                placeholder={DEFAULT_COLOR}
                onChange={(e) => set('primaryColor')(e.target.value.trim())}
                aria-invalid={lowContrast || issueFor('primaryColor') ? true : undefined}
              />
            </div>
            <small className={styles.hint}>
              {color
                ? t('brand.form.contrast', {
                    ratio: contrastRatio(color, '#ffffff').toFixed(1),
                    min: BRAND_MIN_CONTRAST,
                  })
                : t('brand.form.colorHint')}
            </small>
            {(lowContrast || issueFor('primaryColor')) && (
              <p className={styles.error} role="alert">
                {t('brand.errors.low_contrast', { min: BRAND_MIN_CONTRAST })}
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-greeting`}>{t('brand.form.loginGreeting')}</label>
            <textarea
              id={`${id}-greeting`}
              rows={2}
              maxLength={BRAND_GREETING_MAX}
              value={values.loginGreeting}
              placeholder={t('brand.defaultGreeting')}
              onChange={(e) => set('loginGreeting')(e.target.value)}
              aria-invalid={issueFor('loginGreeting') ? true : undefined}
            />
            <small className={styles.hint}>
              {t('brand.form.greetingHint', { max: BRAND_GREETING_MAX })}
            </small>
            {issueFor('loginGreeting') && (
              <p className={styles.error} role="alert">
                {t('brand.errors.banned_term')}
              </p>
            )}
          </div>
          {saveError && (
            <p className={styles.error} role="alert">
              {t(`brand.errors.${saveError}`)}
            </p>
          )}
          <div className={styles.dialogActions}>
            <Button type="submit" variant="primary" disabled={saving || lowContrast}>
              {saving ? t('brand.saving') : t('brand.save')}
            </Button>
          </div>

          <div className={styles.field}>
            <label htmlFor={`${id}-logo`}>{t('brand.form.logo')}</label>
            <input
              id={`${id}-logo`}
              type="file"
              accept="image/png,image/svg+xml,.png,.svg"
              disabled={logoState.busy}
              onChange={(e) => void onLogo(e.target.files?.[0])}
            />
            <small className={styles.hint}>
              <Upload size={12} aria-hidden /> {t('brand.form.logoHint')}
            </small>
            {logoState.error && (
              <p className={styles.error} role="alert">
                {t(`brand.logoErrors.${logoState.error}`)}
              </p>
            )}
          </div>
        </form>

        <div className={own.previews} aria-label={t('brand.preview')} role="group">
          {(['light', 'dark'] as const).map((theme) => (
            <div
              key={theme}
              className={own.preview}
              data-hb-theme={theme}
              data-testid={`preview-${theme}`}
              style={
                {
                  '--hb-brand-custom': previewColor,
                  '--hb-brand-custom-dark': brandDarkVariant(previewColor),
                } as CSSProperties
              }
            >
              <p className={own.previewLabel}>{t(`brand.previewTheme.${theme}`)}</p>
              <div className={own.topbar}>
                <Mark logoUrl={state.brand.logoUrl} />
                <span className={own.name}>
                  {t('shell.withProduct', { name, product: PRODUCT_NAME })}
                </span>
              </div>
              <div className={own.loginCard}>
                <div className={own.topbar}>
                  <Mark logoUrl={state.brand.logoUrl} />
                  <span className={own.name}>
                    {t('shell.withProduct', { name, product: PRODUCT_NAME })}
                  </span>
                </div>
                <p>{values.loginGreeting.trim() || t('brand.defaultGreeting')}</p>
                <span className={own.fakeButton}>{t('brand.previewLogin')}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Mark({ logoUrl }: { logoUrl: string | null }) {
  return logoUrl ? (
    <img className={own.markImage} src={logoUrl} alt="" />
  ) : (
    <span className={own.mark} aria-hidden>
      <Heart size={16} strokeWidth={2.5} />
    </span>
  );
}
