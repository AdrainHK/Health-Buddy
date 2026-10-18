/**
 * 汇总和分歧标注（M3 规格 3.5）。
 *
 * 模型只做 consensus、disagreements、followUpPoints；后端校验它没有新增专家意见里没有的引用和数值。
 * 转介、危机和急症信号、“是否需要就医评估”的分歧由后端确定性合并，不交给模型。
 */
import type { Citation, ExpertOpinion, Synthesis } from '@health-buddy/shared';
import { z } from 'zod';
import type { LlmGateway } from '../gateway.js';
import type { CallContext } from '../types.js';
import { SYNTHESIS_SYSTEM_PROMPT } from './prompts.js';
import { checkedNumbers, hasBannedWording, unknownNumbers } from './validate.js';

const citation = z.object({ sourceId: z.string(), cardId: z.string() });

export const synthesisOutputSchema = z.object({
  consensus: z.array(
    z.object({ point: z.string(), experts: z.array(z.string()), citations: z.array(citation) }),
  ),
  disagreements: z.array(
    z.object({
      topic: z.string(),
      positions: z.array(
        z.object({ expertId: z.string(), view: z.string(), citations: z.array(citation) }),
      ),
    }),
  ),
  followUpPoints: z.array(z.string()),
});
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

export interface Responded {
  expertId: string;
  name: string;
  opinion: ExpertOpinion;
}

const sameCitation = (a: Citation, b: Citation) =>
  a.sourceId === b.sourceId && a.cardId === b.cardId;

function opinionCitations(o: ExpertOpinion): Citation[] {
  return [...o.findings.flatMap((f) => f.citations), ...o.suggestions.flatMap((s) => s.citations)];
}

/** 汇总模型的输入：只有通过校验的意见（规格 3.5） */
export function synthesisUserMessage(responded: readonly Responded[]): string {
  return [
    '## 各位专家的意见（JSON，已通过校验）',
    ...responded.map((r) =>
      [`### ${r.expertId}（${r.name}）`, JSON.stringify(r.opinion, null, 1)].join('\n'),
    ),
  ].join('\n\n');
}

export type SynthesisIssue =
  'unknown_expert' | 'bad_citation' | 'invented_number' | 'banned_wording';

/** 校验并清理模型的汇总：不合格的条目移除，返回问题类别 */
export function validateSynthesis(
  output: SynthesisOutput,
  responded: readonly Responded[],
): { output: SynthesisOutput; issues: SynthesisIssue[] } {
  const issues = new Set<SynthesisIssue>();
  const byId = new Map(responded.map((r) => [r.expertId, r.opinion]));
  const allowedNumbers = responded.flatMap((r) => checkedNumbers(JSON.stringify(r.opinion)));
  const textOk = (text: string) => {
    let ok = true;
    if (unknownNumbers(text, allowedNumbers).length) {
      issues.add('invented_number');
      ok = false;
    }
    if (hasBannedWording(text)) {
      issues.add('banned_wording');
      ok = false;
    }
    return ok;
  };
  const citationsOk = (citations: readonly Citation[], experts: readonly string[]) => {
    const pool = experts.flatMap((id) => {
      const o = byId.get(id);
      return o ? opinionCitations(o) : [];
    });
    const ok = citations.every((c) => pool.some((p) => sameCitation(p, c)));
    if (!ok) issues.add('bad_citation');
    return ok;
  };
  const expertsOk = (experts: readonly string[]) => {
    const ok = experts.length > 0 && experts.every((id) => byId.has(id));
    if (!ok) issues.add('unknown_expert');
    return ok;
  };

  const consensus = output.consensus.filter((c) => {
    const a = expertsOk(c.experts);
    const b = a && citationsOk(c.citations, c.experts);
    const t = textOk(c.point);
    return a && b && t;
  });
  const disagreements = output.disagreements
    .map((d) => ({
      ...d,
      positions: d.positions.filter((p) => {
        const a = expertsOk([p.expertId]);
        const b = a && citationsOk(p.citations, [p.expertId]);
        const t = textOk(p.view);
        return a && b && t;
      }),
    }))
    // 分歧至少要有两位专家的观点；话题本身也过检查
    .filter((d) => d.positions.length >= 2 && textOk(d.topic));
  const followUpPoints = output.followUpPoints.filter((f) => textOk(f));
  return { output: { consensus, disagreements, followUpPoints }, issues: [...issues] };
}

const SYNTHESIS_NOTES: Record<SynthesisIssue, string> = {
  unknown_expert: '有条目注明的专家 id 不在输入里，或没有注明来自哪位专家。',
  bad_citation: '有引用不在对应专家的意见里。引用只能原样照抄专家意见里出现过的。',
  invented_number: '有数值没有出现在任何一位专家的意见里。不要新增数值。',
  banned_wording: '出现了禁用词或诊断性表述（如“确诊”“患有”）。',
};

export async function callSynthesis<C extends CallContext>(
  gateway: LlmGateway<C>,
  ctx: C,
  responded: readonly Responded[],
  signal?: AbortSignal,
): Promise<SynthesisOutput | null> {
  const base = synthesisUserMessage(responded);
  const call = (content: string) =>
    gateway.completeStructured(
      ctx,
      {
        route: 'expert_synthesis',
        system: SYNTHESIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        maxOutputTokens: 6000,
      },
      { name: 'expert_synthesis', schema: synthesisOutputSchema },
      signal,
    );
  const first = await call(base);
  if (first.status === 'refused') return null;
  const checked = validateSynthesis(first.data, responded);
  if (!checked.issues.length) return checked.output;
  // 不合格：带着纠正说明（只说类别）重试一次，仍不合格的条目移除（规格 3.4 第 5 条）
  const note = [
    '## 上一次输出没有通过检查，请重新输出完整的汇总',
    ...checked.issues.map((i) => `- ${SYNTHESIS_NOTES[i]}`),
  ].join('\n');
  try {
    const second = await call(`${base}\n\n${note}`);
    if (second.status === 'refused') return checked.output;
    return validateSynthesis(second.data, responded).output;
  } catch (err) {
    if (signal?.aborted) throw err;
    return checked.output;
  }
}

const URGENCY_ZH = { attention: '建议就医评估', urgent: '需尽快就医' } as const;

/** 后端生成的分歧话题（规格 3.5、验收 11） */
export const MEDICAL_REVIEW_TOPIC = '是否需要就医评估';

/**
 * 确定性合并（规格 3.5）：
 * - 任何一位专家建议转介，就保留这条转介建议和建议人；
 * - 一位建议就医评估、另一位认为不需要时，后端生成一条分歧“是否需要就医评估”，即使模型没列出；
 * - 任何一位专家标出心理危机信号或疑似急症，汇总标记为 true（界面放在开头醒目提示）。
 */
export function mergeSynthesis(
  responded: readonly Responded[],
  model: SynthesisOutput | null,
  extra: { missingExperts: string[]; crisisDetected: boolean; emergencyDetected: boolean },
): Synthesis {
  const inScope = responded.filter((r) => r.opinion.inScope);
  const referrals = responded
    .filter((r) => r.opinion.referral.needed)
    .map((r) => ({
      expertId: r.expertId,
      urgency: r.opinion.referral.urgency,
      to: r.opinion.referral.to,
      reason: r.opinion.referral.reason,
    }));
  const disagreements: Synthesis['disagreements'] = (model?.disagreements ?? []).map((d) => ({
    ...d,
    generatedByBackend: false,
  }));
  const recommend = inScope.filter((r) => r.opinion.referral.needed);
  const decline = inScope.filter((r) => !r.opinion.referral.needed);
  const alreadyListed = disagreements.some((d) => /就医|转介/.test(d.topic));
  if (recommend.length && decline.length && !alreadyListed) {
    disagreements.unshift({
      topic: MEDICAL_REVIEW_TOPIC,
      generatedByBackend: true,
      positions: [
        ...recommend.map((r) => ({
          expertId: r.expertId,
          view: [
            `${URGENCY_ZH[r.opinion.referral.urgency ?? 'attention']}${r.opinion.referral.to ? `，转介：${r.opinion.referral.to}` : ''}`,
            r.opinion.referral.reason ?? '',
          ]
            .filter(Boolean)
            .join('。'),
          citations: [],
        })),
        ...decline.map((r) => ({
          expertId: r.expertId,
          view: '没有建议就医评估或转介',
          citations: [],
        })),
      ],
    });
  }
  return {
    consensus: model?.consensus ?? [],
    disagreements,
    referrals,
    followUpPoints: model?.followUpPoints ?? [],
    crisisSignal: extra.crisisDetected || responded.some((r) => r.opinion.crisisSignal),
    emergencySignal: extra.emergencyDetected || responded.some((r) => r.opinion.emergencySignal),
    missingExperts: extra.missingExperts,
  };
}
