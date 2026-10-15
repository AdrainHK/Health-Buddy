/**
 * 每百万 token 的美元价格，用于费用估算（不是账单）。
 * 表里没有的型号返回 null，计量照记 token 数，只是不估算费用。
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'gpt-5': { input: 1.25, output: 10 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICES_PER_MTOK[model];
  if (!price) return null;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
