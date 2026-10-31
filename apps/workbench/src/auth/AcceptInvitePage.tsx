import {
  PASSWORD_MIN,
  PRODUCT_NAME,
  acceptInviteResponseSchema,
  type Role,
} from '@health-buddy/shared';
import { Button } from '@health-buddy/ui';
import { Heart } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiRequest } from '../api/http';
import styles from './LoginPage.module.css';

const INVITE_HASH = /^#\/invite\/([A-Za-z0-9_-]{43})$/;

/** 地址栏里的邀请令牌（#/invite/<令牌>），没有返回 null */
export function inviteTokenFromHash(hash: string = window.location.hash): string | null {
  return INVITE_HASH.exec(hash)?.[1] ?? null;
}

type Problem = 'mismatch' | 'too_short' | 'expired' | 'too_many_requests' | 'network' | 'unknown';

/**
 * 接受邀请、设置密码（M7 规格 2.4）。打开后令牌从地址栏清掉，只留在内存里；
 * 链接无效、过期或已用过时统一提示联系管理员重发（后端不区分原因）。
 * 健管师设好后回到工作台登录；管理员账号引导去后台登录。
 */
export function AcceptInvitePage({ token }: { token: string }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [doneRole, setDoneRole] = useState<Role | null>(null);

  // 令牌只留在内存里：一打开就从地址栏和浏览历史里清掉（租户审查 S7）
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) {
      setProblem('too_short');
      return;
    }
    if (password !== confirm) {
      setProblem('mismatch');
      return;
    }
    setBusy(true);
    setProblem(null);
    apiRequest('/auth/invite/accept', acceptInviteResponseSchema, {
      method: 'POST',
      body: { token, password },
    })
      .then(({ role }) => setDoneRole(role))
      .catch((err: unknown) => {
        setProblem(
          err instanceof ApiError
            ? err.code === 'invite_expired'
              ? 'expired'
              : err.code === 'too_many_requests' || err.code === 'network'
                ? err.code
                : 'unknown'
            : 'unknown',
        );
        setBusy(false);
      });
  };

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={submit} noValidate>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <Heart size={20} strokeWidth={2.5} />
          </span>
          <span>{PRODUCT_NAME}</span>
        </div>
        <h1 className={styles.title}>{t('invite.title')}</h1>
        {doneRole ? (
          <>
            <p className={styles.subtitle} role="status">
              {t('invite.done')}
            </p>
            <Button
              variant="primary"
              block
              onClick={() => window.location.assign(doneRole === 'manager' ? '/' : '/admin/')}
            >
              {doneRole === 'manager' ? t('invite.goToLogin') : t('invite.goToAdmin')}
            </Button>
          </>
        ) : (
          <>
            <p className={styles.subtitle}>{t('invite.subtitle', { min: PASSWORD_MIN })}</p>
            <label className={styles.field}>
              <span>{t('invite.password')}</span>
              <input
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>{t('invite.confirm')}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {problem && (
              <p className={styles.error} role="alert">
                {t(`invite.errors.${problem}`, { min: PASSWORD_MIN })}
              </p>
            )}
            <Button type="submit" variant="primary" block disabled={busy}>
              {busy ? t('invite.submitting') : t('invite.submit')}
            </Button>
          </>
        )}
      </form>
    </main>
  );
}
