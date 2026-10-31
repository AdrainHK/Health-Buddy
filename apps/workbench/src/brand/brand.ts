import { brandDarkVariant } from '@health-buddy/shared';
import { applyBrandColor, clearBrandColor } from '@health-buddy/ui';

const LOGIN_HASH = /^#\/login\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\/?$/;

/** 协会登录地址 /#/login/<协会简称>（Q4）；不是这种地址返回 null */
export function loginSlugFromHash(hash: string = window.location.hash): string | null {
  return LOGIN_HASH.exec(hash)?.[1] ?? null;
}

/** 应用协会主色（深色模式用按对比度算出的变体）；没有主色时恢复默认 */
export function applyOperatorColor(color: string | null | undefined): void {
  if (color) applyBrandColor(color, document.documentElement, brandDarkVariant(color));
  else clearBrandColor();
}
