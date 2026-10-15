import { PRODUCT_NAME } from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Heart } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';
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

/** 后台登录页。和工作台共用 /api/auth 接口和会话。 */
export function LoginPage() {
  const { t } = useTranslation();
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
      <form className={styles.card} onSubmit={onSubmit}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Heart size={20} strokeWidth={2.5} />
          </span>
          <span>{PRODUCT_NAME}</span>
        </div>
        <h1 className={styles.title}>{t('auth.title')}</h1>
        <p className={styles.subtitle}>{t('auth.subtitle')}</p>

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
