import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { inspectFile, previewPage, sniffMimeType, splitPages } from './file-inspect.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + compatible.length * 4;
  const box = Buffer.alloc(size + 8);
  box.writeUInt32BE(size, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(major, 8, 'latin1');
  compatible.forEach((b, i) => box.write(b, 16 + i * 4, 'latin1'));
  return box;
}

async function pdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
  return Buffer.from(await doc.save());
}

describe('按文件头判断类型（Q2）', () => {
  it('认得 PNG、JPEG、PDF 和 HEIC', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMimeType(ftyp('heic'))).toBe('image/heic');
    expect(sniffMimeType(ftyp('mif1', ['heic']))).toBe('image/heic');
  });

  it('不认可执行文件、压缩包、Word、AVIF 和纯文本，不看扩展名', () => {
    expect(sniffMimeType(Buffer.from('MZ\x90\x00', 'latin1'))).toBeNull();
    expect(sniffMimeType(Buffer.from('PK\x03\x04', 'latin1'))).toBeNull();
    expect(sniffMimeType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBeNull();
    expect(sniffMimeType(ftyp('avif', ['mif1']))).toBeNull();
    expect(sniffMimeType(Buffer.from('report.pdf'))).toBeNull();
  });
});

describe('检查文件', () => {
  it('数 PDF 页数，算出指纹；空文件、坏的 PDF 不支持', async () => {
    const r = await inspectFile(await pdf(3));
    expect(r).toMatchObject({ ok: true, file: { mimeType: 'application/pdf', pageCount: 3 } });
    if (r.ok) expect(r.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await inspectFile(Buffer.alloc(0))).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await inspectFile(Buffer.from('%PDF-1.7 broken'))).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
  });

  it('超过 20 MB 拒绝', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    expect(await inspectFile(big)).toEqual({ ok: false, reason: 'file_too_large' });
  });

  it('PDF 拆成单页，预览按页返回，超出范围为空', async () => {
    const src = await pdf(2);
    const pages = await splitPages(src, 'application/pdf');
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      expect(p.kind).toBe('pdf');
      expect((await PDFDocument.load(p.data)).getPageCount()).toBe(1);
    }
    expect((await previewPage(src, 'application/pdf', 2))?.contentType).toBe('application/pdf');
    expect(await previewPage(src, 'application/pdf', 3)).toBeNull();
    expect(await previewPage(PNG, 'image/png', 2)).toBeNull();
    expect((await previewPage(PNG, 'image/png', 1))?.body.equals(PNG)).toBe(true);
  });
});
