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

export { expertOpinionSchema, type ExpertOpinion };

/** 心理专家：意见不进通俗版（规格 4.7） */
export const MENTAL_HEALTH_EXPERT = 'mental-health';

const URGENCY_ZH = { attention: '建议就医评估', urgent: '需尽快就医' } as const;

export const EMERGENCY_NOTICE =
  '健管师转述的情况里有疑似急症，请建议客户及时就医，必要时拨打当地急救电话。';

const cite = (citations: readonly Citation[]) =>
  citations.length ? `（来源：${citations.map((c) => c.cardId).join('、')}）` : '';

/**
 * 一位专家的意见渲染成健管师看的文字（专家中心的回答）。末尾由后端固定拼接提示（规格 2.3 第 4 条），
 * 危机和急症提示放在最前面（规格 7.2 第 5 条）。
 */
export function renderOpinion(
  opinion: ExpertOpinion,
  options: { removedFindings?: number; crisis?: boolean; emergency?: boolean } = {},
): string {
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
        lines.push(`- ${f.point}${data ? `（数据：${data}）` : ''}${cite(f.citations)}`);
      }
    }
    if (opinion.suggestions.length) {
      lines.push('', '**建议健管师关注**');
      for (const s of opinion.suggestions) lines.push(`- ${s.text}${cite(s.citations)}`);
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
      lines.push(`- ${c.point}（${c.experts.map(names).join('、')}）${cite(c.citations)}`);
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
      lines.push(`  - ${names(p.expertId)}：${p.view}${cite(p.citations)}`);
  }
  return lines.join('\n');
}

/** /体检解读 生成时给模型的专家意见摘要（规格 2.7、Q8）：只给专业版参考，生活方式建议可以改写进通俗版 */
export function consultationDigest(
  opinions: readonly { expertId: string; opinion: ExpertOpinion }[],
  names: (id: string) => string,
): string {
  if (!opinions.length) return '';
  const lines = [
    '## AI 专家意见（只给健管师参考）',
    '后端会把专家意见汇总和分歧原样写进专业版，你不需要重复。通俗版可以把下面的生活方式建议改写进去（仍遵守通俗版的全部规则），但不能出现专家名称、“专家认为”之类的说法，也不能出现专家的专业结论、疾病和风险判断。',
  ];
  for (const o of opinions) {
    // 心理专家的意见只在专业版单独一节，不进入通俗版的任何内容（规格 4.7 特别说明）
    if (!o.opinion.inScope || o.expertId === MENTAL_HEALTH_EXPERT) continue;
    lines.push(`### ${names(o.expertId)}`, `- 结论：${o.opinion.summary}`);
    for (const s of o.opinion.suggestions) lines.push(`- 建议：${s.text}`);
  }
  return lines.join('\n');
}

export function parseOpinion(value: unknown): ExpertOpinion | null {
  const parsed = expertOpinionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
