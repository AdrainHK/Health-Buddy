import { applyBrandColor } from '@health-buddy/ui';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import loginStyles from './auth/LoginPage.module.css';
import { AppShell } from './shell/AppShell';

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate() {
  const { t } = useTranslation();
  const { state, logout } = useAuth();
  const brandColor = state.status === 'authenticated' ? state.user.operator?.brandColor : null;

  // 登录后按所属运营商换品牌色；退出后恢复默认。
  useEffect(() => {
    if (brandColor) applyBrandColor(brandColor);
    return () => {
      document.documentElement.style.removeProperty('--hb-brand');
    };
  }, [brandColor]);

  if (state.status === 'loading') {
    return (
      <div className={loginStyles.splash} role="status">
        {t('auth.loading')}
      </div>
    );
  }
  if (state.status === 'anonymous') return <LoginPage />;
  return <AppShell account={{ name: state.user.displayName, onLogout: () => void logout() }} />;
}
