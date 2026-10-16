import { redactIdentifiers } from '@health-buddy/skills';
import type { RawItem } from './process-values.js';

/**
 * 识别结果写入数据库前，按格式去掉手机号和身份证号（含空格、短横线分隔的写法）。
 * 提示词已要求不转录个人信息，这里是后端兜底：只处理会原样展示的文字字段
 * （原始指标名、原文片段、检查机构），数值、单位、参考范围不动。
 */
export function redactExtraction<T extends { institution: string | null; items: RawItem[] }>(
  result: T,
): T {
  return {
    ...result,
    institution: result.institution === null ? null : redactIdentifiers(result.institution),
    items: result.items.map((item) => ({
      ...item,
      rawName: redactIdentifiers(item.rawName),
      snippet: item.snippet === null ? null : redactIdentifiers(item.snippet),
    })),
  };
}
