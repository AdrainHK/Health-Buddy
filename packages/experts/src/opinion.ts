/**
 * 通用意见结构（M3 规格 4.2）。结构定义在 packages/shared 的接口契约里，前后端和引擎共用；
 * 这里重新导出，并提供只给健管师看的渲染（专家标签、/体检解读 专业版的“专家意见汇总”“专家分歧”）。
 */
import {
  EXPERT_DISCLAIMER,
  expertOpinionSchema,
  type Citation,
  type ExpertOpinion,
  type Synthesis,
} from '@health-buddy/shared';
import { CRISIS_NOTICE } from '@health-buddy/skills';
import { cardConfirmed } from './registry.js';

export { expertOpinionSchema, type ExpertOpinion };

/** 心理专家：意见不进通俗版（规格 4.7） */
export const MENTAL_HEALTH_EXPERT = 'mental-health';

const URGENCY_ZH = { attention: '建议就医评估', urgent: '需尽快就医' } as const;

export const EMERGENCY_NOTICE =
  '健管师转述的情况里有疑似急症，请建议客户及时就医，必要时拨打当地急救电话。';

/** 引用的卡片编号；医学顾问还没确认的卡片标“来源待确认”（预览环境才可能引用到） */
const cite = (citations: readonly Citation[], expertIds: readonly string[]) =>
  citations.length
    ? `（来源：${citations
        .map((c) =>
          expertIds.some((id) => cardConfirmed(id, c.cardId))
            ? c.cardId
            : `${c.cardId}（来源待确认）`,
        )
        .join('、')}）`
    : '';

/**
 * 一位专家的意见渲染成健管师看的文字（专家中心的回答）。末尾由后端固定拼接提示（规格 2.3 第 4 条），
 * 危机和急症提示放在最前面（规格 7.2 第 5 条）。
 */
export function renderOpinion(
  opinion: ExpertOpinion,
  options: {
    /** 用来查卡片是否已确认 */
    expertId?: string;
    removedFindings?: number;
    crisis?: boolean;
    emergency?: boolean;
  } = {},
): string {
  const ids = options.expertId ? [options.expertId] : [];
  const lines: string[] = [];
  if (options.crisis || opinion.crisisSignal) lines.push(`**心理危机提示**：${CRISIS_NOTICE}`, '');
  if (options.emergency || opinion.emergencySignal)
    lines.push(`**疑似急症提示**：${EMERGENCY_NOTICE}`, '');
  if (!opinion.inScope) {
    lines.push(opinion.outOfScopeNote ?? '这个问题不在我的范围内。');
  } else {
    lines.push('**结论**', opinion.summary);
    if (opinion.findings.length) {
      lines.push('', '**依据**');
      for (const f of opinion.findings) {
        const data = f.dataRefs
          .map((d) => [d.label, d.value, d.date].filter(Boolean).join(' '))
          .join('；');
        lines.push(`- ${f.point}${data ? `（数据：${data}）` : ''}${cite(f.citations, ids)}`);
      }
    }
    if (opinion.suggestions.length) {
      lines.push('', '**建议健管师关注**');
      for (const s of opinion.suggestions) lines.push(`- ${s.text}${cite(s.citations, ids)}`);
    }
    if (opinion.questionsToAsk.length) {
      lines.push('', '**建议进一步了解**', ...opinion.questionsToAsk.map((q) => `- ${q}`));
    }
    if (opinion.dataGaps.length)
      lines.push('', '**缺少的数据**', ...opinion.dataGaps.map((d) => `- ${d}`));
    const r = opinion.referral;
    lines.push(
      '',
      '**是否需要转介**',
      r.needed
        ? `${URGENCY_ZH[r.urgency ?? 'attention']}${r.to ? `：${r.to}` : ''}${r.reason ? `。${r.reason}` : ''}`
        : '暂不需要转介。',
    );
  }
  if (options.removedFindings) lines.push('', '部分内容因依据无法核实已移除。');
  return `${lines.join('\n')}\n\n${EXPERT_DISCLAIMER}`;
}

/**
 * /体检解读 专业版新增的两节（规格 2.7）：专家意见汇总、专家分歧。后端确定性渲染，不经过模型；
 * 只进专业版，绝不进通俗版。names 把专家 id 换成中文名。
 */
export function renderConsultationSections(
  synthesis: Synthesis | null,
  opinions: readonly { expertId: string; opinion: ExpertOpinion }[],
  names: (id: string) => string,
  options: { synthesisFailed: boolean },
): string {
  const lines: string[] = ['## 专家意见汇总（AI 专家，仅供健管师参考）'];
  if (!opinions.length) {
    lines.push('本次未能取得专家意见。');
    return lines.join('\n');
  }
  if (synthesis?.crisisSignal) lines.push(`**心理危机提示**：${CRISIS_NOTICE}`);
  if (synthesis?.emergencySignal) lines.push(`**疑似急症提示**：${EMERGENCY_NOTICE}`);
  lines.push(`已调用：${opinions.map((o) => names(o.expertId)).join('、')}`);
  if (synthesis?.missingExperts.length) {
    lines.push(`未能回复：${synthesis.missingExperts.map(names).join('、')}`);
  }
  if (options.synthesisFailed || opinions.length === 1 || !synthesis?.consensus.length) {
    if (options.synthesisFailed) lines.push('未能自动汇总，请逐条查看：');
    for (const o of opinions) {
      lines.push(
        `- **${names(o.expertId)}**：${o.opinion.inScope ? o.opinion.summary : (o.opinion.outOfScopeNote ?? '')}`,
      );
    }
  } else {
    for (const c of synthesis.consensus) {
      lines.push(
        `- ${c.point}（${c.experts.map(names).join('、')}）${cite(c.citations, c.experts)}`,
      );
    }
  }
  for (const r of synthesis?.referrals ?? []) {
    lines.push(
      `- 转介建议（${names(r.expertId)}）：${URGENCY_ZH[r.urgency ?? 'attention']}${r.to ? `，${r.to}` : ''}${r.reason ? `。${r.reason}` : ''}`,
    );
  }
  if (synthesis?.followUpPoints.length) {
    lines.push('', '建议进一步了解：', ...synthesis.followUpPoints.map((p) => `- ${p}`));
  }
  lines.push('', '## 专家分歧');
  if (!synthesis?.disagreements.length) lines.push('没有发现分歧。');
  for (const d of synthesis?.disagreements ?? []) {
    lines.push(`- **${d.topic}**`);
    for (const p of d.positions)
      lines.push(`  - ${names(p.expertId)}：${p.view}${cite(p.citations, [p.expertId])}`);
  }
  return lines.join('\n');
}

/**
 * /体检解读 生成时给模型的专家意见摘要（规格 2.7、Q8，合规审查后拆成两部分）：
 * - 第一部分只能用于专业版：每位专家的结论、要点、转介和非生活方式的建议；
 * - 第二部分是可以改写进通俗版的生活方式建议（category 为 lifestyle），不带专家名称。
 *   有心理危机或疑似急症信号的意见、心理专家的意见（规格 4.7）一条都不进第二部分；转介和复查跟进只进第一部分。
 * 心理专家的意见只在专业版单独一节由后端写入，不进摘要。
 */
export function consultationDigest(
  opinions: readonly { expertId: string; opinion: ExpertOpinion }[],
  names: (id: string) => string,
): string {
  const usable = opinions.filter((o) => o.opinion.inScope && o.expertId !== MENTAL_HEALTH_EXPERT);
  if (!usable.length) return '';
  const professional = [
    '## AI 专家意见（第一部分：只能用于专业版）',
    '后端会把专家意见汇总和分歧原样写进专业版，你不需要重复。这一部分的任何内容（专家名称、结论、要点、转介、复查跟进）都不能写进通俗版。',
  ];
  const lifestyle: string[] = [];
  for (const o of usable) {
    const op = o.opinion;
    professional.push(`### ${names(o.expertId)}`, `- 结论：${op.summary}`);
    for (const f of op.findings) professional.push(`- 要点：${f.point}`);
    for (const s of op.suggestions)
      if (s.category !== 'lifestyle') professional.push(`- 建议：${s.text}`);
    if (op.referral.needed) {
      professional.push(
        `- 转介：${URGENCY_ZH[op.referral.urgency ?? 'attention']}${op.referral.to ? `，${op.referral.to}` : ''}`,
      );
    }
    if (op.crisisSignal || op.emergencySignal) continue;
    for (const s of op.suggestions) if (s.category === 'lifestyle') lifestyle.push(`- ${s.text}`);
  }
  return [
    ...professional,
    '',
    '## AI 专家意见（第二部分：可以改写进通俗版的生活方式建议）',
    '通俗版只能参考这一部分，用通俗的话改写，仍遵守通俗版的全部规则；不能出现“专家”“AI 专家”或任何专家名称，也不能写“专家认为”之类的说法。',
    ...(lifestyle.length ? [...new Set(lifestyle)] : ['（没有）']),
  ].join('\n');
}

/** 通俗版里出现专家字样时，重新生成附带的纠正说明（只按类别写） */
export const EXPERT_MENTION_NOTE =
  '## 上一次输出没有通过检查\n- 通俗版里出现了“专家”或专家名称。通俗版不能提到专家、专家的结论和转介，只能用通俗的话写生活方式建议；请重新输出完整结果。';

/** 通俗版里不能出现的专家字样（合规审查第 4 条）：“专家”（含“AI 专家”）和每位专家的名称 */
export function expertMentions(text: string, expertNames: readonly string[]): string[] {
  const found = new Set<string>();
  if (text.includes('专家')) found.add('专家');
  for (const name of expertNames) if (text.includes(name)) found.add(name);
  return [...found];
}

export function parseOpinion(value: unknown): ExpertOpinion | null {
  const parsed = expertOpinionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
