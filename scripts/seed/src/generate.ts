import type { MonitoringMetricCode, ReportIndicatorCode } from '@health-buddy/shared';
import { Random, round } from './random.js';

/**
 * 生成一套完全虚构的演示数据，不连接数据库。
 * 规模（规格第六节）：2 个协会，每个协会 1 个机构、3 名健管师，每名健管师 10 位客户；
 * 每位客户 2 到 3 份体检报告和最近 30 天的监测数据。
 */

export const DEMO_EMAIL_DOMAIN = 'demo.healthbuddy.test';
/** 演示协会的 slug。重新生成时只清理这些协会的数据，不碰其他任何数据。 */
export const DEMO_OPERATOR_SLUGS = ['demo-assoc-a', 'demo-assoc-b'] as const;
export const SYNTHETIC_LABEL = '（测试）';

export type Profile = 'healthy' | 'prediabetes' | 'hypertension' | 'dyslipidemia' | 'overweight';

export interface DemoReading {
  metric: MonitoringMetricCode;
  value: number;
  measuredAt: Date;
}

export interface DemoReport {
  reportDate: string;
  title: string;
  indicators: Partial<Record<ReportIndicatorCode, number>>;
}

export interface DemoClient {
  displayName: string;
  gender: 'female' | 'male';
  birthYear: number;
  profile: Profile;
  reports: DemoReport[];
  readings: DemoReading[];
}

export interface DemoAccount {
  email: string;
  displayName: string;
}

export interface DemoManager extends DemoAccount {
  clients: DemoClient[];
}

export interface DemoOperator {
  slug: (typeof DEMO_OPERATOR_SLUGS)[number];
  name: string;
  brandColor: string;
  admin: DemoAccount;
  org: { name: string; admin: DemoAccount; managers: DemoManager[] };
}

export interface GenerateOptions {
  seed?: number;
  /** 以哪一天为“今天”，监测数据是这天之前的 30 天 */
  today?: Date;
  managersPerOrg?: number;
  clientsPerManager?: number;
}

const SURNAMES = [
  '王',
  '李',
  '张',
  '刘',
  '陈',
  '杨',
  '黄',
  '赵',
  '吴',
  '周',
  '徐',
  '孙',
  '马',
  '朱',
  '胡',
  '林',
  '郭',
  '何',
  '高',
  '罗',
];
const GIVEN_FEMALE = [
  '秀英',
  '桂兰',
  '丽华',
  '淑珍',
  '美玲',
  '雅婷',
  '慧敏',
  '晓燕',
  '静怡',
  '佩琪',
];
const GIVEN_MALE = ['建国', '志强', '国华', '德明', '伟杰', '家豪', '俊宏', '文斌', '永康', '嘉明'];
const PROFILES: readonly Profile[] = [
  'healthy',
  'prediabetes',
  'hypertension',
  'dyslipidemia',
  'overweight',
];

const OPERATORS = [
  { slug: 'demo-assoc-a', key: 'a', name: '测试协会A', brandColor: '#0e7c6b', org: '测试机构A' },
  { slug: 'demo-assoc-b', key: 'b', name: '测试协会B', brandColor: '#2f6fbf', org: '测试机构B' },
] as const;

export function generateDemoData(options: GenerateOptions = {}): DemoOperator[] {
  const rng = new Random(options.seed ?? 20261015);
  const today = startOfDay(options.today ?? new Date());
  const managersPerOrg = options.managersPerOrg ?? 3;
  const clientsPerManager = options.clientsPerManager ?? 10;

  return OPERATORS.map((op) => ({
    slug: op.slug,
    name: op.name,
    brandColor: op.brandColor,
    admin: {
      email: `admin-${op.key}@${DEMO_EMAIL_DOMAIN}`,
      displayName: `${op.name}管理员${SYNTHETIC_LABEL}`,
    },
    org: {
      name: op.org,
      admin: {
        email: `org-${op.key}@${DEMO_EMAIL_DOMAIN}`,
        displayName: `${op.org}管理员${SYNTHETIC_LABEL}`,
      },
      managers: Array.from({ length: managersPerOrg }, (_, m) => ({
        email: `manager-${op.key}${m + 1}@${DEMO_EMAIL_DOMAIN}`,
        displayName: `${personName(rng, rng.next() < 0.5 ? 'female' : 'male')}${SYNTHETIC_LABEL}`,
        clients: Array.from({ length: clientsPerManager }, () => makeClient(rng, today)),
      })),
    },
  }));
}

function personName(rng: Random, gender: 'female' | 'male'): string {
  return rng.pick(SURNAMES) + rng.pick(gender === 'female' ? GIVEN_FEMALE : GIVEN_MALE);
}

/** 每种画像在基线上的偏移，让数据有高有低，便于以后测试风险分层和趋势。 */
interface Baseline {
  heightCm: number;
  weightKg: number;
  sbp: number;
  dbp: number;
  fpg: number;
  hba1c: number;
  tc: number;
  tg: number;
  ldl: number;
  hdl: number;
}

function baselineFor(rng: Random, profile: Profile, gender: 'female' | 'male'): Baseline {
  const heightCm = rng.normal(gender === 'female' ? 158 : 170, 5);
  const bmi = profile === 'overweight' ? rng.normal(28, 1.5) : rng.normal(22.5, 1.5);
  return {
    heightCm,
    weightKg: bmi * (heightCm / 100) ** 2,
    sbp: profile === 'hypertension' ? rng.normal(148, 6) : rng.normal(122, 7),
    dbp: profile === 'hypertension' ? rng.normal(94, 4) : rng.normal(78, 5),
    fpg: profile === 'prediabetes' ? rng.normal(6.5, 0.3) : rng.normal(5.1, 0.35),
    hba1c: profile === 'prediabetes' ? rng.normal(6.1, 0.2) : rng.normal(5.4, 0.25),
    tc: profile === 'dyslipidemia' ? rng.normal(6.2, 0.4) : rng.normal(4.6, 0.4),
    tg: profile === 'dyslipidemia' ? rng.normal(2.4, 0.4) : rng.normal(1.2, 0.3),
    ldl: profile === 'dyslipidemia' ? rng.normal(4.0, 0.3) : rng.normal(2.7, 0.3),
    hdl: profile === 'dyslipidemia' ? rng.normal(0.95, 0.1) : rng.normal(1.35, 0.15),
  };
}

function makeClient(rng: Random, today: Date): DemoClient {
  const gender = rng.next() < 0.55 ? 'female' : 'male';
  const profile = rng.pick(PROFILES);
  const base = baselineFor(rng, profile, gender);
  const reportCount = rng.int(2, 3);

  // 报告按年份排列，最近一份在今天之前 1 到 5 个月；指标逐年略有变化
  const latest = addDays(today, -rng.int(30, 150));
  const reports: DemoReport[] = Array.from({ length: reportCount }, (_, i) => {
    const yearsAgo = reportCount - 1 - i;
    const drift = profile === 'healthy' ? 0 : -yearsAgo * 0.04; // 越早的报告越接近正常
    const date = addDays(latest, -365 * yearsAgo);
    const weight = base.weightKg * (1 + drift * 0.5) + rng.normal(0, 0.8);
    return {
      reportDate: isoDate(date),
      title: `${date.getUTCFullYear()} 年度体检${SYNTHETIC_LABEL}`,
      indicators: {
        height: round(base.heightCm, 1),
        weight: round(weight, 1),
        bmi: round(weight / (base.heightCm / 100) ** 2, 1),
        waist: round(weight * 0.95 + rng.normal(10, 3), 1),
        sbp: Math.round(base.sbp * (1 + drift) + rng.normal(0, 4)),
        dbp: Math.round(base.dbp * (1 + drift) + rng.normal(0, 3)),
        fpg: round(base.fpg * (1 + drift) + rng.normal(0, 0.2), 2),
        hba1c: round(base.hba1c * (1 + drift * 0.5) + rng.normal(0, 0.1), 1),
        tc: round(base.tc * (1 + drift) + rng.normal(0, 0.2), 2),
        tg: round(Math.max(0.4, base.tg * (1 + drift) + rng.normal(0, 0.2)), 2),
        ldl_c: round(base.ldl * (1 + drift) + rng.normal(0, 0.15), 2),
        hdl_c: round(base.hdl + rng.normal(0, 0.08), 2),
        alt: Math.round(Math.max(8, rng.normal(profile === 'overweight' ? 42 : 24, 8))),
        ast: Math.round(Math.max(10, rng.normal(24, 6))),
        creatinine: Math.round(rng.normal(gender === 'female' ? 65 : 85, 10)),
        uric_acid: Math.round(rng.normal(gender === 'female' ? 300 : 380, 50)),
      },
    };
  });

  const readings: DemoReading[] = [];
  const trackGlucose = profile === 'prediabetes';
  const trackBp = profile === 'hypertension' || rng.next() < 0.6;
  for (let d = 30; d >= 1; d--) {
    const day = addDays(today, -d);
    // 偶尔漏记，更像真实数据
    if (rng.next() < 0.1) continue;
    const morning = atHour(day, 7, rng.int(0, 59));
    if (trackBp) {
      readings.push(
        { metric: 'sbp', value: Math.round(base.sbp + rng.normal(0, 6)), measuredAt: morning },
        { metric: 'dbp', value: Math.round(base.dbp + rng.normal(0, 4)), measuredAt: morning },
        { metric: 'heart_rate', value: Math.round(rng.normal(72, 6)), measuredAt: morning },
      );
    }
    if (trackGlucose)
      readings.push({
        metric: 'fpg',
        value: round(base.fpg + rng.normal(0, 0.3), 1),
        measuredAt: morning,
      });
    readings.push(
      {
        metric: 'weight',
        value: round(base.weightKg + rng.normal(0, 0.4) - (30 - d) * 0.01, 1),
        measuredAt: morning,
      },
      {
        metric: 'steps',
        value: Math.max(500, Math.round(rng.normal(profile === 'overweight' ? 5000 : 7500, 2000))),
        measuredAt: atHour(day, 22, 0),
      },
      {
        metric: 'sleep_hours',
        value: round(Math.min(10, Math.max(4, rng.normal(6.8, 0.8))), 1),
        measuredAt: morning,
      },
    );
  }

  return {
    displayName: `${personName(rng, gender)}${SYNTHETIC_LABEL}`,
    gender,
    birthYear: today.getUTCFullYear() - rng.int(32, 72),
    profile,
    reports,
    readings,
  };
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
function atHour(d: Date, hour: number, minute: number): Date {
  return new Date(d.getTime() + (hour * 60 + minute) * 60_000);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
