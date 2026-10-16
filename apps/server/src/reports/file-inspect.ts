import { createHash } from 'node:crypto';
import { REPORT_UPLOAD_LIMITS, type ReportMimeType } from '@health-buddy/shared';
import heicConvert from 'heic-convert';
import { PDFDocument } from 'pdf-lib';

/**
 * 上传文件的检查（M2 规格 2.3 第 3 条、Q2、Q3）：按文件内容（文件头）判断类型，不信任扩展名和
 * 浏览器给的类型；数页数；拆页和转换格式给识别用。
 */

export interface InspectedFile {
  mimeType: ReportMimeType;
  pageCount: number;
  sha256: string;
}

export type InspectFailure = 'unsupported_type' | 'file_too_large';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);

/** 按文件头判断类型；不是支持的格式返回 null（Word、Excel、压缩包、改了扩展名的可执行文件等） */
export function sniffMimeType(buf: Buffer): ReportMimeType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PDF 规范允许文件头前有少量字节，最多看前 1024 字节
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'application/pdf';
  if (isHeic(buf)) return 'image/heic';
  return null;
}

/** ISO BMFF：第 4–8 字节是 ftyp，主品牌或兼容品牌是 HEIC 系列（AVIF 等不算） */
function isHeic(buf: Buffer): boolean {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const boxSize = buf.readUInt32BE(0);
  const end = Math.min(boxSize >= 16 ? boxSize : 16, buf.length);
  const major = buf.toString('latin1', 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  for (let i = 16; i + 4 <= end; i += 4) {
    if (HEIC_BRANDS.has(buf.toString('latin1', i, i + 4))) return true;
  }
  return false;
}

async function loadPdf(buf: Buffer): Promise<PDFDocument> {
  // 加密的 PDF 读不了页面，按不支持处理
  return PDFDocument.load(buf, { updateMetadata: false });
}

/** 检查一个文件：类型、大小、页数。不通过时返回原因，不抛出带文件内容的异常 */
export async function inspectFile(
  buf: Buffer,
): Promise<{ ok: true; file: InspectedFile } | { ok: false; reason: InspectFailure }> {
  if (buf.length === 0) return { ok: false, reason: 'unsupported_type' };
  if (buf.length > REPORT_UPLOAD_LIMITS.maxFileBytes)
    return { ok: false, reason: 'file_too_large' };
  const mimeType = sniffMimeType(buf);
  if (!mimeType) return { ok: false, reason: 'unsupported_type' };
  let pageCount = 1;
  if (mimeType === 'application/pdf') {
    try {
      pageCount = (await loadPdf(buf)).getPageCount();
    } catch {
      return { ok: false, reason: 'unsupported_type' };
    }
    if (pageCount < 1) return { ok: false, reason: 'unsupported_type' };
  }
  return {
    ok: true,
    file: { mimeType, pageCount, sha256: createHash('sha256').update(buf).digest('hex') },
  };
}

/** 识别用的一页：图片（PNG、JPEG）或单页 PDF，base64 */
export type ExtractionPage =
  | { kind: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: Buffer }
  | { kind: 'pdf'; data: Buffer };

/** 把一个原件拆成逐页：PDF 拆成单页 PDF，HEIC 转成 JPEG（两家模型都不收 HEIC） */
export async function splitPages(buf: Buffer, mimeType: ReportMimeType): Promise<ExtractionPage[]> {
  switch (mimeType) {
    case 'image/png':
    case 'image/jpeg':
      return [{ kind: 'image', mediaType: mimeType, data: buf }];
    case 'image/heic':
      return [{ kind: 'image', mediaType: 'image/jpeg', data: await heicToJpeg(buf) }];
    case 'application/pdf': {
      const src = await loadPdf(buf);
      const pages: ExtractionPage[] = [];
      for (let i = 0; i < src.getPageCount(); i++) {
        pages.push({ kind: 'pdf', data: await singlePagePdf(src, i) });
      }
      return pages;
    }
  }
}

async function singlePagePdf(src: PDFDocument, index: number): Promise<Buffer> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const [page] = await out.copyPages(src, [index]);
  if (page) out.addPage(page);
  return Buffer.from(await out.save());
}

export async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 });
  return Buffer.from(out instanceof ArrayBuffer ? new Uint8Array(out) : out);
}

/**
 * 原件预览的一页（规格 2.4 左栏）：图片原样返回（HEIC 转成 JPEG，浏览器大多不支持 HEIC），
 * PDF 返回指定的单页。page 从 1 开始，超出范围返回 null。
 */
export async function previewPage(
  buf: Buffer,
  mimeType: ReportMimeType,
  page: number,
): Promise<{ contentType: string; body: Buffer } | null> {
  if (mimeType === 'application/pdf') {
    const src = await loadPdf(buf);
    if (page < 1 || page > src.getPageCount()) return null;
    return { contentType: 'application/pdf', body: await singlePagePdf(src, page - 1) };
  }
  if (page !== 1) return null;
  if (mimeType === 'image/heic') return { contentType: 'image/jpeg', body: await heicToJpeg(buf) };
  return { contentType: mimeType, body: buf };
}
