import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ABNORMAL_FLAGS,
  CONSULTATION_STATUSES,
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
    for (const dir of ['record', 'reports', 'chat', 'artifacts', 'shell', 'experts'])
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
      'skills.client-recent-summary.name',
      'skills.report-interpretation.name',
      'skills.interview-outline.name',
      'skills.new-client-assessment.name',
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
});
