import type { TwinDomain, TwinDomainView, TwinLevel } from '@health-buddy/shared';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LEVEL_MARKERS } from './levels';
import styles from './Twin.module.css';

/**
 * 简化的二维人体轮廓（规格 2.3，Q18）：四个方面各对应一个区域，只是导航，
 * 点某个区域等同点对应的状态卡片。不画器官，不做三维。
 * 睡眠 → 头部，心血管 → 胸部，代谢 → 腹部，体重 → 全身轮廓。
 */
const REGIONS: { domain: TwinDomain; marker: { x: number; y: number } }[] = [
  { domain: 'weight', marker: { x: 96, y: 214 } },
  { domain: 'sleep', marker: { x: 60, y: 30 } },
  { domain: 'cardiovascular', marker: { x: 60, y: 86 } },
  { domain: 'metabolic', marker: { x: 60, y: 128 } },
];

/** 区域的形状。体重是整个外轮廓（躯干、手臂和腿），画在最下面 */
function RegionShape({ domain }: { domain: TwinDomain }) {
  switch (domain) {
    case 'weight':
      return (
        <path d="M44 52 Q60 46 76 52 L94 60 Q100 64 100 72 L104 136 Q104 142 98 142 L94 140 L90 82 L86 82 L86 150 L82 228 Q82 234 76 234 L66 234 L62 160 L58 160 L54 234 L44 234 Q38 234 38 228 L34 150 L34 82 L30 82 L26 140 L22 142 Q16 142 16 136 L20 72 Q20 64 26 60 Z" />
      );
    case 'sleep':
      return <ellipse cx="60" cy="28" rx="17" ry="20" />;
    case 'cardiovascular':
      return <rect x="38" y="62" width="44" height="46" rx="10" />;
    case 'metabolic':
      return <rect x="38" y="110" width="44" height="38" rx="10" />;
  }
}

export function BodyOutline({
  domains,
  onSelect,
}: {
  domains: readonly TwinDomainView[];
  onSelect: (domain: TwinDomain) => void;
}) {
  const { t } = useTranslation();
  const levelOf = (d: TwinDomain): TwinLevel =>
    domains.find((v) => v.domain === d)?.level ?? 'unknown';
  const onKey = (e: KeyboardEvent, domain: TwinDomain) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(domain);
    }
  };
  return (
    <svg
      className={styles.body}
      viewBox="0 0 120 240"
      role="group"
      aria-label={t('twin.body.label')}
    >
      {REGIONS.map(({ domain, marker }) => {
        const level = levelOf(domain);
        const label = t('twin.body.region', {
          domain: t(`twin.domains.${domain}`),
          level: t(`twin.levels.${level}`),
        });
        return (
          <g
            key={domain}
            className={styles.region}
            data-domain={domain}
            data-level={level}
            role="button"
            tabIndex={0}
            aria-label={label}
            onClick={() => onSelect(domain)}
            onKeyDown={(e) => onKey(e, domain)}
          >
            <title>{label}</title>
            <RegionShape domain={domain} />
            <circle className={styles.regionMarkerBg} cx={marker.x} cy={marker.y} r="8" />
            <text
              className={styles.regionMarker}
              x={marker.x}
              y={marker.y}
              textAnchor="middle"
              dominantBaseline="central"
              aria-hidden
            >
              {LEVEL_MARKERS[level]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
