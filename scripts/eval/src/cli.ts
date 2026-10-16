/**
 * pnpm eval：用真实大模型跑技能评测（M1 规格 7.5）。
 *
 *   pnpm eval                      有密钥的厂商都跑，每个用例 3 次
 *   pnpm eval --provider openai    只跑一家
 *   pnpm eval --runs 5 --case crisis-signal --no-judge
 *   pnpm eval --suite ask          只跑问一问（summary 只跑近况小结；默认两组都跑）
 *
 * 密钥从环境变量读取（OPENAI_API_KEY、ANTHROPIC_API_KEY），不会打印。
 * 结果写到 eval-results/，全部是合成数据。有用例没通过时退出码为 1。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createGateway, loadGatewayConfig, type ProviderName } from '@health-buddy/ai-engine';
import { askEvalCases, recentSummaryEvalCases } from '@health-buddy/skills';
import { runAskEval, runEval, summarize, type RunResult } from './run.js';

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
    `\n${provider}（${config.defaultModels[provider]}）：${cases.length + askCases.length} 个用例 × ${runs} 次`,
  );
  const results = [
    ...(await runEval({ gateway, provider, cases, runs, useJudge })),
    ...(await runAskEval({ gateway, provider, cases: askCases, runs, useJudge })),
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
// 是哪条规则；只有用例名、规则名和错误类别，没有模型输出
if (process.env.GITHUB_ACTIONS && failed.length) {
  const errorKinds = (s: { caseId: string; provider: string }) => [
    ...new Set(
      all
        .filter((r) => r.caseId === s.caseId && r.provider === s.provider)
        .flatMap((r) => r.findings.filter((f) => f.rule === 'output.error').map((f) => f.detail)),
    ),
  ];
  const lines = failed.map((s) => {
    const kinds = errorKinds(s);
    return `${s.provider} ${s.caseId} ${s.passed}/${s.runs} ${s.rules.join(' ')}${kinds.length ? `（错误：${kinds.join(' ')}）` : ''}`;
  });
  console.log(`::error title=eval 未通过 ${failed.length} 项::${lines.join('%0A')}`);
}
console.log(`\n报告：${file}`);
console.log(failed.length ? `未通过：${failed.length} 项` : '全部通过');
process.exit(failed.length ? 1 : 0);
