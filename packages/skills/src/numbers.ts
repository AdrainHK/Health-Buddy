/**
 * 输入资料里出现过的全部数值（M3 规格 3.4 的数值校验，M4 规格 5.2 沿用）：报告数值、报告上印的参考范围、
 * 之前的数值、监测读数、危急指标数值和阈值、年龄段两端，以及同一指标两次数值的差（“比上次上升 0.6”），
 * 还有健管师问题里写的数字；有孪生资料时再加上孪生里的全部数字（状态依据、预测、跟进项）。
 * 专家意见、/孪生小结 和评测的规则检查都用这一份。
 */
import type { ClientSnapshot } from './framework.js';
import { twinNumbers } from './twin-input.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

export function knownNumbers(
  client: ClientSnapshot | null | undefined,
  texts: readonly string[] = [],
): number[] {
  const nums = new Set<number>();
  const pairDiffs = (values: number[]) => {
    for (const a of values) for (const b of values) if (a > b) nums.add(round1(a - b));
  };
  for (const t of texts) for (const n of t.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
  if (client) {
    for (const n of client.ageBand?.match(/\d+/g) ?? []) nums.add(Number(n));
    for (const m of client.monitoring) {
      for (const r of m.readings) nums.add(r.value);
      pairDiffs(m.readings.map((r) => r.value));
    }
    for (const i of client.latestReport?.indicators ?? []) {
      nums.add(i.value);
      if (i.refLow !== undefined) nums.add(i.refLow);
      if (i.refHigh !== undefined) nums.add(i.refHigh);
    }
    for (const i of client.reportDetail?.indicators ?? []) {
      const values = [...(i.value !== null ? [i.value] : []), ...i.previous.map((p) => p.value)];
      for (const v of values) nums.add(v);
      pairDiffs(values);
      if (i.refLow !== null) nums.add(i.refLow);
      if (i.refHigh !== null) nums.add(i.refHigh);
      for (const n of i.refText?.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
      for (const n of i.textValue?.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
    }
    for (const f of client.criticalFlags) {
      nums.add(f.value);
      nums.add(f.rule.value);
    }
    for (const h of client.healthHistory ?? []) {
      for (const n of h.content.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(Number(n));
    }
    if (client.twin) for (const n of twinNumbers(client.twin)) nums.add(n);
  }
  return [...nums];
}
