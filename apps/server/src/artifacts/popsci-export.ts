import {
  POPSCI_FOOTER,
  PRODUCT_NAME,
  popsciSignatureLine,
  type PopsciContent,
  type PopsciSignature,
} from '@health-buddy/shared';
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';
// pptxgenjs 的类型按 CommonJS 声明，ESM 下默认导出在命名空间的 default 上（运行时也是）
import * as pptxModule from 'pptxgenjs';

const PptxGenJS = pptxModule.default as unknown as typeof pptxModule.default.default;
type Slide = ReturnType<InstanceType<typeof PptxGenJS>['addSlide']>;
import { ExportFontMissingError, findFont } from './export-renderer.js';

/**
 * 科普的导出（M8 规格 2.1 第 7、8 条，Q1、Q5）：医疗风格的统一模板，不放 Logo。
 * 白底、深灰正文、标题和细线用蓝绿色；末尾两句固定提示和署名由这里拼接，不由模型生成。
 * 只渲染已审核的结构化内容，不接触任何客户数据（科普不读客户数据）。
 */

const ACCENT = '0E6E7E';
const TEXT = '1F2937';
const MUTED = '6B7280';
const FONT = 'Noto Sans CJK SC';

export interface PopsciExportInput {
  content: PopsciContent;
  signature: PopsciSignature;
  /** YYYY-MM-DD */
  date: string;
}

function titleOf(content: PopsciContent): string {
  return content.kind === 'community_post' ? '' : content.title;
}

/** 文章导出 Word */
export async function renderPopsciDocx({
  content,
  signature,
  date,
}: PopsciExportInput): Promise<Buffer> {
  if (content.kind !== 'popsci_article') throw new Error('docx export is only for articles');
  const run = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) =>
    new TextRun({
      text,
      font: FONT,
      size: opts.size ?? 24,
      bold: opts.bold ?? false,
      color: opts.color ?? TEXT,
    });
  const children: Paragraph[] = [
    new Paragraph({
      children: [run(content.title, { size: 40, bold: true, color: ACCENT })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [run(date, { size: 20, color: MUTED })],
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 6 } },
      spacing: { after: 240 },
    }),
  ];
  for (const s of content.sections) {
    children.push(
      new Paragraph({
        children: [run(s.heading, { size: 28, bold: true, color: ACCENT })],
        spacing: { before: 240, after: 120 },
      }),
    );
    for (const line of s.body.split('\n').filter((l) => l.trim())) {
      children.push(new Paragraph({ children: [run(line)], spacing: { after: 120, line: 360 } }));
    }
  }
  if (content.summary) {
    children.push(
      new Paragraph({ children: [run(content.summary, { bold: true })], spacing: { before: 240 } }),
    );
  }
  children.push(
    new Paragraph({
      children: [run(POPSCI_FOOTER.join('；'), { size: 20, color: MUTED })],
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 6 } },
      spacing: { before: 360 },
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [run(popsciSignatureLine(signature), { size: 20, color: MUTED })],
    }),
  );
  const doc = new Document({
    creator: PRODUCT_NAME,
    title: content.title,
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

/** 文章导出 PDF（沿用通俗版导出的中文字体） */
export function renderPopsciPdf({ content, signature, date }: PopsciExportInput): Promise<Buffer> {
  if (content.kind !== 'popsci_article') throw new Error('pdf export is only for articles');
  const f = findFont();
  if (!f) throw new ExportFontMissingError();
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: { Title: content.title, Producer: PRODUCT_NAME, Creator: PRODUCT_NAME },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    if (f.postscript) pdf.registerFont('cjk', f.path, f.postscript);
    else pdf.registerFont('cjk', f.path);
    const accent = `#${ACCENT}`;
    const rule = () => {
      const y = pdf.y + 4;
      pdf
        .moveTo(56, y)
        .lineTo(pdf.page.width - 56, y)
        .lineWidth(1)
        .strokeColor(accent)
        .stroke();
      pdf.moveDown(0.8);
    };
    pdf.font('cjk');
    pdf.fontSize(22).fillColor(accent).text(content.title);
    pdf.moveDown(0.2).fontSize(10).fillColor(`#${MUTED}`).text(date);
    rule();
    for (const s of content.sections) {
      pdf.moveDown(0.6).fontSize(15).fillColor(accent).text(s.heading);
      pdf.moveDown(0.3).fontSize(12).fillColor(`#${TEXT}`).text(s.body, { lineGap: 6 });
    }
    if (content.summary) pdf.moveDown(0.8).fontSize(12).fillColor(`#${TEXT}`).text(content.summary);
    pdf.moveDown(1.2);
    rule();
    pdf.fontSize(10).fillColor(`#${MUTED}`).text(POPSCI_FOOTER.join('；'));
    pdf.moveDown(0.3).text(popsciSignatureLine(signature), { align: 'right' });
    pdf.end();
  });
}

/** 讲座导出 PPTX：标题页 + 每页标题和要点（讲稿放在备注里）+ 最后一页固定提示和署名 */
export async function renderPopsciPptx({
  content,
  signature,
  date,
}: PopsciExportInput): Promise<Buffer> {
  if (content.kind !== 'lecture_deck') throw new Error('pptx export is only for decks');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = signature.managerName;
  pptx.company = PRODUCT_NAME;
  pptx.title = content.title;
  const bar = (slide: Slide) =>
    slide.addShape('rect', {
      x: 0,
      y: 0,
      w: 10,
      h: 0.12,
      fill: { color: ACCENT },
      line: { color: ACCENT },
    });

  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  bar(cover);
  cover.addText(titleOf(content), {
    x: 0.6,
    y: 1.8,
    w: 8.8,
    h: 1.2,
    fontFace: FONT,
    fontSize: 36,
    bold: true,
    color: ACCENT,
  });
  cover.addText([signature.managerName, signature.operatorName].filter(Boolean).join(' · '), {
    x: 0.6,
    y: 3.2,
    w: 8.8,
    h: 0.5,
    fontFace: FONT,
    fontSize: 16,
    color: MUTED,
  });
  cover.addText(date, {
    x: 0.6,
    y: 3.7,
    w: 8.8,
    h: 0.4,
    fontFace: FONT,
    fontSize: 12,
    color: MUTED,
  });

  for (const s of content.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    bar(slide);
    slide.addText(s.title, {
      x: 0.6,
      y: 0.4,
      w: 8.8,
      h: 0.8,
      fontFace: FONT,
      fontSize: 26,
      bold: true,
      color: ACCENT,
    });
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      {
        x: 0.8,
        y: 1.4,
        w: 8.4,
        h: 3.6,
        fontFace: FONT,
        fontSize: 18,
        color: TEXT,
        valign: 'top',
        paraSpaceAfter: 8,
      },
    );
    if (s.notes) slide.addNotes(s.notes);
  }

  const end = pptx.addSlide();
  end.background = { color: 'FFFFFF' };
  bar(end);
  end.addText(POPSCI_FOOTER.join('\n'), {
    x: 0.6,
    y: 1.8,
    w: 8.8,
    h: 1.2,
    fontFace: FONT,
    fontSize: 20,
    color: TEXT,
    align: 'center',
  });
  end.addText(popsciSignatureLine(signature), {
    x: 0.6,
    y: 3.4,
    w: 8.8,
    h: 0.5,
    fontFace: FONT,
    fontSize: 12,
    color: MUTED,
    align: 'center',
  });

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}
