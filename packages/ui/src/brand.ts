const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidBrandColor(color: string): boolean {
  return HEX_COLOR.test(color);
}

/**
 * 应用运营商品牌色。浅色模式用 color，深色模式用 dark（由调用方按对比度算好，
 * 见 @health-buddy/shared 的 brandDarkVariant）；不传 dark 时深色模式保持默认。
 * 悬停色和浅底色由设计令牌自动推导。传入非法颜色时不做任何改动，保持默认品牌色。
 */
export function applyBrandColor(
  color: string,
  root: HTMLElement = document.documentElement,
  dark?: string,
): boolean {
  if (!isValidBrandColor(color)) return false;
  root.style.setProperty('--hb-brand-custom', color);
  if (dark && isValidBrandColor(dark)) root.style.setProperty('--hb-brand-custom-dark', dark);
  else root.style.removeProperty('--hb-brand-custom-dark');
  return true;
}

/** 恢复默认品牌色（退出登录、离开协会登录页时） */
export function clearBrandColor(root: HTMLElement = document.documentElement): void {
  root.style.removeProperty('--hb-brand-custom');
  root.style.removeProperty('--hb-brand-custom-dark');
}
