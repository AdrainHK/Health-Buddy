import { existsSync } from 'node:fs';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { PRODUCT_NAME } from '@health-buddy/shared';
import PDFDocument from 'pdfkit';

/**
 * 已审核产物通俗版的图片和 PDF（规格 3.6、Q1）。
 * 版式由后端固定：标题、日期、正文（末尾是免责声明）、产品名称。
 * 只渲染传进来的通俗版文本，不接触专业版和危急指标。
 */

/** 中文字体候选：部署镜像装 Noto Sans CJK；本地开发可以用文泉驿，或用 EXPORT_FONT_PATH 指定 */
const FONT_CANDIDATES: { path: string; postscript: string }[] = [
  {
    path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    postscript: 'NotoSansCJKsc-Regular',
  },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', postscript: 'WenQuanYiZenHei' },
];

export interface ExportDocument {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** 交付给客户的文本：通俗版、免责声明和产品名称 */
  body: string;
}

let font: { path: string; postscript: string } | null | undefined;

function findFont(): { path: string; postscript: string } | null {
  if (font !== undefined) return font;
  const custom = process.env.EXPORT_FONT_PATH;
  const candidates = custom
    ? [{ path: custom, postscript: process.env.EXPORT_FONT_POSTSCRIPT ?? '' }, ...FONT_CANDIDATES]
    : FONT_CANDIDATES;
  font = candidates.find((c) => existsSync(c.path)) ?? null;
  if (font) GlobalFonts.registerFromPath(font.path, 'HBExport');
  return font;
}

export class ExportFontMissingError extends Error {
  constructor() {
    super('export font missing');
    this.name = 'ExportFontMissingError';
  }
}

export function renderPdf(doc: ExportDocument): Promise<Buffer> {
  const f = findFont();
  if (!f) throw new ExportFontMissingError();
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: { Title: doc.title, Producer: PRODUCT_NAME, Creator: PRODUCT_NAME },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    if (f.postscript) pdf.registerFont('cjk', f.path, f.postscript);
    else pdf.registerFont('cjk', f.path);
    pdf.font('cjk');
    pdf.fontSize(20).fillColor('#1f2937').text(doc.title);
    pdf.moveDown(0.3).fontSize(10).fillColor('#6b7280').text(doc.date);
    pdf.moveDown(1).fontSize(12).fillColor('#111827').text(doc.body, { lineGap: 6 });
    pdf.end();
  });
}

const PNG_WIDTH = 1080;
const PADDING = 72;
const BODY_SIZE = 34;
const LINE_HEIGHT = 56;
const TITLE_SIZE = 48;
const TITLE_LINE_HEIGHT = 66;

/** 按宽度逐字折行（中文没有空格，不能按词折） */
function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const ch of paragraph) {
      if (ctx.measureText(line + ch).width > width && line) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

export function renderPng(doc: ExportDocument): Buffer {
  const f = findFont();
  if (!f) throw new ExportFontMissingError();
  const measure = createCanvas(PNG_WIDTH, 100).getContext('2d');
  measure.font = `${BODY_SIZE}px HBExport`;
  const lines = wrap(measure, doc.body, PNG_WIDTH - PADDING * 2);
  measure.font = `${TITLE_SIZE}px HBExport`;
  const titleLines = wrap(measure, doc.title, PNG_WIDTH - PADDING * 2);
  const header = titleLines.length * TITLE_LINE_HEIGHT + 54;
  const height = PADDING * 2 + header + lines.length * LINE_HEIGHT;

  const canvas = createCanvas(PNG_WIDTH, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PNG_WIDTH, height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#1f2937';
  ctx.font = `${TITLE_SIZE}px HBExport`;
  titleLines.forEach((line, i) => ctx.fillText(line, PADDING, PADDING + i * TITLE_LINE_HEIGHT));
  ctx.fillStyle = '#6b7280';
  ctx.font = `26px HBExport`;
  ctx.fillText(doc.date, PADDING, PADDING + titleLines.length * TITLE_LINE_HEIGHT);
  ctx.fillStyle = '#111827';
  ctx.font = `${BODY_SIZE}px HBExport`;
  lines.forEach((line, i) => ctx.fillText(line, PADDING, PADDING + header + i * LINE_HEIGHT));
  return canvas.toBuffer('image/png');
}
