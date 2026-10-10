/**
 * Illustrations ported from the design export (design-spec §4). Inline SVG React components; dish art uses
 * fixed literal colours (it sits on tinted discs, so it reads in both themes). Decorative by default
 * (aria-hidden); size them with className (`size-[72px]`) or width/height.
 *
 *   <CuisineArt slug="biryani" className="size-[72px]" />      // unknown slug → "all" art
 *   CUISINES['south-indian'] → { label, hue, pct }             // disc colour: color-mix(<hue> pct%, var(--card))
 *   <LogoMark ring />  <RestaurantCoverArt className="text-[#c2410c]" />  <MapRouteArt />
 */
import type { ReactElement, SVGProps } from 'react';

type Svg = SVGProps<SVGSVGElement>;
const deco = { 'aria-hidden': true, focusable: false } as const;

/* ------------------------------------------------------------------ cuisines (board 10 versions) */

const ART: Record<string, ReactElement> = {
  all: (
    <>
      <circle cx="40" cy="40" r="28" fill="#f4efe8" stroke="#d6cfc4" strokeWidth="2" />
      <circle cx="30" cy="31" r="8" fill="#e8a33d" /><circle cx="50" cy="31" r="8" fill="#5f8f3a" />
      <circle cx="30" cy="51" r="8" fill="#b4441e" /><circle cx="50" cy="51" r="8" fill="#f1e2b8" />
    </>
  ),
  biryani: (
    <>
      <path d="M14 42h52a26 22 0 0 1-52 0z" fill="#8a4b2a" /><path d="M14 42h52" stroke="#6b3a20" strokeWidth="3" />
      <ellipse cx="40" cy="38" rx="24" ry="13" fill="#f5e6c4" />
      <path d="M26 36q6-6 12-1M40 32q6-4 12 2M30 42q8-3 14 1" stroke="#e8a33d" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="47" cy="40" r="3" fill="#b4441e" /><path d="M52 28c4-4 9-3 10 0-4 3-8 3-10 0z" fill="#5f8f3a" />
    </>
  ),
  'chai-snacks': (
    <>
      <path d="M22 30h30l-3 32H25z" fill="#f4efe6" stroke="#d6cdbd" strokeWidth="2" /><path d="M24 38h26l-1 10H25z" fill="#b8742a" />
      <path d="M52 36h6a6 6 0 0 1 0 12h-7" fill="none" stroke="#d6cdbd" strokeWidth="3" />
      <path d="M31 24c-3-4 3-6 0-10M41 24c-3-4 3-6 0-10" stroke="#b8ac9f" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M56 60l10-16 10 16z" fill="#e0a43a" />
    </>
  ),
  chinese: (
    <>
      <path d="M14 40h52a26 24 0 0 1-52 0z" fill="#c62f2f" /><ellipse cx="40" cy="40" rx="26" ry="9" fill="#f0c66b" />
      <path d="M22 40q4-5 8 0t8 0 8 0 8 0 8 0" stroke="#d99d34" strokeWidth="2.5" fill="none" />
      <circle cx="34" cy="37" r="2.5" fill="#5f8f3a" /><circle cx="48" cy="38" r="2.5" fill="#e06a2c" />
      <path d="M50 12 60 38M58 10 64 37" stroke="#4a3426" strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  coastal: (
    <>
      <path d="M8 50C20 22 56 16 72 26 62 52 30 62 8 50z" fill="#4c8a34" /><path d="M12 48 68 28" stroke="#3a6e27" strokeWidth="2" />
      <path d="M22 44c8-10 24-12 34-6-8 8-24 10-34 6z" fill="#d9773a" /><path d="M56 38l8-6v12z" fill="#c25f28" />
      <circle cx="28" cy="42" r="1.8" fill="#3a2a20" />
      <path d="M34 40q4 3 8 0M42 39q4 3 8 0" stroke="#f2b37a" strokeWidth="1.5" fill="none" /><circle cx="60" cy="52" r="4" fill="#f5e04a" />
    </>
  ),
  desserts: (
    <>
      <path d="M14 42h52a26 20 0 0 1-52 0z" fill="#e9e2d6" /><ellipse cx="40" cy="42" rx="26" ry="8" fill="#f2c26b" />
      <circle cx="30" cy="38" r="8" fill="#7a3417" /><circle cx="48" cy="37" r="8" fill="#8a3d1b" /><circle cx="40" cy="44" r="8" fill="#6c2d13" />
      <path d="M27 35a3 3 0 0 1 4-2M45 34a3 3 0 0 1 4-2M37 41a3 3 0 0 1 4-2" stroke="#c77b4e" strokeWidth="2" fill="none" strokeLinecap="round" />
    </>
  ),
  healthy: (
    <>
      <path d="M12 40h56a28 24 0 0 1-56 0z" fill="#ffffff" stroke="#e1dbd0" strokeWidth="2" />
      <path d="M18 40c2-10 10-14 16-10 4-8 14-8 18 0 6-2 12 2 12 10z" fill="#6aa84f" />
      <circle cx="30" cy="36" r="5" fill="#e04b3a" /><circle cx="50" cy="34" r="5" fill="#e04b3a" />
      <ellipse cx="40" cy="38" rx="6" ry="4" fill="#f4d35e" />
      <path d="M24 40c6-2 10 0 12-4M44 40c4-3 10-2 12 0" stroke="#3d7a2c" strokeWidth="2" fill="none" />
    </>
  ),
  'north-indian': (
    <>
      <ellipse cx="44" cy="44" rx="22" ry="20" fill="#b8742a" /><ellipse cx="44" cy="40" rx="18" ry="14" fill="#d9542b" />
      <path d="M34 38q4-3 8 0M46 42q4-3 8 0" stroke="#f3c08a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="40" cy="44" r="3" fill="#fff4e0" />
      <path d="M10 36c4-12 18-14 22-6 3 7-3 16-12 18-7 1-12-5-10-12z" fill="#f1d9a6" stroke="#d8b878" strokeWidth="1.5" />
      <circle cx="18" cy="38" r="1.6" fill="#a8743a" /><circle cx="24" cy="33" r="1.6" fill="#a8743a" />
    </>
  ),
  pizza: (
    <>
      <path d="M18 22c14-6 30-6 44 0L40 68z" fill="#f2c55c" /><path d="M18 22c14-6 30-6 44 0l-3 6c-12-5-26-5-38 0z" fill="#c98a3a" />
      <circle cx="34" cy="34" r="5" fill="#c62f2f" /><circle cx="47" cy="38" r="5" fill="#c62f2f" /><circle cx="40" cy="50" r="4" fill="#c62f2f" />
      <circle cx="30" cy="44" r="2" fill="#4c8a34" /><circle cx="51" cy="29" r="2" fill="#4c8a34" />
    </>
  ),
  rolls: (
    <g transform="rotate(-30 40 40)">
      <rect x="16" y="30" width="48" height="20" rx="10" fill="#efd39a" />
      <rect x="16" y="30" width="20" height="20" rx="10" fill="#f7f1e4" stroke="#d9cdb4" />
      <ellipse cx="64" cy="40" rx="5" ry="10" fill="#c9562a" /><path d="M60 33l4 3M60 47l4-3" stroke="#5f8f3a" strokeWidth="2.5" />
      <path d="M40 32v16M48 32v16" stroke="#d8b26e" strokeWidth="1.5" />
    </g>
  ),
  'south-indian': (
    <>
      <circle cx="40" cy="40" r="28" fill="#ffffff" stroke="#e4ddd2" strokeWidth="2" />
      <path d="M18 50 60 24l4 8-40 24z" fill="#d9952f" /><path d="M18 50 60 24" stroke="#b8741c" strokeWidth="2" />
      <path d="M26 47l30-18" stroke="#efc06a" strokeWidth="2" strokeLinecap="round" />
      <circle cx="28" cy="28" r="7" fill="#f2f0e6" stroke="#cfc9bb" /><circle cx="54" cy="54" r="7" fill="#c9562a" />
    </>
  ),
};

export interface CuisineMeta {
  label: string;
  /** Disc hue; background = color-mix(in srgb, hue pct%, var(--card)). */
  hue: string;
  pct: number;
}

/** Known cuisine slugs (GET /cuisines) with art. Order = default display order. */
export const CUISINES: Record<string, CuisineMeta> = {
  all: { label: 'All', hue: '#71717a', pct: 14 },
  biryani: { label: 'Biryani', hue: '#c2410c', pct: 16 },
  'south-indian': { label: 'South Indian', hue: '#a16207', pct: 16 },
  'north-indian': { label: 'North Indian', hue: '#b45309', pct: 16 },
  chinese: { label: 'Chinese', hue: '#b91c1c', pct: 14 },
  coastal: { label: 'Coastal', hue: '#0e7490', pct: 15 },
  rolls: { label: 'Rolls', hue: '#a16207', pct: 13 },
  pizza: { label: 'Pizza', hue: '#ca8a04', pct: 14 },
  healthy: { label: 'Healthy', hue: '#15803d', pct: 14 },
  desserts: { label: 'Desserts', hue: '#be185d', pct: 13 },
  'chai-snacks': { label: 'Chai & Snacks', hue: '#7c2d12', pct: 13 },
};

export function cuisineMeta(slug: string): CuisineMeta {
  return CUISINES[slug] ?? CUISINES.all!;
}

export function hasCuisineArt(slug: string): boolean {
  return slug in ART;
}

export function CuisineArt({ slug, ...rest }: Svg & { slug: string }) {
  return (
    <svg viewBox="0 0 80 80" {...deco} {...rest}>
      {ART[slug] ?? ART.all}
    </svg>
  );
}

/* ------------------------------------------------------------------ hero (board 00 simplified versions) */

export function HeroBiryani(props: Svg) {
  return <CuisineArt slug="biryani" {...props} />;
}

export function HeroDosa(props: Svg) {
  return (
    <svg viewBox="0 0 80 80" {...deco} {...props}>
      <circle cx="40" cy="40" r="28" fill="#fff" stroke="#e4ddd2" strokeWidth="2" />
      <path d="M18 50 60 24l4 8-40 24z" fill="#d9952f" /><path d="M26 47l30-18" stroke="#efc06a" strokeWidth="2" strokeLinecap="round" />
      <circle cx="28" cy="28" r="7" fill="#f2f0e6" stroke="#cfc9bb" /><circle cx="54" cy="54" r="7" fill="#c9562a" />
    </svg>
  );
}

export function HeroGulabJamun(props: Svg) {
  return (
    <svg viewBox="0 0 80 80" {...deco} {...props}>
      <path d="M14 42h52a26 20 0 0 1-52 0z" fill="#e9e2d6" /><ellipse cx="40" cy="42" rx="26" ry="8" fill="#f2c26b" />
      <circle cx="30" cy="38" r="8" fill="#7a3417" /><circle cx="48" cy="37" r="8" fill="#8a3d1b" /><circle cx="40" cy="44" r="8" fill="#6c2d13" />
    </svg>
  );
}

export function HeroNoodles(props: Svg) {
  return (
    <svg viewBox="0 0 80 80" {...deco} {...props}>
      <path d="M14 40h52a26 24 0 0 1-52 0z" fill="#c62f2f" /><ellipse cx="40" cy="40" rx="26" ry="9" fill="#f0c66b" />
      <path d="M22 40q4-5 8 0t8 0 8 0 8 0 8 0" stroke="#d99d34" strokeWidth="2.5" fill="none" />
      <path d="M50 12 60 38M58 10 64 37" stroke="#4a3426" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function HeroSunBlobs(props: Svg) {
  return (
    <svg viewBox="0 0 500 460" preserveAspectRatio="xMidYMid slice" {...deco} {...props}>
      <circle cx="420" cy="60" r="120" fill="#ff9d1a" opacity=".6" />
      <circle cx="60" cy="420" r="140" fill="#ffcf5c" opacity=".7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ brand */

/** Logo mark: chili disc (var(--pri)) + two white dots + turmeric dot; `ring` adds the public-header ring. */
export function LogoMark({ size = 28, ring, className }: { size?: number; ring?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} {...deco}>
      <circle cx="16" cy="16" r="16" fill="var(--pri, #d23f11)" />
      {ring ? <circle cx="16" cy="16" r="11.5" fill="none" stroke="#fff" strokeWidth="1.5" opacity=".55" /> : null}
      <circle cx="12" cy="13" r="3.2" fill="#fff" />
      <circle cx="20.5" cy="13" r="3.2" fill="#ffc145" />
      <circle cx="16" cy="20.5" r="3.6" fill="#fff" />
    </svg>
  );
}

export function PromoRestaurantsMark(props: Svg) {
  return (
    <svg viewBox="0 0 220 220" {...deco} {...props}>
      <circle cx="110" cy="110" r="100" fill="none" stroke="#fff" strokeWidth="10" />
      <circle cx="80" cy="85" r="22" fill="#fff" /><circle cx="140" cy="85" r="22" fill="#fff" /><circle cx="110" cy="145" r="26" fill="#fff" />
    </svg>
  );
}

export function PromoRidersBike(props: Svg) {
  return (
    <svg viewBox="0 0 240 200" {...deco} {...props}>
      <circle cx="60" cy="140" r="40" fill="none" stroke="#ffc145" strokeWidth="10" />
      <circle cx="190" cy="140" r="40" fill="none" stroke="#ffc145" strokeWidth="10" />
      <path d="M60 140h70l30-70h30M90 70h40" fill="none" stroke="#ffc145" strokeWidth="10" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ placeholders */

/** Restaurant cover placeholder; colour = `currentColor` (restaurant hue). */
export function RestaurantCoverArt(props: Svg) {
  return (
    <svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice" {...deco} {...props}>
      <circle cx="210" cy="75" r="92" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="1.5" />
      <circle cx="210" cy="75" r="64" fill="currentColor" fillOpacity=".14" />
      <circle cx="190" cy="58" r="20" fill="currentColor" fillOpacity=".55" />
      <circle cx="232" cy="64" r="14" fill="currentColor" fillOpacity=".35" />
      <circle cx="210" cy="100" r="18" fill="currentColor" fillOpacity=".45" />
    </svg>
  );
}

/** Restaurant logo placeholder (96px tile, 64px art); colour = `currentColor`. */
export function RestaurantLogoArt(props: Svg) {
  return (
    <svg viewBox="0 0 64 64" {...deco} {...props}>
      <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeOpacity=".4" strokeWidth="2" />
      <circle cx="25" cy="26" r="8" fill="currentColor" fillOpacity=".6" />
      <circle cx="40" cy="28" r="6" fill="currentColor" fillOpacity=".35" />
      <circle cx="32" cy="42" r="8" fill="currentColor" fillOpacity=".45" />
    </svg>
  );
}

/** Tracking map placeholder (board 13): blocks, roads, dashed route, restaurant dot, home pin, moving rider. */
export function MapRouteArt({ animate = true, ...props }: Svg & { animate?: boolean }) {
  const route = 'M70 230 L240 230 L240 130 L520 130 L520 60 L730 60';
  return (
    <svg viewBox="0 0 800 280" preserveAspectRatio="xMidYMid slice" {...deco} {...props}>
      <rect x="40" y="20" width="160" height="170" rx="12" fill="var(--blk)" />
      <rect x="280" y="160" width="200" height="100" rx="12" fill="var(--blk)" />
      <rect x="560" y="90" width="200" height="170" rx="12" fill="var(--blk)" />
      <rect x="280" y="10" width="200" height="90" rx="12" fill="var(--blk)" />
      <path d="M0 230H800M240 0V280M0 130H800M520 0V280M0 60H800" stroke="var(--road)" strokeWidth="14" />
      <path
        d={route}
        fill="none"
        stroke="var(--acc)"
        strokeWidth="4"
        strokeDasharray="10 6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? 'animate-dash' : undefined}
      />
      <circle cx="70" cy="230" r="10" fill="var(--fg)" /><circle cx="70" cy="230" r="4" fill="var(--bg)" />
      <path d="M730 38c-8 0-14 6-14 14 0 10 14 24 14 24s14-14 14-24c0-8-6-14-14-14z" fill="var(--acc)" />
      <circle cx="730" cy="52" r="5" fill="var(--bg)" />
      <g
        style={{
          offsetPath: `path('${route}')`,
          offsetDistance: '58%',
          animation: animate ? 'ride 10s ease-in-out infinite alternate' : undefined,
        }}
      >
        <circle r="17" fill="var(--pri)" stroke="var(--bg)" strokeWidth="3" />
        <path
          d="M-8 4a3 3 0 1 0 0 .1M8 4a3 3 0 1 0 0 .1M-8 4h6l3-7h3M-5-3h4"
          fill="none"
          stroke="var(--pri-fg)"
          strokeWidth="2"
          strokeLinecap="round"
          transform="translate(0 -1)"
        />
      </g>
    </svg>
  );
}
