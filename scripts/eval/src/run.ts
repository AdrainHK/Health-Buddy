import type { CallContext, LlmGateway, ProviderName } from '@health-buddy/ai-engine';
import {
  buildSystemPrompt,
  clientRecentSummary,
  recentSummaryOutputSchema,
  type AskEvalCase,
  type RecentSummaryOutput,
  type SkillEvalCase,
} from '@health-buddy/skills';
import { runAskOnce } from './ask.js';
import { describeError, gradeRecentSummary, type Finding } from './graders.js';
import { judgeClientText } from './judge.js';

export interface RunResult {
  caseId: string;
  category: string;
  provider: ProviderName;
  run: number;
  findings: Finding[];
  /** 合成数据的输出，写进报告文件方便排查；不打印到控制台 */
  output?: RecentSummaryOutput | string;
}

export interface CaseSummary {
  caseId: string;
  provider: ProviderName;
  passed: number;
  runs: number;
  rules: string[];
}

/** 评测调用的身份：不写计量库，只用来满足网关接口 */
const EVAL_CTX: CallContext = { operatorId: null, userId: 'eval' };

async function runOnce(
  gateway: LlmGateway,
  provider: ProviderName,
  c: SkillEvalCase,
  run: number,
  useJudge: boolean,
): Promise<RunResult> {
  const base = { caseId: c.id, category: c.category, provider, run };
  try {
    const result = await gateway.completeStructured(
      EVAL_CTX,
      {
        route: 'skill',
        system: buildSystemPrompt(clientRecentSummary),
        messages: [
          {
            role: 'user',
            content: clientRecentSummary.buildUserMessage({
              client: c.client,
              managerRequest: c.managerRequest,
              returnReason: c.returnReason,
            }),
          },
        ],
      },
      { name: 'recent_summary', schema: recentSummaryOutputSchema },
    );
    if (result.status === 'refused') {
      return { ...base, findings: [{ rule: 'output.refused', detail: '模型拒答' }] };
    }
    const findings = gradeRecentSummary(c, result.data);
    if (useJudge)
      findings.push(...(await judgeClientText(gateway, EVAL_CTX, result.data.clientFacing)));
    return { ...base, findings, output: result.data };
  } catch (err) {
    return { ...base, findings: [{ rule: 'output.error', detail: describeError(err) }] };
  }
}

/** 并发跑完所有用例 × 次数，限制同时进行的调用数 */
export async function runEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: SkillEvalCase[];
  runs: number;
  useJudge: boolean;
  concurrency?: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runOnce(options.gateway, options.provider, c, i + 1, options.useJudge),
    ),
  );
  return runPool(jobs, options.concurrency ?? 3);
}

/** 问一问的评测：每个用例跑 runs 次 */
export async function runAskEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: AskEvalCase[];
  runs: number;
  useJudge: boolean;
  concurrency?: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runAskOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1, options.useJudge),
    ),
  );
  return runPool(jobs, options.concurrency ?? 3);
}

/** 限制同时进行的调用数，结果按用例和次数排序 */
async function runPool(jobs: (() => Promise<RunResult>)[], concurrency: number) {
  const results: RunResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job) results.push(await job());
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.run - b.run);
}

/** “通过”定义为同一用例连续 N 次全部没有问题（规格 7.5） */
export function summarize(results: RunResult[]): CaseSummary[] {
  const byKey = new Map<string, CaseSummary>();
  for (const r of results) {
    const key = `${r.provider}:${r.caseId}`;
    const s = byKey.get(key) ?? {
      caseId: r.caseId,
      provider: r.provider,
      passed: 0,
      runs: 0,
      rules: [],
    };
    s.runs++;
    if (!r.findings.length) s.passed++;
    for (const f of r.findings) if (!s.rules.includes(f.rule)) s.rules.push(f.rule);
    byKey.set(key, s);
  }
  return [...byKey.values()];
}
