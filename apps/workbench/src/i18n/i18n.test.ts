import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ABNORMAL_FLAGS,
  CONSULTATION_STATUSES,
  DISCLAIMER,
  FOLLOW_UP_DISMISS_REASONS,
  FOLLOW_UP_KINDS,
  FOLLOW_UP_RESOLUTIONS,
  TWIN_DOMAINS,
  TWIN_LEVELS,
  TWIN_STATUS_ORIGINS,
  TWIN_TIMELINE_TYPES,
  CRISIS_NOTICE,
  EMERGENCY_NOTICE,
  EXPERT_DISCLAIMER,
  findBannedTerms,
  CONSULTATION_TRIGGERS,
  EXPERT_CALL_STATUSES,
  EXPERT_FAILURE_CATEGORIES,
  SUGGESTION_CATEGORIES,
  SOURCE_PRIORITIES,
  SOURCE_SCOPES,
  SOURCE_STATUSES,
  EXTRACTED_VALUE_FLAGS,
  EXTRACTION_FAILURE_CATEGORIES,
  HEALTH_HISTORY_CATEGORIES,
  REPORT_UPLOAD_STATUSES,
  RISK_TIERS,
  VERIFY_REJECTION_REASONS,
  streamErrorKindSchema,
  ALLERGENS,
  CARE_PLAN_END_REASONS,
  CARE_PLAN_STATUSES,
  EXERCISE_CATEGORIES,
  EXERCISE_INTENSITIES,
  EXERCISE_SETTINGS,
  GOAL_METRICS,
  LIBRARY_TAGS,
  MEAL_TYPES,
  PLAN_SECTIONS,
  VISIT_CANCEL_REASONS,
  VISIT_FEEDBACK_TOPICS,
  VISIT_METHODS,
  VISIT_PURPOSES,
  VISIT_STATUSES,
} from '@health-buddy/shared';
import zhCN from './locales/zh-CN.json';

/**
 * 验收标准 25：所有界面文字走 i18n。
 * 1. 组件和逻辑代码里（注释除外）不出现中文，界面文字只在 locales 里；
 * 2. 服务端下发、编译期不知道的键（步骤、技能名）和契约里的枚举值，在词条里都有翻译。
 */

const SRC = join(__dirname, '..');
const HAN = /\p{Script=Han}/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'i18n' || name === 'test' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** 去掉注释：块注释、JSX 注释和行注释（不处理字符串里的 //，代码里本来就不该有中文） */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[part];
    return undefined;
  }, zhCN);
}

describe('界面文字走 i18n（验收标准 25）', () => {
  it('组件和逻辑代码里没有写死的中文', () => {
    const files = sourceFiles(SRC);
    // 确实扫到了各个界面目录（档案、核对、对话、结果区）
    for (const dir of ['record', 'reports', 'chat', 'artifacts', 'shell', 'experts', 'twin'])
      expect(
        files.some((f) => relative(SRC, f).startsWith(dir)),
        dir,
      ).toBe(true);
    const offenders = files.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, i) => (HAN.test(line) ? [`${relative(SRC, file)}:${i + 1}`] : [])),
    );
    expect(offenders).toEqual([]);
  });

  it('专家详情的来源清单：文件名一列叫“来源文件原名”，优先级、使用范围、确认状态都有词条（M3 合规复审 C）', () => {
    expect(lookup('experts.sources.columns.name')).toBe('来源文件原名');
    for (const p of SOURCE_PRIORITIES)
      expect(typeof lookup(`experts.sources.priority.${p}`), `priority ${p}`).toBe('string');
    for (const v of SOURCE_SCOPES)
      expect(typeof lookup(`experts.sources.scope.${v}`), v).toBe('string');
    for (const v of SOURCE_STATUSES)
      expect(typeof lookup(`experts.sources.status.${v}`), v).toBe('string');
  });

  it('服务端下发的步骤和技能名都有词条', () => {
    // 与 apps/server 和 packages/skills 里的 labelKey、技能 id、计划 id 对应
    const keys = [
      'steps.readClient',
      'steps.readReport',
      'steps.compareReports',
      'steps.detectCritical',
      'steps.runSkill',
      'steps.generateInterpretation',
      'steps.generateOutline',
      'steps.answer',
      'steps.routeExperts',
      'steps.consultExpert',
      'steps.consultExperts',
      'steps.reuseExperts',
      'steps.synthesizeExperts',
      'steps.readTwin',
      'steps.computeForecast',
      'steps.generateTwinSummary',
      'steps.readCarePlan',
      'steps.scheduleVisits',
      'steps.generateVisitSchedule',
      'steps.selectLibraryItems',
      'steps.generateCarePlan',
      'skills.client-recent-summary.name',
      'skills.report-interpretation.name',
      'skills.interview-outline.name',
      'skills.new-client-assessment.name',
      'skills.twin-summary.name',
      'skills.twin-review.name',
      'skills.visit-schedule.name',
      'skills.care-plan.name',
    ];
    for (const key of keys) expect(typeof lookup(key), key).toBe('string');
  });

  it('契约里的枚举值都有翻译：识别状态、失败类别、标记、确认被拒原因、高低、分层、健康史类别、流错误', () => {
    const groups: [string, readonly string[]][] = [
      ['reports.status', REPORT_UPLOAD_STATUSES],
      ['reports.failure', EXTRACTION_FAILURE_CATEGORIES],
      ['reports.flags', EXTRACTED_VALUE_FLAGS],
      ['reports.verify', VERIFY_REJECTION_REASONS],
      ['reports.abnormal', ABNORMAL_FLAGS],
      ['record.tier.levels', RISK_TIERS],
      ['record.history.categories', HEALTH_HISTORY_CATEGORIES],
      ['chat.streamErrors', streamErrorKindSchema.options],
      // M3：专家调用状态、失败类别、触发方式、建议类别
      ['experts.call.status', EXPERT_CALL_STATUSES],
      ['experts.call.failure', EXPERT_FAILURE_CATEGORIES],
      ['experts.trigger', CONSULTATION_TRIGGERS],
      ['experts.tab.status', CONSULTATION_STATUSES],
      ['experts.tab.suggestionCategory', SUGGESTION_CATEGORIES],
    ];
    for (const [prefix, values] of groups) {
      for (const v of values) {
        const text = lookup(`${prefix}.${v}`);
        expect(typeof text, `${prefix}.${v}`).toBe('string');
        expect(String(text).length, `${prefix}.${v}`).toBeGreaterThan(0);
      }
    }
  });

  it('专家相关的词条里没有禁用词（合规审查第 4 条）', () => {
    const strings = (node: unknown, path: string): [string, string][] =>
      typeof node === 'string'
        ? [[path, node]]
        : node && typeof node === 'object'
          ? Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`))
          : [];
    const roots = [
      'experts',
      'chat.experts',
      'results.artifacts.experts',
      'results.artifacts.signals',
      'signals',
    ];
    const all = roots.flatMap((root) => strings(lookup(root), root));
    expect(all.length).toBeGreaterThan(50);
    const issues = all.flatMap(([path, text]) =>
      findBannedTerms(text).map((issue) => `${path}: ${issue.term}`),
    );
    expect(issues).toEqual([]);
  });

  it('专家意见的提示语和后端拼接的 EXPERT_DISCLAIMER 一字不差', () => {
    expect(lookup('experts.bound.note')).toBe(EXPERT_DISCLAIMER);
    expect(lookup('experts.tab.note')).toBe(EXPERT_DISCLAIMER);
  });

  it('危机、急症提示只有一组词条，和后端的 CRISIS_NOTICE、EMERGENCY_NOTICE 一字不差（合规审查第 5 条）', () => {
    expect(lookup('signals.crisisText')).toBe(CRISIS_NOTICE);
    expect(lookup('signals.emergencyText')).toBe(EMERGENCY_NOTICE);
    // 不再有重复的副本
    for (const key of [
      'experts.tab.crisis',
      'experts.tab.crisisText',
      'experts.tab.emergency',
      'experts.tab.emergencyText',
      'results.artifacts.signals.crisis',
      'results.artifacts.signals.crisisText',
      'results.artifacts.signals.emergency',
      'results.artifacts.signals.emergencyText',
    ])
      expect(lookup(key), key).toBeUndefined();
  });

  it('M4 孪生和跟进的枚举值都有翻译', () => {
    const groups: [string, readonly string[]][] = [
      ['twin.levels', TWIN_LEVELS],
      ['twin.colors', TWIN_LEVELS],
      ['twin.domains', TWIN_DOMAINS],
      ['twin.timeline.types', TWIN_TIMELINE_TYPES],
      ['twin.timeline.origin', TWIN_STATUS_ORIGINS],
      ['followUps.kinds', FOLLOW_UP_KINDS],
      ['followUps.form.resolutions', FOLLOW_UP_RESOLUTIONS],
      ['followUps.form.dismissReasons', FOLLOW_UP_DISMISS_REASONS],
    ];
    for (const [prefix, values] of groups)
      for (const v of values)
        expect(typeof lookup(`${prefix}.${v}`), `${prefix}.${v}`).toBe('string');
  });

  it('孪生和跟进清单的词条没有禁用词，只有固定的“仅供参考，非医疗诊断”（验收标准 21）', () => {
    const strings = (node: unknown, path: string): [string, string][] =>
      typeof node === 'string'
        ? [[path, node]]
        : node && typeof node === 'object'
          ? Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`))
          : [];
    const all = ['twin', 'followUps', 'nav'].flatMap((root) => strings(lookup(root), root));
    expect(all.length).toBeGreaterThan(100);
    const issues = all.flatMap(([path, text]) =>
      findBannedTerms(text).map((issue) => `${path}: ${issue.term}`),
    );
    expect(issues).toEqual([]);
    // 提示条和后端的标准免责声明一字不差；含“诊断”的只有这一处，靠白名单放行
    expect(lookup('twin.disclaimer')).toBe(DISCLAIMER);
    expect(all.filter(([, text]) => text.includes('诊断')).map(([p]) => p)).toEqual([
      'twin.disclaimer',
    ]);
    // 红线 4：不对任何疾病风险下结论（预测只说“可能”，不说概率、必然）
    const riskWords = ['会得', '患病', '概率', '将会', '必然', '一定会'];
    expect(
      all.flatMap(([path, text]) =>
        riskWords.filter((w) => text.includes(w)).map((w) => `${path}: ${w}`),
      ),
    ).toEqual([]);
  });

  it('M5 方案、随访和方案库的枚举值都有翻译', () => {
    const groups: [string, readonly string[]][] = [
      ['care.sections', PLAN_SECTIONS],
      ['care.plan.status', CARE_PLAN_STATUSES],
      ['care.plan.endReasons', CARE_PLAN_END_REASONS],
      ['care.adherence.metrics', GOAL_METRICS],
      ['care.adherence.units', GOAL_METRICS],
      ['care.visits.purposes', VISIT_PURPOSES],
      ['care.visits.methods', VISIT_METHODS],
      ['care.visits.statuses', VISIT_STATUSES],
      ['care.visits.form.cancelReasons', VISIT_CANCEL_REASONS],
      ['care.records.topics', VISIT_FEEDBACK_TOPICS],
      ['library.meals', MEAL_TYPES],
      ['library.tagNames', LIBRARY_TAGS],
      ['library.allergenNames', ALLERGENS],
      ['library.categories', EXERCISE_CATEGORIES],
      ['library.intensities', EXERCISE_INTENSITIES],
      ['library.settings', EXERCISE_SETTINGS],
      ['library.sections', PLAN_SECTIONS],
    ];
    for (const [prefix, values] of groups)
      for (const v of values)
        expect(typeof lookup(`${prefix}.${v}`), `${prefix}.${v}`).toBe('string');
  });

  it('M5 方案与随访、方案库的词条没有禁用词，也没有疾病风险和功效说法（红线 4、5）', () => {
    const strings = (node: unknown, path: string): [string, string][] =>
      typeof node === 'string'
        ? [[path, node]]
        : node && typeof node === 'object'
          ? Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`))
          : [];
    const all = ['care', 'library'].flatMap((root) => strings(lookup(root), root));
    expect(all.length).toBeGreaterThan(100);
    expect(
      all.flatMap(([path, text]) => findBannedTerms(text).map((i) => `${path}: ${i.term}`)),
    ).toEqual([]);
    const riskWords = ['会得', '患病', '概率', '必然', '一定会', '降血糖', '降血压', '治好'];
    expect(
      all.flatMap(([path, text]) =>
        riskWords.filter((w) => text.includes(w)).map((w) => `${path}: ${w}`),
      ),
    ).toEqual([]);
  });
});
