import {
  REPORT_INDICATORS,
  type MonitoringMetricCode,
  type ReportIndicatorCode,
} from '@health-buddy/shared';
import { Random, round } from './random.js';

/**
 * 生成一套完全虚构的演示数据，不连接数据库。
 * 规模（规格第六节）：2 个协会，每个协会 1 个机构、3 名健管师，每名健管师 10 位客户；
 * 每位客户 2 到 3 份体检报告和最近 30 天的监测数据。
 *
 * M4 数字孪生（规格 6.2）：每个协会第一位健管师的前 5 位客户换成“孪生演示客户”，
 * 有 4 份以上带参考范围的历次报告和 26 周的监测数据，分别是平稳、缓慢变差、变好、波动大、
 * 数据不足五类，让红黄绿灰和趋势预测都有内容可看。
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
  /** 报告上印的参考范围（M2 Q10）；M0 的合成报告没有，孪生演示客户的报告有 */
  references?: Partial<Record<ReportIndicatorCode, { low: number | null; high: number | null }>>;
}

/**
 * 孪生演示客户的类型（M4 规格 6.2）：
 * - stable：平稳，四个方面都是绿；
 * - worsening：缓慢变差，代谢黄（空腹血糖超出参考范围），心血管红（最近一次血压达到危急阈值）；
 * - improving：变好，体重在下降但 BMI 仍高于参考范围（体重黄）；
 * - volatile：波动大，血压周平均起伏大（心血管黄，预测不确定性高）；
 * - sparse：只有一份 15 个月前的报告、没有监测（四个方面都是灰，不预测）。
 */
export const TWIN_SCENARIOS = ['stable', 'worsening', 'improving', 'volatile', 'sparse'] as const;
export type TwinScenario = (typeof TWIN_SCENARIOS)[number];

export interface DemoClient {
  displayName: string;
  gender: 'female' | 'male';
  birthYear: number;
  profile: Profile;
  reports: DemoReport[];
  readings: DemoReading[];
  /** 孪生演示客户的类型；普通演示客户没有 */
  twinScenario?: TwinScenario;
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

  return OPERATORS.map((op, opIndex) => ({
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
      managers: Array.from({ length: managersPerOrg }, (_, m) => {
        const manager = {
          email: `manager-${op.key}${m + 1}@${DEMO_EMAIL_DOMAIN}`,
          displayName: `${personName(rng, rng.next() < 0.5 ? 'female' : 'male')}${SYNTHETIC_LABEL}`,
          clients: Array.from({ length: clientsPerManager }, () => makeClient(rng, today)),
        };
        // 孪生演示客户用单独的随机数，不影响其余演示数据（重新生成时普通客户保持不变）
        if (m === 0) {
          const twinRng = new Random((options.seed ?? 20261015) + 4000 + opIndex);
          TWIN_SCENARIOS.forEach((scenario, i) => {
            if (i < manager.clients.length)
              manager.clients[i] = makeTwinClient(twinRng, today, scenario);
          });
        }
        return manager;
      }),
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

/** 报告上印的参考范围：孪生演示客户的报告按指标目录的成人范围印 */
const PRINTED_REFERENCES = Object.fromEntries(
  REPORT_INDICATORS.flatMap((d) => {
    const def = d as { code: ReportIndicatorCode; refLow?: number; refHigh?: number };
    if (def.refLow === undefined && def.refHigh === undefined) return [];
    return [[def.code, { low: def.refLow ?? null, high: def.refHigh ?? null }]];
  }),
) as Partial<Record<ReportIndicatorCode, { low: number | null; high: number | null }>>;

/** 孪生演示客户的各项指标：起点（最早一份报告）和终点（最近一份），中间线性变化 */
interface TwinTrack {
  start: number;
  end: number;
  /** 报告间的随机波动 */
  sd: number;
  digits: number;
}

const TWIN_REPORTS: Record<
  Exclude<TwinScenario, 'sparse'>,
  Partial<Record<ReportIndicatorCode, TwinTrack>>
> = {
  stable: {
    fpg: { start: 5.0, end: 5.1, sd: 0.1, digits: 2 },
    hba1c: { start: 5.3, end: 5.3, sd: 0.05, digits: 1 },
    tc: { start: 4.5, end: 4.6, sd: 0.1, digits: 2 },
    tg: { start: 1.1, end: 1.1, sd: 0.08, digits: 2 },
    ldl_c: { start: 2.6, end: 2.6, sd: 0.08, digits: 2 },
    hdl_c: { start: 1.4, end: 1.4, sd: 0.05, digits: 2 },
    uric_acid: { start: 320, end: 325, sd: 8, digits: 0 },
    sbp: { start: 118, end: 119, sd: 2, digits: 0 },
    dbp: { start: 76, end: 76, sd: 2, digits: 0 },
    weight: { start: 58, end: 58.3, sd: 0.3, digits: 1 },
    waist: { start: 74, end: 74, sd: 0.5, digits: 1 },
  },
  worsening: {
    fpg: { start: 5.4, end: 6.6, sd: 0.05, digits: 2 },
    hba1c: { start: 5.5, end: 5.9, sd: 0.05, digits: 1 },
    tc: { start: 4.8, end: 5.0, sd: 0.08, digits: 2 },
    tg: { start: 1.3, end: 1.6, sd: 0.05, digits: 2 },
    ldl_c: { start: 2.9, end: 3.2, sd: 0.05, digits: 2 },
    hdl_c: { start: 1.2, end: 1.1, sd: 0.03, digits: 2 },
    uric_acid: { start: 360, end: 400, sd: 8, digits: 0 },
    sbp: { start: 128, end: 146, sd: 1.5, digits: 0 },
    dbp: { start: 80, end: 88, sd: 1, digits: 0 },
    weight: { start: 68, end: 70, sd: 0.3, digits: 1 },
    waist: { start: 86, end: 89, sd: 0.5, digits: 1 },
  },
  improving: {
    fpg: { start: 5.6, end: 5.3, sd: 0.08, digits: 2 },
    hba1c: { start: 5.7, end: 5.5, sd: 0.05, digits: 1 },
    tc: { start: 5.0, end: 4.7, sd: 0.08, digits: 2 },
    tg: { start: 1.6, end: 1.3, sd: 0.05, digits: 2 },
    ldl_c: { start: 3.2, end: 2.9, sd: 0.05, digits: 2 },
    hdl_c: { start: 1.1, end: 1.25, sd: 0.03, digits: 2 },
    uric_acid: { start: 390, end: 350, sd: 8, digits: 0 },
    sbp: { start: 132, end: 124, sd: 1.5, digits: 0 },
    dbp: { start: 84, end: 79, sd: 1, digits: 0 },
    weight: { start: 86, end: 78, sd: 0.3, digits: 1 },
    waist: { start: 98, end: 91, sd: 0.5, digits: 1 },
  },
  volatile: {
    fpg: { start: 5.2, end: 5.2, sd: 0.3, digits: 2 },
    hba1c: { start: 5.4, end: 5.4, sd: 0.1, digits: 1 },
    tc: { start: 4.7, end: 4.7, sd: 0.2, digits: 2 },
    tg: { start: 1.3, end: 1.3, sd: 0.2, digits: 2 },
    ldl_c: { start: 2.8, end: 2.8, sd: 0.15, digits: 2 },
    hdl_c: { start: 1.3, end: 1.3, sd: 0.08, digits: 2 },
    uric_acid: { start: 340, end: 340, sd: 25, digits: 0 },
    sbp: { start: 132, end: 134, sd: 10, digits: 0 },
    dbp: { start: 82, end: 84, sd: 6, digits: 0 },
    weight: { start: 64, end: 64, sd: 1.5, digits: 1 },
    waist: { start: 80, end: 80, sd: 1, digits: 1 },
  },
};

/** 孪生演示客户的身高（cm），用来算 BMI */
const TWIN_HEIGHT: Record<TwinScenario, number> = {
  stable: 160,
  worsening: 168,
  improving: 172,
  volatile: 165,
  sparse: 158,
};

/** 孪生演示客户的监测时长：26 周（M4 规格 6.2，预测 6 个月需要 26 个有效周） */
export const TWIN_MONITORING_DAYS = 182;

function makeTwinClient(rng: Random, today: Date, scenario: TwinScenario): DemoClient {
  const gender: 'female' | 'male' =
    scenario === 'stable' || scenario === 'sparse' ? 'female' : 'male';
  const heightCm = TWIN_HEIGHT[scenario];
  const bmiOf = (w: number) => round(w / (heightCm / 100) ** 2, 1);
  const base = {
    displayName: `${personName(rng, gender)}${SYNTHETIC_LABEL}`,
    gender,
    birthYear: today.getUTCFullYear() - 45 - TWIN_SCENARIOS.indexOf(scenario) * 4,
    profile: (scenario === 'worsening'
      ? 'hypertension'
      : scenario === 'improving'
        ? 'overweight'
        : 'healthy') as Profile,
    twinScenario: scenario,
  };

  if (scenario === 'sparse') {
    // 只有一份 15 个月前的报告，没有监测：报告过期，四个方面都是灰
    const date = addMonths(today, -15);
    return {
      ...base,
      reports: [
        {
          reportDate: isoDate(date),
          title: `${date.getUTCFullYear()} 年度体检${SYNTHETIC_LABEL}`,
          indicators: { height: heightCm, weight: 55, bmi: bmiOf(55), fpg: 5.2, sbp: 122, dbp: 78 },
          references: PRINTED_REFERENCES,
        },
      ],
      readings: [],
    };
  }

  // 4 份报告，每半年一份，最近一份在 1 个月前：跨度 18 个月，可以预测 3 个月和 6 个月
  const tracks = TWIN_REPORTS[scenario];
  const reports: DemoReport[] = [0, 1, 2, 3].map((i) => {
    const date = addMonths(today, -1 - (3 - i) * 6);
    const indicators: Partial<Record<ReportIndicatorCode, number>> = { height: heightCm };
    for (const [code, t] of Object.entries(tracks) as [ReportIndicatorCode, TwinTrack][]) {
      // 波动大：报告之间交替偏高偏低
      const swing = scenario === 'volatile' ? (i % 2 === 0 ? -1 : 1) * t.sd : rng.normal(0, t.sd);
      indicators[code] = round(t.start + ((t.end - t.start) * i) / 3 + swing, t.digits);
    }
    indicators.bmi = bmiOf(indicators.weight ?? 60);
    return {
      reportDate: isoDate(date),
      title: `${date.getUTCFullYear()} 年体检（${i + 1}）${SYNTHETIC_LABEL}`,
      indicators,
      references: PRINTED_REFERENCES,
    };
  });

  // 26 周每天早上的监测：血压、心率、体重、睡眠、步数；变差的客户另测空腹血糖
  const readings: DemoReading[] = [];
  const days = TWIN_MONITORING_DAYS;
  const lerp = (a: number, b: number, d: number) => a + ((b - a) * (days - d)) / (days - 1);
  for (let d = days; d >= 1; d--) {
    const day = addDays(today, -d);
    const morning = atHour(day, 7, rng.int(0, 30));
    const week = Math.floor((d - 1) / 7);
    let sbp: number;
    let dbp: number;
    let weight: number;
    switch (scenario) {
      case 'stable':
        sbp = rng.normal(118, 4);
        dbp = rng.normal(76, 3);
        weight = rng.normal(58.2, 0.3);
        break;
      case 'worsening':
        sbp = lerp(132, 150, d) + rng.normal(0, 3);
        dbp = lerp(82, 90, d) + rng.normal(0, 2);
        weight = lerp(69, 70.5, d) + rng.normal(0, 0.3);
        break;
      case 'improving':
        sbp = lerp(128, 122, d) + rng.normal(0, 3);
        dbp = lerp(82, 78, d) + rng.normal(0, 2);
        weight = lerp(80.5, 77.5, d) + rng.normal(0, 0.3);
        break;
      case 'volatile':
        // 按周大幅起伏：最近一周偏高
        sbp = 140 + (week % 2 === 0 ? 15 : -15) + rng.normal(0, 4);
        dbp = 86 + (week % 2 === 0 ? 6 : -6) + rng.normal(0, 3);
        weight = 64 + (week % 2 === 0 ? 1.5 : -1.5) + rng.normal(0, 0.4);
        break;
    }
    readings.push(
      { metric: 'sbp', value: Math.round(sbp), measuredAt: morning },
      { metric: 'dbp', value: Math.round(dbp), measuredAt: morning },
      { metric: 'heart_rate', value: Math.round(rng.normal(70, 4)), measuredAt: morning },
      { metric: 'weight', value: round(weight, 1), measuredAt: morning },
      {
        metric: 'sleep_hours',
        value: round(Math.min(9, Math.max(5, rng.normal(7, 0.5))), 1),
        measuredAt: morning,
      },
      {
        metric: 'steps',
        value: Math.max(500, Math.round(rng.normal(7000, 1500))),
        measuredAt: atHour(day, 22, 0),
      },
    );
    if (scenario === 'worsening' && d % 7 < 4)
      readings.push({
        metric: 'fpg',
        value: round(lerp(5.8, 6.6, d) + rng.normal(0, 0.15), 1),
        measuredAt: morning,
      });
  }
  // 缓慢变差的客户：昨晚一次血压达到危急阈值（M1 urgent ≥ 180），心血管为红
  if (scenario === 'worsening')
    readings.push({ metric: 'sbp', value: 182, measuredAt: atHour(addDays(today, -1), 21, 0) });

  return { ...base, reports, readings };
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(d.getUTCDate(), last));
  return r;
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
