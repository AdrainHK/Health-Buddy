const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidBrandColor(color: string): boolean {
  return HEX_COLOR.test(color);
}

/**
 * 应用运营商品牌色。只需设置一个变量，悬停色和浅底色由设计令牌自动推导。
 * 传入非法颜色时不做任何改动，保持默认品牌色。
 */
export function applyBrandColor(
  color: string,
  root: HTMLElement = document.documentElement,
): boolean {
  if (!isValidBrandColor(color)) return false;
  root.style.setProperty('--hb-brand', color);
  return true;
}
