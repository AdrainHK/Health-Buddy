import type { CurrentUser } from '@health-buddy/shared';
import { applyBrandColor } from '@health-buddy/ui';
import { Activity, BarChart3, Bot, HeartPulse, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import loginStyles from './auth/LoginPage.module.css';
import { ExpertStatsPage } from './experts/ExpertStatsPage';
import { ExpertsPage } from './experts/ExpertsPage';
import { AdminShell, type AdminSection } from './shell/AdminShell';
import { ManagerNotice } from './shell/ManagerNotice';
import { ThresholdsPage } from './thresholds/ThresholdsPage';
import { TwinRulesPage } from './twin-rules/TwinRulesPage';
import { TwinStatsPage } from './twin-rules/TwinStatsPage';

type SectionId = 'critical-thresholds' | 'twin-rules' | 'experts' | 'expert-stats' | 'twin-stats';

/**
 * 各角色能看到的版块。危急指标、孪生状态规则：所有后台角色（只有平台能改，M4 规格 2.10）；
 * 专家管理：只有平台管理员（Q11）；专家统计、孪生统计：平台和协会管理员（M3 规格 1.3、M4 规格 7.2）。
 * 界面只决定显示什么，权限在后端。
 */
function sectionsFor(role: CurrentUser['role']): SectionId[] {
  if (role === 'platform_admin')
    return ['critical-thresholds', 'twin-rules', 'experts', 'expert-stats', 'twin-stats'];
  if (role === 'operator_admin')
    return ['critical-thresholds', 'twin-rules', 'expert-stats', 'twin-stats'];
  return ['critical-thresholds', 'twin-rules'];
}

const ICONS: Record<SectionId, ReactNode> = {
  'critical-thresholds': <ShieldAlert size={16} aria-hidden />,
  'twin-rules': <HeartPulse size={16} aria-hidden />,
  experts: <Bot size={16} aria-hidden />,
  'expert-stats': <BarChart3 size={16} aria-hidden />,
  'twin-stats': <Activity size={16} aria-hidden />,
};

function hashSection(): string {
  return window.location.hash.replace(/^#/, '');
}

/** 按地址栏的 #锚点切换版块；锚点不是当前角色能看的版块时显示第一个 */
function useSection(allowed: readonly SectionId[]): SectionId {
  const [hash, setHash] = useState(hashSection);
  useEffect(() => {
    const onChange = () => setHash(hashSection());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return allowed.find((id) => id === hash) ?? allowed[0]!;
}

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

  return <Console user={state.user} onLogout={onLogout} />;
}

function Console({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const { t } = useTranslation();
  const allowed = sectionsFor(user.role);
  const current = useSection(allowed);
  const label: Record<SectionId, string> = {
    'critical-thresholds': t('thresholds.nav'),
    'twin-rules': t('twinRules.nav'),
    experts: t('experts.nav'),
    'expert-stats': t('expertStats.nav'),
    'twin-stats': t('twinStats.nav'),
  };
  const sections: AdminSection[] = allowed.map((id) => ({
    id,
    label: label[id],
    icon: ICONS[id],
  }));
  return (
    <AdminShell user={user} onLogout={onLogout} sections={sections} current={current}>
      {current === 'critical-thresholds' && <ThresholdsPage user={user} />}
      {current === 'twin-rules' && <TwinRulesPage user={user} />}
      {current === 'experts' && <ExpertsPage user={user} />}
      {current === 'expert-stats' && <ExpertStatsPage user={user} />}
      {current === 'twin-stats' && <TwinStatsPage user={user} />}
    </AdminShell>
  );
}
