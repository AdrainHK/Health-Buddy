import type { CallContext, LlmGateway, ProviderName } from '@health-buddy/ai-engine';
import {
  buildSystemPrompt,
  clientRecentSummary,
  recentSummaryOutputSchema,
  type AskEvalCase,
  type ExtractionEvalCase,
  type PlanEvalCase,
  type RecentSummaryOutput,
  type ReportSkillEvalCase,
  type SkillEvalCase,
  type TwinAskEvalCase,
  type TwinSummaryEvalCase,
  type CarePlanEvalCase,
  type VisitScheduleEvalCase,
  type VisitRecordEvalCase,
  type VisitScriptEvalCase,
} from '@health-buddy/skills';
import type { ExpertEvalCase, RoutingEvalCase, SynthesisEvalCase } from '@health-buddy/experts';
import { runAskOnce } from './ask.js';
import { runExpertOnce, runRoutingOnce, runSynthesisOnce } from './expert.js';
import { runExtractionOnce } from './extraction.js';
import { describeError, gradeRecentSummary, type Finding } from './graders.js';
import { judgeClientText } from './judge.js';
import { runPlanOnce, runReportSkillOnce } from './report-skills.js';
import { runCarePlanOnce, runVisitScheduleOnce } from './plans.js';
import { runTwinAskOnce, runTwinSummaryOnce } from './twin.js';
import { runVisitRecordOnce, runVisitScriptOnce } from './visits.js';

export interface RunResult {
  caseId: string;
  category: string;
  provider: ProviderName;
  run: number;
  findings: Finding[];
  /** 合成数据的输出，写进报告文件方便排查；不打印到控制台 */
  output?: RecentSummaryOutput | string;
}

/**
 * 只记录、不算失败的规则：评审模型拒答（未评）。汇总里照样列出，方便看有多少次没评上。
 */
export const INFO_RULES: ReadonlySet<string> = new Set([
  'judge.twin.unavailable',
  'judge.record.unavailable',
]);

/** 这次运行是否通过：没有问题，或只有 INFO_RULES 里的记录 */
export function runPassed(r: Pick<RunResult, 'findings'>): boolean {
  return r.findings.every((f) => INFO_RULES.has(f.rule));
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

/** 报告识别的评测：合成报告逐页识别，每个用例跑 runs 次（M2 规格 4.4） */
export async function runExtractionEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: ExtractionEvalCase[];
  runs: number;
  concurrency?: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runExtractionOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1),
    ),
  );
  return runPool(jobs, options.concurrency ?? 2);
}

/** /体检解读 或 /面谈提纲 的评测：每个用例跑 runs 次（M2 规格 4.4） */
export async function runReportSkillEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  skillId: 'report-interpretation' | 'interview-outline';
  cases: ReportSkillEvalCase[];
  runs: number;
  useJudge: boolean;
  concurrency?: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runReportSkillOnce(
          options.gateway,
          EVAL_CTX,
          options.provider,
          options.skillId,
          c,
          i + 1,
          options.useJudge,
        ),
    ),
  );
  return runPool(jobs, options.concurrency ?? 3);
}

/** 多步计划的评测：按计划顺序跑每个技能（M2 规格 2.9） */
export async function runPlanEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: PlanEvalCase[];
  runs: number;
  useJudge: boolean;
  concurrency?: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runPlanOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1, options.useJudge),
    ),
  );
  return runPool(jobs, options.concurrency ?? 2);
}

/** 专家意见评测（M3 规格 8.1） */
export async function runExpertEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly ExpertEvalCase[];
  runs: number;
  concurrency?: number;
  /** “请专家看看”的用例（带孪生项）再请大模型评审（M4 规格 5.5） */
  useJudge?: boolean;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runExpertOnce(
          options.gateway,
          EVAL_CTX,
          options.provider,
          c,
          i + 1,
          options.useJudge ?? false,
        ),
    ),
  );
  // 专家用例多、单次调用长，CI 单组 60 分钟内跑完需要更高并发；太高会让单次调用变慢、超过 60 秒
  return runPool(jobs, options.concurrency ?? 4);
}

/** 路由评测（M3 规格 8.2） */
export async function runRoutingEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly RoutingEvalCase[];
  runs: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runRoutingOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1),
    ),
  );
  return runPool(jobs, 3);
}

/** 汇总评测（M3 规格 8.2） */
export async function runSynthesisEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly SynthesisEvalCase[];
  runs: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runSynthesisOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1),
    ),
  );
  return runPool(jobs, 2);
}

/** /孪生小结 评测（M4 规格 5.5） */
export async function runTwinSummaryEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly TwinSummaryEvalCase[];
  runs: number;
  /** 疾病判断、越界、危急类用例再请大模型评审 */
  useJudge?: boolean;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runTwinSummaryOnce(
          options.gateway,
          EVAL_CTX,
          options.provider,
          c,
          i + 1,
          options.useJudge ?? false,
        ),
    ),
  );
  return runPool(jobs, 3);
}

/** /随访计划 评测（M5 规格 5.5） */
export async function runVisitScheduleEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly VisitScheduleEvalCase[];
  runs: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runVisitScheduleOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1),
    ),
  );
  return runPool(jobs, 3);
}

/** /方案生成 评测（M5 规格 5.5，--suite care-plan） */
export async function runCarePlanEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly CarePlanEvalCase[];
  runs: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runCarePlanOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1),
    ),
  );
  return runPool(jobs, 3);
}

/** /随访话术 评测（M5 规格 5.5，--suite visit-script） */
export async function runVisitScriptEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly VisitScriptEvalCase[];
  runs: number;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () => runVisitScriptOnce(options.gateway, EVAL_CTX, options.provider, c, i + 1),
    ),
  );
  return runPool(jobs, 3);
}

/** /随访记录 评测（M5 规格 5.5，--suite visit-record）：规则检查，开了评审时部分类别加大模型评审 */
export async function runVisitRecordEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly VisitRecordEvalCase[];
  runs: number;
  useJudge?: boolean;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runVisitRecordOnce(
          options.gateway,
          EVAL_CTX,
          options.provider,
          c,
          i + 1,
          options.useJudge ?? false,
        ),
    ),
  );
  return runPool(jobs, 3);
}

/** 问一问 @孪生项 评测（M4 规格 5.5，--suite ask 扩展） */
export async function runTwinAskEval(options: {
  gateway: LlmGateway;
  provider: ProviderName;
  cases: readonly TwinAskEvalCase[];
  runs: number;
  useJudge?: boolean;
}): Promise<RunResult[]> {
  const jobs = options.cases.flatMap((c) =>
    Array.from(
      { length: options.runs },
      (_, i) => () =>
        runTwinAskOnce(
          options.gateway,
          EVAL_CTX,
          options.provider,
          c,
          i + 1,
          options.useJudge ?? false,
        ),
    ),
  );
  return runPool(jobs, 3);
}

/** 厂商或中转临时故障（5xx、限流、超时，含专家调用超过 60 秒）：重试，不算模型答错 */
export function isTransientFailure(result: RunResult): boolean {
  return result.findings.some(
    (f) =>
      (f.rule === 'output.error' && /\b(5\d\d|rate_limited|timeout)\b/.test(f.detail)) ||
      (f.rule === 'opinion.missing' && /^timeout\b/.test(f.detail)),
  );
}

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/** 临时故障最多重试三次，仍失败就照实记录 */
export async function withRetry(
  job: () => Promise<RunResult>,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<RunResult> {
  let result = await job();
  for (const ms of delays) {
    if (!isTransientFailure(result)) break;
    await new Promise((r) => setTimeout(r, ms));
    result = await job();
  }
  return result;
}

/** 限制同时进行的调用数，结果按用例和次数排序 */
async function runPool(jobs: (() => Promise<RunResult>)[], concurrency: number) {
  const results: RunResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job) results.push(await withRetry(job));
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
    if (runPassed(r)) s.passed++;
    for (const f of r.findings) if (!s.rules.includes(f.rule)) s.rules.push(f.rule);
    byKey.set(key, s);
  }
  return [...byKey.values()];
}
