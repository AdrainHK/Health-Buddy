/**
 * 协会主色的对比度检查（M7 规格 2.2）。前后端共用：后台实时提示，后端保存前再查一次。
 * 按 WCAG 2.x 相对亮度计算。
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(color: string): boolean {
  return HEX.test(color);
}

function rgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** 主色和白色背景（以及白色按钮文字）的对比度下限 */
export const BRAND_MIN_CONTRAST = 4.5;

/** 深色模式的背景和按钮文字（packages/ui tokens.css 的 --hb-bg、--hb-brand-contrast） */
const DARK_BG = '#0e1311';
const DARK_TEXT = '#06120f';

export function brandColorContrastOk(color: string): boolean {
  return isHexColor(color) && contrastRatio(color, '#ffffff') >= BRAND_MIN_CONTRAST;
}

/**
 * 深色模式用的主色：往白色方向混合，直到在深色背景上、配深色按钮文字都够清楚。
 * 浅色主色本来就够亮时原样返回。
 */
export function brandDarkVariant(color: string): string {
  if (!isHexColor(color)) return color;
  const base = rgb(color);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const mixed = toHex(base.map((v) => v + (255 - v) * t) as [number, number, number]);
    if (
      contrastRatio(mixed, DARK_BG) >= BRAND_MIN_CONTRAST &&
      contrastRatio(mixed, DARK_TEXT) >= BRAND_MIN_CONTRAST
    ) {
      return mixed;
    }
  }
  return '#ffffff';
}
