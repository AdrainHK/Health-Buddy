import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * 报告识别（report_extraction，M2 规格 2.3、4.1、4.2）。不是技能，不在 / 列表里，
 * 由后端的识别队列按页调用。提示词放在 prompt.md，便于合规审查。
 *
 * 输出结构里没有任何个人信息字段（姓名、电话、证件号、地址、条形码等，Q7）。
 */
export const REPORT_EXTRACTION_PROMPT = readFileSync(
  new URL('./prompt.md', import.meta.url),
  'utf8',
).trim();

export const EXTRACTION_PAGE_CATEGORIES = ['report', 'not_a_report', 'unreadable'] as const;

export const reportExtractionOutputSchema = z.object({
  category: z.enum(EXTRACTION_PAGE_CATEGORIES),
  reportDate: z.string().nullable(),
  institution: z.string().nullable(),
  items: z.array(
    z.object({
      indicator: z.string(),
      value: z.string(),
      unit: z.string().nullable(),
      referenceRange: z.string().nullable(),
      snippet: z.string(),
      unreadable: z.boolean(),
    }),
  ),
});
export type ReportExtractionOutput = z.output<typeof reportExtractionOutputSchema>;

/** 结构化输出的名称（OpenAI 要求只含字母、数字、下划线） */
export const REPORT_EXTRACTION_FORMAT_NAME = 'report_extraction';

/** 消息内容的一段，和大模型网关的 ContentPart 结构相同（技能包不依赖网关） */
export type ExtractionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string }
  | { type: 'pdf'; data: string };

/** 识别一页时发给模型的页面 */
export type ExtractionPageInput =
  | { kind: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string }
  | { kind: 'pdf'; base64: string };

/**
 * 组装一页的用户消息：只有页码和页面本身，不带客户姓名或任何档案资料（M1 Q9、M2 4.2）。
 */
export function buildExtractionContent(
  page: ExtractionPageInput,
  pageNumber: number,
  pageCount: number,
): ExtractionContentPart[] {
  return [
    {
      type: 'text',
      text: `这是同一份报告的第 ${pageNumber} 页，共 ${pageCount} 页。请按规则转录这一页。`,
    },
    page.kind === 'image'
      ? { type: 'image', mediaType: page.mediaType, data: page.base64 }
      : { type: 'pdf', data: page.base64 },
  ];
}
