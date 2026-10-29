/**
 * 会话结束后的后台整理（M6 规格 2.6、5.1）：从本次对话里提取值得记住的事，写一句会话摘要。
 * 不面向客户；只拿本次会话和已有记忆，不拿档案。病名、药名、健康判断由 isAllowedMemory 再过滤一遍。
 */
import { z } from 'zod';
import { isAllowedMemory } from './checks.js';
import { redactCompanionText, type CompanionTurn } from './prompt.js';

export const COMPANION_MEMORY_PROMPT = `你在整理 AI 伴侣“福宝”和一位老年客户的一次聊天记录，供福宝以后聊天时参考。

1. memories：从这次聊天里找出值得以后记住的事，每条一句话（不超过 40 个字），最多 5 条。只记：客户希望怎么被称呼、喜好（爱吃的、爱好）、家人的称呼和近况、作息习惯、近期的生活事件。已经记得的事不要重复。没有就给空数组。
2. 不记病名、药名、症状、检查结果、测量数值和任何健康判断；不记电话、地址、身份证号。
3. 客户说了想怎么被称呼，写成“客户希望被称呼为……”。
4. summary：用一两句话概括这次聊了什么（不超过 80 个字），同样不写病名、药名和健康判断。
5. 只依据聊天记录，不编造。`;

export const companionMemoryOutputSchema = z.object({
  memories: z.array(z.string().max(100)).max(5),
  summary: z.string().max(200),
});
export type CompanionMemoryOutput = z.infer<typeof companionMemoryOutputSchema>;
export const COMPANION_MEMORY_FORMAT = 'companion_memory';

export function buildCompanionMemoryRequest(
  turns: readonly CompanionTurn[],
  existing: readonly string[],
): { system: string; messages: { role: 'user'; content: string }[] } {
  const transcript = turns
    .map((t) => `${t.role === 'client' ? '客户' : '福宝'}：${redactCompanionText(t.text)}`)
    .join('\n');
  const known = existing.length ? existing.map((m) => `- ${m}`).join('\n') : '（还没有）';
  return {
    system: COMPANION_MEMORY_PROMPT,
    messages: [
      { role: 'user', content: `已经记得的事：\n${known}\n\n这次的聊天记录：\n${transcript}` },
    ],
  };
}

/** 过滤后的新记忆（去重、去掉病名药名等）和摘要（不合格时为 null） */
export function acceptCompanionMemory(
  output: CompanionMemoryOutput,
  existing: readonly string[],
): { memories: string[]; summary: string | null } {
  const seen = new Set(existing.map((m) => m.trim()));
  const memories: string[] = [];
  for (const m of output.memories) {
    const t = m.trim();
    if (!isAllowedMemory(t) || seen.has(t)) continue;
    seen.add(t);
    memories.push(t);
  }
  const summary = output.summary.trim();
  return {
    memories,
    summary: summary && isAllowedMemory(summary.slice(0, 100)) ? summary.slice(0, 200) : null,
  };
}
