import { applyBrandColor } from '@health-buddy/ui';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import loginStyles from './auth/LoginPage.module.css';
import { AdminShell } from './shell/AdminShell';
import { ManagerNotice } from './shell/ManagerNotice';
import { ThresholdsPage } from './thresholds/ThresholdsPage';

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

  // 协会管理员按所属运营商换品牌色；退出后恢复默认。
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

  const onLogout = () => void logout();
  // 健管师不使用后台，引导回工作台。真正的权限由后端按角色控制，这里只决定显示什么。
  if (state.user.role === 'manager') return <ManagerNotice onLogout={onLogout} />;

  return (
    <AdminShell user={state.user} onLogout={onLogout}>
      <ThresholdsPage user={state.user} />
    </AdminShell>
  );
}
