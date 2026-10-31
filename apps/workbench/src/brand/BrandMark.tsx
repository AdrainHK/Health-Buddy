import { PRODUCT_NAME } from '@health-buddy/shared';
import { Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 品牌标识：协会 Logo 和“××协会 · Health Buddy”（M7 规格 2.3）；没有协会品牌时只显示 Health Buddy。
 * logoClass、nameClass 由所在位置（登录页、侧栏）提供样式。
 */
export function BrandMark({
  name,
  logoUrl,
  logoClass,
  imageClass,
  showName = true,
}: {
  name: string | null;
  logoUrl: string | null;
  logoClass: string | undefined;
  imageClass: string | undefined;
  showName?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {logoUrl ? (
        <img className={imageClass} src={logoUrl} alt="" />
      ) : (
        <span className={logoClass} aria-hidden>
          <Heart size={16} strokeWidth={2.5} />
        </span>
      )}
      {showName && (
        <span>{name ? t('brand.withProduct', { name, product: PRODUCT_NAME }) : PRODUCT_NAME}</span>
      )}
    </>
  );
}
