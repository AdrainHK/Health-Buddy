/**
 * pnpm eval：用真实大模型跑技能评测（M1 规格 7.5）。
 *
 *   pnpm eval                      有密钥的厂商都跑，每个用例 3 次
 *   pnpm eval --provider openai    只跑一家
 *   pnpm eval --runs 5 --case crisis-signal --no-judge
 *   pnpm eval --suite ask          只跑问一问（summary 只跑近况小结，extraction 只跑报告识别，
 *                                  interpretation 只跑体检解读，outline 只跑面谈提纲，plan 只跑多步计划；默认都跑）
 *   pnpm eval --suite expert --expert nutrition
 *                                  M3：只跑专家评测（expert-routing 只跑路由，expert-synthesis 只跑汇总；
 *                                  --expert 限定一位专家）。改专家的 expert.md、sources.md、共用规则后必须跑
 *
 * 密钥从环境变量读取（OPENAI_API_KEY、ANTHROPIC_API_KEY），不会打印。
 * 结果写到 eval-results/，全部是合成数据。有用例没通过时退出码为 1。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createGateway, loadGatewayConfig, type ProviderName } from '@health-buddy/ai-engine';
import { EXPERT_EVAL_CASES, routingEvalCases, synthesisEvalCases } from '@health-buddy/experts';
import { sampleFontAvailable } from '@health-buddy/seed';
import {
  askEvalCases,
  assessmentPlanEvalCases,
  interviewOutlineEvalCases,
  recentSummaryEvalCases,
  reportExtractionEvalCases,
  reportInterpretationEvalCases,
} from '@health-buddy/skills';
import {
  runAskEval,
  runEval,
  runExpertEval,
  runExtractionEval,
  runPlanEval,
  runReportSkillEval,
  runRoutingEval,
  runSynthesisEval,
  summarize,
  type RunResult,
} from './run.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = loadGatewayConfig();
const requested = arg('provider') as ProviderName | undefined;
const providers = (['openai', 'anthropic'] as const).filter(
  (p) => (!requested || p === requested) && config.apiKeys[p],
);
if (!providers.length) {
  console.error('没有可用的大模型密钥（OPENAI_API_KEY 或 ANTHROPIC_API_KEY），评测未运行。');
  process.exit(2);
}

const runs = Number(arg('runs') ?? 3);
const onlyCase = arg('case');
const suite = arg('suite');
const pick = <T extends { id: string }>(name: string, list: T[]) =>
  (!suite || suite === name ? list : []).filter((c) => !onlyCase || c.id === onlyCase);
const cases = pick('summary', recentSummaryEvalCases);
// 报告识别：合成报告样本由 scripts/seed 渲染，需要中文字体（CI 装 fonts-noto-cjk）
const extractionCases = pick('extraction', reportExtractionEvalCases);
if (extractionCases.length && !sampleFontAvailable()) {
  const msg =
    '缺少渲染合成报告样本的中文字体（装 fonts-noto-cjk，或用 REPORT_SAMPLE_FONT 指定），报告识别评测无法运行。';
  console.error(process.env.GITHUB_ACTIONS ? `::error title=eval 缺少字体::${msg}` : msg);
  process.exit(1);
}
const interpretationCases = pick('interpretation', reportInterpretationEvalCases);
const outlineCases = pick('outline', interviewOutlineEvalCases);
const planCases = pick('plan', assessmentPlanEvalCases);
const onlyExpert = arg('expert');
const expertCases = pick(
  'expert',
  Object.values(EXPERT_EVAL_CASES)
    .flat()
    .filter((c) => !onlyExpert || c.expertId === onlyExpert),
);
const expertRoutingCases = pick('expert-routing', routingEvalCases);
const expertSynthesisCases = pick('expert-synthesis', synthesisEvalCases);
const useJudge = !process.argv.includes('--no-judge');
// 越界类问一问主要靠大模型评审判断，不开评审时不跑，免得“全部通过”有误导
const askCases = pick('ask', askEvalCases).filter(
  (c) => useJudge || (c.category !== 'out_of_bounds' && c.category !== 'client_message'),
);
if (!useJudge) console.log('未开启大模型评审：问一问的越界类用例本次不跑。');

const all: RunResult[] = [];
for (const provider of providers) {
  const gateway = createGateway({ ...config, defaultProvider: provider, routes: {} });
  console.log(
    `\n${provider}（${config.defaultModels[provider]}）：${cases.length + askCases.length + extractionCases.length + interpretationCases.length + outlineCases.length + planCases.length + expertCases.length + expertRoutingCases.length + expertSynthesisCases.length} 个用例 × ${runs} 次`,
  );
  const results = [
    ...(await runEval({ gateway, provider, cases, runs, useJudge })),
    ...(await runAskEval({ gateway, provider, cases: askCases, runs, useJudge })),
    ...(await runExtractionEval({ gateway, provider, cases: extractionCases, runs })),
    ...(await runReportSkillEval({
      gateway,
      provider,
      skillId: 'report-interpretation',
      cases: interpretationCases,
      runs,
      useJudge,
    })),
    ...(await runReportSkillEval({
      gateway,
      provider,
      skillId: 'interview-outline',
      cases: outlineCases,
      runs,
      useJudge,
    })),
    ...(await runPlanEval({ gateway, provider, cases: planCases, runs, useJudge })),
    ...(await runExpertEval({ gateway, provider, cases: expertCases, runs })),
    ...(await runRoutingEval({ gateway, provider, cases: expertRoutingCases, runs })),
    ...(await runSynthesisEval({ gateway, provider, cases: expertSynthesisCases, runs })),
  ];
  all.push(...results);
  for (const s of summarize(results)) {
    const mark = s.passed === s.runs ? '✓' : '✗';
    console.log(`  ${mark} ${s.caseId.padEnd(30)} ${s.passed}/${s.runs}  ${s.rules.join(' ')}`);
  }
}

mkdirSync('eval-results', { recursive: true });
const file = `eval-results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ runs, results: all }, null, 2));
const failed = summarize(all).filter((s) => s.passed < s.runs);
// 在 GitHub Actions 里把未通过的用例写成一条注解（注解每步最多 10 条），不下载报告也能看到
// 是哪条规则；只有用例名、规则名、错误类别、多出来的数值（合成数据）和命中的词表词（类别：词）。
// 模型输出只有两处片段：提纲剂量命中处前 12 个字、后 8 个字（含想一想计划里的提纲步骤），和解读里对无参考范围指标下判断的分句前 20 个字；
// 都只来自合成数据，身份信息已遮，数字换成 #；
// 没有客户资料。注解内容里的 %、换行按 GitHub 的写法转义
const DETAIL_RULES = new Set([
  'output.error',
  'accuracy.invented_numbers',
  'outline.presumed_disease',
  'outline.banned_terms',
  'outline.drug_names',
  'outline.drug_advice',
  'no_reference.judged',
  'outline.invented_report',
  'outline.judgment',
  'client.banned_terms',
  'client.disease_terms',
  'client.drug_terms',
  'client.judgment_terms',
  'client.urgency_terms',
  'client.crisis_terms',
]);
/** GitHub 注解的转义：先 %，再回车和换行 */
const escapeAnnotation = (t: string) =>
  t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
if (process.env.GITHUB_ACTIONS && failed.length) {
  const errorKinds = (s: { caseId: string; provider: string }) => [
    ...new Set(
      all
        .filter((r) => r.caseId === s.caseId && r.provider === s.provider)
        .flatMap((r) =>
          r.findings
            // 想一想的计划用例里规则带了步骤前缀（interview-outline:outline.drug_advice）
            .filter((f) => DETAIL_RULES.has(f.rule.replace(/^[\w-]+:/, '')))
            .map((f) => f.detail),
        ),
    ),
  ];
  const lines = failed.map((s) => {
    const kinds = errorKinds(s);
    const detail = kinds.length ? `（${kinds.join('；')}）` : '';
    return escapeAnnotation(
      `${s.provider} ${s.caseId} ${s.passed}/${s.runs} ${s.rules.join(' ')}${detail}`,
    );
  });
  console.log(`::error title=eval 未通过 ${failed.length} 项::${lines.join('%0A')}`);
}
console.log(`\n报告：${file}`);
console.log(failed.length ? `未通过：${failed.length} 项` : '全部通过');
process.exit(failed.length ? 1 : 0);
