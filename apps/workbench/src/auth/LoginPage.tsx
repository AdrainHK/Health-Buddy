import type { PublicBrand } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchPublicBrand } from '../api/brand';
import { ApiError } from '../api/http';
import { BrandMark } from '../brand/BrandMark';
import { applyOperatorColor } from '../brand/brand';
import { useAuth } from './AuthContext';
import styles from './LoginPage.module.css';

type LoginError = 'invalid_credentials' | 'too_many_requests' | 'network' | 'unknown';

function toLoginError(err: unknown): LoginError {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials' || err.code === 'bad_request')
      return 'invalid_credentials';
    if (err.code === 'too_many_requests' || err.code === 'network') return err.code;
  }
  return 'unknown';
}

/**
 * 登录页。地址是协会登录地址（/#/login/<简称>，Q4）时显示协会的 Logo、名称、欢迎语和主色；
 * 识别不出协会或品牌读取失败时显示 Health Buddy 默认品牌，不影响登录。
 */
export function LoginPage({ slug = null }: { slug?: string | null }) {
  const { t } = useTranslation();
  const [brand, setBrand] = useState<PublicBrand | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetchPublicBrand(slug)
      .then((b) => {
        if (cancelled) return;
        setBrand(b);
        applyOperatorColor(b.primaryColor);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      applyOperatorColor(null);
    };
  }, [slug]);
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(toLoginError(err));
      setPassword('');
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={onSubmit} noValidate={false}>
        <div className={styles.brand} data-testid="login-brand">
          <BrandMark
            name={brand?.name ?? null}
            logoUrl={brand?.logoUrl ?? null}
            logoClass={styles.logo}
            imageClass={styles.logoImage}
          />
        </div>
        <h1 className={styles.title}>{t('auth.title')}</h1>
        <p className={styles.subtitle}>{brand?.loginGreeting ?? t('auth.subtitle')}</p>

        <label className={styles.field}>
          <span>{t('auth.email')}</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>{t('auth.password')}</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {t(`auth.errors.${error}`)}
          </p>
        )}

        <Button type="submit" variant="primary" block disabled={submitting}>
          {submitting ? t('auth.submitting') : t('auth.submit')}
        </Button>
      </form>
    </main>
  );
}
