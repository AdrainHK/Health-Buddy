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
const askCases = pick('ask', askEvalCases);
const useJudge = !process.argv.includes('--no-judge');

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
console.log(`\n报告：${file}`);
console.log(failed.length ? `未通过：${failed.length} 项` : '全部通过');
process.exit(failed.length ? 1 : 0);
