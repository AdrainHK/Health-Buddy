import type { BrandLogoType } from '@health-buddy/shared';

/**
 * 协会 Logo 的格式检查（M7 规格 2.2）：按内容判断，不信文件名和 Content-Type。
 * - PNG：文件头和 IHDR 里的宽高（32–2048 像素，宽高比不超过 4:1）；
 * - SVG：根元素是 <svg>，有 viewBox 或宽高；不能带脚本、事件属性、外部引用和实体声明。
 *   SVG 只在 <img> 里显示（不执行脚本），下载接口另加 CSP sandbox，这里再挡一层。
 */
export type LogoCheck =
  | { ok: true; type: BrandLogoType }
  | { ok: false; reason: 'unsupported_type' | 'bad_dimensions' | 'unsafe_svg' };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_SIDE = 32;
const MAX_SIDE = 2048;
const MAX_RATIO = 4;

const UNSAFE_SVG = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*(?:iframe|embed|object|audio|video|image)\b/i,
  /<!\s*(?:ENTITY|DOCTYPE)/i,
  /javascript\s*:/i,
  /\son[a-z]+\s*=/i,
  // 只允许 # 开头的内部引用
  /\bhref\s*=\s*["']\s*(?!#)/i,
  /url\(\s*["']?\s*(?!#)/i,
  /@import/i,
];

function dimensionsOk(w: number, h: number): boolean {
  return (
    w >= MIN_SIDE &&
    h >= MIN_SIDE &&
    w <= MAX_SIDE &&
    h <= MAX_SIDE &&
    Math.max(w, h) / Math.min(w, h) <= MAX_RATIO
  );
}

function checkPng(buf: Buffer): LogoCheck {
  if (buf.length < 24 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return { ok: false, reason: 'unsupported_type' };
  }
  return dimensionsOk(buf.readUInt32BE(16), buf.readUInt32BE(20))
    ? { ok: true, type: 'image/png' }
    : { ok: false, reason: 'bad_dimensions' };
}

function checkSvg(buf: Buffer): LogoCheck {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, reason: 'unsupported_type' };
  }
  const body = text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^>]*\?>/, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/, '')
    .trimStart();
  // 先查危险内容（DOCTYPE、实体声明会写在根元素之前）
  if (/<svg\b/i.test(text) && UNSAFE_SVG.some((re) => re.test(text))) {
    return { ok: false, reason: 'unsafe_svg' };
  }
  const root = /^<svg\b[^>]*>/i.exec(body);
  if (!root) return { ok: false, reason: 'unsupported_type' };
  const tag = root[0];
  const viewBox =
    /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  const width = /\bwidth\s*=\s*["']\s*([\d.]+)/i.exec(tag);
  const height = /\bheight\s*=\s*["']\s*([\d.]+)/i.exec(tag);
  const [w, h] = viewBox
    ? [Number(viewBox[1]), Number(viewBox[2])]
    : width && height
      ? [Number(width[1]), Number(height[1])]
      : [0, 0];
  // 矢量图只看宽高比
  if (!(w > 0 && h > 0) || Math.max(w, h) / Math.min(w, h) > MAX_RATIO) {
    return { ok: false, reason: 'bad_dimensions' };
  }
  return { ok: true, type: 'image/svg+xml' };
}

export function checkLogo(buf: Buffer): LogoCheck {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return checkPng(buf);
  return checkSvg(buf);
}
