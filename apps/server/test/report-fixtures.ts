import { randomUUID } from 'node:crypto';
import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * 报告上传测试用的合成文件和模拟识别结果。全部是虚构数据。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 文件头是 PNG 的合成文件；tag 让每个文件的指纹不同 */
export function syntheticPng(tag: string = randomUUID()): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(`synthetic-report-${tag}`)]);
}

/** 合成的多页 PDF */
export async function syntheticPdf(pages: number, tag: string = randomUUID()): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(`synthetic report ${tag} page ${i + 1}`, { x: 10, y: 100, size: 8, font });
  }
  return Buffer.from(await doc.save());
}

/** 把可执行文件改名成 .pdf：文件头是 MZ */
export function renamedExe(): Buffer {
  return Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), Buffer.alloc(64)]);
}

export interface ItemSpec {
  indicator: string;
  value: string;
  unit?: string | null;
  referenceRange?: string | null;
  snippet?: string;
  unreadable?: boolean;
}

/** 模型识别一页的结构化输出 */
export function pageJson(
  items: ItemSpec[],
  extra: { category?: string; reportDate?: string | null; institution?: string | null } = {},
): string {
  return JSON.stringify({
    category: extra.category ?? 'report',
    reportDate: extra.reportDate === undefined ? '2026-05-01' : extra.reportDate,
    institution: extra.institution === undefined ? '合成体检中心' : extra.institution,
    items: items.map((i) => ({
      indicator: i.indicator,
      value: i.value,
      unit: i.unit ?? null,
      referenceRange: i.referenceRange ?? null,
      snippet: i.snippet ?? `${i.indicator} ${i.value}`,
      unreadable: i.unreadable ?? false,
    })),
  });
}

interface Script {
  text?: string;
  finishReason?: 'complete' | 'refused';
  /** 抛出这个错误（模拟厂商出错） */
  error?: Error;
}

/** 按顺序返回识别结果的模拟厂商，记录每次收到的请求 */
export class ExtractionProvider implements Provider {
  readonly name = 'openai' as const;
  readonly calls: GatewayRequest[] = [];
  queue: Script[] = [];

  push(...texts: string[]): void {
    this.queue.push(...texts.map((text) => ({ text })));
  }

  async *stream(req: GatewayRequest, route: ResolvedRoute): AsyncIterable<GatewayEvent> {
    this.calls.push(req);
    const script = this.queue.shift() ?? { text: pageJson([], { category: 'not_a_report' }) };
    await Promise.resolve();
    if (script.error) throw script.error;
    if (script.text) yield { type: 'text', delta: script.text };
    yield {
      type: 'done',
      finishReason: script.finishReason ?? 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.queue = [];
  }
}
