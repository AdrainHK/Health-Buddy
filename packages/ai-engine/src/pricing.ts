/**
 * 每百万 token 的美元价格，用于费用估算（不是账单）。价格取自两家官网，2026 年 10 月。
 * 表里没有的型号返回 null，计量照记 token 数，只是不估算费用。
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-5': { input: 1.25, output: 10 },
};

/** 厂商返回的型号可能带日期后缀（如 gpt-6-astra-2026-09-01），按基础型号查价。 */
function priceFor(model: string): { input: number; output: number } | undefined {
  return PRICES_PER_MTOK[model] ?? PRICES_PER_MTOK[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
