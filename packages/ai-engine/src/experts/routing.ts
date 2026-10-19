/**
 * 路由：选哪些专家（M3 规格 3.2）。
 *
 * 1. 健管师指定（@、“一定要请”、专家中心绑定）先放进去；“不要请”的从候选里去掉。
 * 2. 规则命中（确定性）：后端标为高于、低于参考范围或没有参考范围的指标，命中登记了这个指标编码的专家。
 * 3. 模型补充：只能从专家目录里选，目录外、不可用、被排除的 id 直接丢弃。
 * 4. 上限：健管师指定 > 规则命中多的 > 模型补充的，取前 N 位；其余记为“因数量上限未调用”。
 * 5. 模型路由失败：只用规则结果，不报错。
 * 6. M4“请专家看看”：健管师没补充问题文字时不用模型补充（modelRouting: false），只按规则命中。
 */
import type { RoutingDecision, RoutingReason, SelectedReason } from '@health-buddy/shared';
import { z } from 'zod';
import type { LlmGateway } from '../gateway.js';
import type { CallContext } from '../types.js';
import { ROUTING_SYSTEM_PROMPT } from './prompts.js';
import type { ConsultationRequest, ExpertProfile } from './types.js';

export const MODEL_ROUTING_CATEGORIES = [
  'manager_request',
  'health_history',
  'indicator_relation',
] as const;

export const routingOutputSchema = z.object({
  experts: z.array(
    z.object({
      expertId: z.string(),
      reason: z.enum(MODEL_ROUTING_CATEGORIES),
    }),
  ),
});
export type RoutingOutput = z.infer<typeof routingOutputSchema>;

interface Candidate {
  expertId: string;
  selectedReason: SelectedReason;
  reasons: RoutingReason[];
  /** 规则命中的指标数，用于排序 */
  hits: number;
  /** 注册表顺序，同分时稳定排序 */
  order: number;
}

/** 规则命中：每位专家命中了哪些指标 */
export function ruleHits(
  request: Pick<ConsultationRequest, 'input' | 'available'>,
): Map<string, RoutingReason[]> {
  const out = new Map<string, RoutingReason[]>();
  for (const expert of request.available) {
    const reasons: RoutingReason[] = [];
    for (const f of request.input.flaggedIndicators) {
      // 日常监测的指标（M4 孪生）不算“任何指标”：检验解读专家只看报告
      const any = expert.indicatorCodes.includes('*') && f.source !== 'monitoring';
      // 没有参考范围的指标只交给“任何指标”的专家（检验解读）；未收录指标同理
      const hit =
        any ||
        (f.direction !== 'no_reference' &&
          f.code !== null &&
          expert.indicatorCodes.includes(f.code));
      if (hit) reasons.push({ kind: 'indicator', code: f.code, direction: f.direction });
    }
    if (reasons.length) out.set(expert.id, reasons);
  }
  return out;
}

/** 专家目录：给路由模型看的 id、擅长和不负责的范围 */
export function routingCatalog(experts: readonly ExpertProfile[]): string {
  return experts
    .map(
      (e) =>
        `- id: ${e.id}（${e.name}）\n  擅长：${e.catalog.strengths.join('；')}\n  不负责：${e.catalog.outOfScope.join('；')}`,
    )
    .join('\n');
}

export function routingUserMessage(
  request: Pick<ConsultationRequest, 'input' | 'available'>,
  alreadySelected: readonly string[],
): string {
  const flagged = request.input.flaggedIndicators
    .map((f) => `${f.code ?? '未收录指标'}（${DIRECTION_ZH[f.direction]}）`)
    .join('、');
  return [
    '## 专家目录',
    routingCatalog(request.available),
    '',
    '## 报告中需要关注的指标编码',
    flagged || '没有。',
    '',
    '## 健康史里有记录的类别',
    request.input.historyCategories.join('、') || '没有。',
    '',
    '## 已经选定的专家（不需要再选）',
    alreadySelected.join('、') || '没有。',
    '',
    '## 健管师的要求',
    request.input.request || '（没有额外要求）',
  ].join('\n');
}

const DIRECTION_ZH = {
  high: '高于参考范围',
  low: '低于参考范围',
  no_reference: '报告未提供参考范围',
} as const;

/**
 * 计算路由决定。模型补充只在 mode = route 时调用，并且指定和规则已经填满上限时不调用（省成本）。
 */
export async function routeExperts<C extends CallContext>(
  gateway: LlmGateway<C>,
  ctx: C,
  request: ConsultationRequest,
  options: { maxExperts: number; signal?: AbortSignal | undefined },
): Promise<RoutingDecision> {
  const available = new Map(request.available.map((e, i) => [e.id, i]));
  const excluded = request.excluded.filter((id) => available.has(id));
  const isExcluded = (id: string) => excluded.includes(id);
  const candidates = new Map<string, Candidate>();
  const add = (id: string, selectedReason: SelectedReason, reason: RoutingReason, hits = 0) => {
    const order = available.get(id);
    if (order === undefined) return;
    const existing = candidates.get(id);
    if (existing) {
      existing.reasons.push(reason);
      return;
    }
    candidates.set(id, { expertId: id, selectedReason, reasons: [reason], hits, order });
  };

  // 1. 健管师指定（指定的专家即使在“不要请”里也以指定为准；契约已禁止两者重叠）
  if (request.bound) add(request.bound, 'manager', { kind: 'bound' });
  for (const id of request.forced) add(id, 'manager', { kind: 'manager' });

  let ruleOnly = false;
  if (request.mode === 'route') {
    // 2. 规则命中
    for (const [id, reasons] of ruleHits(request)) {
      if (isExcluded(id)) continue;
      const existing = candidates.get(id);
      if (existing) existing.reasons.push(...reasons);
      else
        candidates.set(id, {
          expertId: id,
          selectedReason: 'rule',
          reasons,
          hits: reasons.length,
          order: available.get(id) ?? 0,
        });
    }
    // 3. 模型补充：指定和规则已经填满上限时不调用
    if (request.modelRouting !== false && candidates.size < options.maxExperts) {
      const remaining = request.available.filter((e) => !candidates.has(e.id) && !isExcluded(e.id));
      if (remaining.length) {
        try {
          const result = await gateway.completeStructured(
            ctx,
            {
              route: 'expert_routing',
              system: ROUTING_SYSTEM_PROMPT,
              messages: [
                {
                  role: 'user',
                  content: routingUserMessage({ ...request, available: remaining }, [
                    ...candidates.keys(),
                  ]),
                },
              ],
              maxOutputTokens: 2000,
            },
            { name: 'expert_routing', schema: routingOutputSchema },
            options.signal,
          );
          if (result.status === 'ok') {
            const allowed = new Set(remaining.map((e) => e.id));
            for (const pick of result.data.experts) {
              // 目录外、不可用、被排除、已选的 id 一律丢弃
              if (!allowed.has(pick.expertId) || candidates.has(pick.expertId)) continue;
              add(pick.expertId, 'model', { kind: 'model', category: pick.reason });
            }
          } else ruleOnly = true;
        } catch (err) {
          // 停止要往上抛；其余失败退回规则路由，步骤里不报错（规格 3.2 第 5 条）
          if (options.signal?.aborted) throw err;
          ruleOnly = true;
        }
      }
    }
  }

  // 4. 上限：指定 > 规则命中多的 > 模型补充的
  const rank = { manager: 0, rule: 1, model: 2 } as const;
  const ordered = [...candidates.values()].sort(
    (a, b) =>
      rank[a.selectedReason] - rank[b.selectedReason] || b.hits - a.hits || a.order - b.order,
  );
  const selected = ordered.slice(0, options.maxExperts);
  const overCap = ordered.slice(options.maxExperts).map((c) => c.expertId);
  return {
    selected: selected.map(({ expertId, selectedReason, reasons }) => ({
      expertId,
      selectedReason,
      reasons,
    })),
    excluded,
    overCap,
    ruleOnly,
  };
}
