import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import type { ReportSample, ReportSampleRow } from '@health-buddy/skills';
import PDFDocument from 'pdfkit';

/**
 * 合成体检报告样本（M2 规格 4.4）：把评测用例里的报告描述渲染成 PDF 或“手机照片”（PNG）。
 * 姓名、电话、证件号都是合成的，用来检查识别输出里不出现个人信息。
 */

export interface RenderedPage {
  mimeType: 'application/pdf' | 'image/png';
  data: Buffer;
}

/** 中文字体候选：CI 装 Noto Sans CJK，本地可以用文泉驿，或用 REPORT_SAMPLE_FONT 指定 */
const FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
];
const FAMILY = 'HBReportSample';
/** 合成样本用的字体族名（聊天截图样本共用） */
export const SAMPLE_FONT_FAMILY = FAMILY;
let fontPath: string | null | undefined;

/** 找到并注册中文字体；没有时返回 null */
export function findFont(): string | null {
  if (fontPath !== undefined) return fontPath;
  const custom = process.env.REPORT_SAMPLE_FONT;
  fontPath = [...(custom ? [custom] : []), ...FONT_CANDIDATES].find((p) => existsSync(p)) ?? null;
  if (fontPath) GlobalFonts.registerFromPath(fontPath, FAMILY);
  return fontPath;
}

/** 渲染样本需要的中文字体是否可用（评测开始前检查，缺字体时直接报清楚，而不是每个用例都出错） */
export function sampleFontAvailable(): boolean {
  return findFont() !== null;
}

export class SampleFontMissingError extends Error {
  constructor() {
    super('report sample font missing');
    this.name = 'SampleFontMissingError';
  }
}

function headerLines(sample: ReportSample): string[] {
  const p = sample.person;
  return [
    `姓名：${p.name}    电话：${p.phone}`,
    `身份证号：${p.idNumber}`,
    `体检机构：${sample.institution}    体检日期：${sample.date}`,
  ];
}

const COLUMNS = ['项目', '结果', '单位', '参考范围'];
/** 检验科常见的带“代号”的表格；“提示”列留空（没有印 ↑↓） */
const CODED_COLUMNS = ['代号', '项目名称', '结果', '提示', '单位', '参考范围'];

function columnsOf(sample: ReportSample): string[] {
  return sample.layout === 'coded' ? CODED_COLUMNS : COLUMNS;
}

/** 一行的各个格子；layout 为 coded 时多出代号和空的提示列 */
function cells(row: ReportSampleRow, sample?: ReportSample): string[] {
  if (sample?.layout === 'coded') {
    return [row.code ?? '', row.name, row.value, '', row.unit ?? '', row.ref ?? ''];
  }
  return [row.name, row.value, row.unit ?? '', row.ref ?? ''];
}

/** 结果在第几列（看不清时打码这一格） */
function valueColumn(sample: ReportSample): number {
  return sample.layout === 'coded' ? 2 : 1;
}

/** 渲染成一个多页 PDF（清晰的电子版） */
export function renderSamplePdf(sample: ReportSample): Promise<Buffer> {
  const font = findFont();
  if (!font) throw new SampleFontMissingError();
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48, autoFirstPage: false });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.registerFont(FAMILY, font, font.endsWith('.ttc') ? fontPostscript(font) : undefined);
    pdf.font(FAMILY);
    sample.pages.forEach((rows, index) => {
      pdf.addPage();
      pdf.fontSize(18).text(sample.title, { align: 'center' });
      pdf.moveDown(0.5).fontSize(10);
      if (index === 0) for (const line of headerLines(sample)) pdf.text(line);
      pdf.moveDown();
      if (sample.kind === 'not_a_report') {
        pdf.fontSize(12).text(sample.freeText ?? '');
      } else {
        // coded：项目名称列较窄，长名称折成两行（和常见的检验单一样）
        const widths = sample.layout === 'coded' ? [60, 120, 60, 40, 60, 110] : [180, 90, 80, 120];
        const drawRow = (values: string[], bold = false) => {
          const y = pdf.y;
          let x = 48;
          let height = 0;
          values.forEach((v, i) => {
            const width = widths[i] ?? 80;
            pdf.fontSize(bold ? 11 : 10).text(v, x, y, { width });
            height = Math.max(height, pdf.heightOfString(v || ' ', { width }));
            x += width;
          });
          pdf.x = 48;
          pdf.y = y + height;
          pdf.moveDown(0.6);
        };
        // 表格跨页时第 2 页没有表头
        if (index === 0) drawRow(columnsOf(sample), true);
        for (const row of rows) {
          const values = cells(row, sample);
          if (row.blurred) values[valueColumn(sample)] = '';
          drawRow(values);
        }
        if (sample.injection && index === 0) {
          pdf.moveDown().fontSize(8).text(sample.injection);
        }
      }
      pdf
        .fontSize(8)
        .text(`第 ${index + 1} 页 / 共 ${sample.pages.length} 页`, 48, 780, { align: 'center' });
    });
    pdf.end();
  });
}

function fontPostscript(path: string): string {
  return path.includes('wqy') ? 'WenQuanYiZenHei' : 'NotoSansCJKsc-Regular';
}

/** 渲染成“手机照片”：每页一张 PNG，略微倾斜，带阴影和噪点；看不清的格子打码 */
export function renderSamplePhotos(sample: ReportSample): Buffer[] {
  if (!findFont()) throw new SampleFontMissingError();
  return sample.pages.map((rows, index) => {
    const width = 1200;
    const height = 1600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // 桌面背景
    ctx.fillStyle = '#6b5b4a';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate((-3 * Math.PI) / 180);
    ctx.translate(-width / 2, -height / 2);
    // 纸
    ctx.fillStyle = '#f7f5ef';
    ctx.fillRect(80, 80, width - 160, height - 160);
    drawPage(ctx, sample, rows, index);
    ctx.restore();
    // 阴影：左上到右下渐暗
    const shade = ctx.createLinearGradient(0, 0, width, height);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
    return canvas.toBuffer('image/png');
  });
}

function drawPage(
  ctx: SKRSContext2D,
  sample: ReportSample,
  rows: ReportSampleRow[],
  index: number,
) {
  ctx.fillStyle = '#1d1d1d';
  ctx.font = `44px ${FAMILY}`;
  ctx.textAlign = 'center';
  ctx.fillText(sample.title, 600, 180);
  ctx.textAlign = 'left';
  ctx.font = `24px ${FAMILY}`;
  let y = 250;
  if (index === 0) {
    for (const line of headerLines(sample)) {
      ctx.fillText(line, 130, y);
      y += 40;
    }
  }
  y += 30;
  if (sample.kind === 'not_a_report') {
    ctx.font = `30px ${FAMILY}`;
    for (const part of (sample.freeText ?? '').split('；')) {
      ctx.fillText(part, 130, y);
      y += 56;
    }
    return;
  }
  const coded = sample.layout === 'coded';
  const xs = coded ? [130, 240, 560, 680, 760, 860] : [130, 520, 700, 860];
  const valueCol = valueColumn(sample);
  ctx.font = `bold 26px ${FAMILY}`;
  columnsOf(sample).forEach((c, i) => ctx.fillText(c, xs[i] ?? 130, y));
  y += 50;
  ctx.font = `26px ${FAMILY}`;
  for (const row of rows) {
    let lines = 1;
    // 看不清的格子不画数值，只留一块污渍
    cells(row, sample).forEach((c, i) => {
      if (row.blurred && i === valueCol) return;
      const x = xs[i] ?? 130;
      const width = (xs[i + 1] ?? 1100) - x - 12;
      // 名称太长时折成两行
      const parts = wrapText(ctx, c, width);
      parts.forEach((part, k) => ctx.fillText(part, x, y + k * 34));
      lines = Math.max(lines, parts.length);
    });
    if (row.blurred) {
      ctx.fillStyle = 'rgba(90,80,70,0.85)';
      ctx.fillRect((xs[valueCol] ?? 520) - 10, y - 30, 150, 42);
      ctx.fillStyle = '#1d1d1d';
    }
    y += 48 + (lines - 1) * 34;
  }
  if (sample.injection && index === 0) {
    ctx.font = `18px ${FAMILY}`;
    ctx.fillText(sample.injection.slice(0, 50), 130, y + 40);
    ctx.fillText(sample.injection.slice(50), 130, y + 70);
  }
  ctx.font = `20px ${FAMILY}`;
  ctx.fillText(`第 ${index + 1} 页 / 共 ${sample.pages.length} 页`, 520, 1460);
}

/** 按宽度把一格文字折成几行（逐字折，中文没有空格） */
function wrapText(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (line && ctx.measureText(line + ch).width > width) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

/** 按用例的渲染方式输出：pdf 是一个文件，photo 是每页一张 PNG */
export async function renderSample(sample: ReportSample): Promise<RenderedPage[]> {
  if (sample.render === 'pdf') {
    return [{ mimeType: 'application/pdf', data: await renderSamplePdf(sample) }];
  }
  return renderSamplePhotos(sample).map((data) => ({ mimeType: 'image/png', data }));
}

/** 把样本写到目录里，方便手动上传到预览环境试用 */
export async function writeReportSamples(
  dir: string,
  samples: { id: string; sample: ReportSample }[],
): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const { id, sample } of samples) {
    const pages = await renderSample(sample);
    pages.forEach((p, i) => {
      const name =
        p.mimeType === 'application/pdf'
          ? `${id}.pdf`
          : `${id}-${String(i + 1).padStart(2, '0')}.png`;
      writeFileSync(join(dir, name), p.data);
      written.push(name);
    });
  }
  return written;
}
