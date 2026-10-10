/**
 * Cuisine circles (design-spec §3.21) + horizontal snap "train".
 *
 *   <CuisineTrain label="Cuisines">
 *     <CuisineCircle slug="all" label="All" selected={!cuisine} onClick={() => setCuisine(null)} />
 *     {cuisines.map((c) => <CuisineCircle key={c.slug} slug={c.slug} label={c.name} imageUrl={c.imageUrl}
 *       selected={cuisine === c.slug} onClick={() => setCuisine(c.slug)} />)}
 *   </CuisineTrain>
 *   <CuisineCircle variant="marketing" slug="biryani" label="Biryani" to="/?cuisine=biryani" />   // link (board 00)
 *
 * Disc colour = color-mix(<cuisine hue> pct%, var(--card)) — works in both themes. Art = the extracted
 * illustration for known slugs; `imageUrl` (if given) wins; unknown slugs use the "all" art.
 */
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { CuisineArt, cuisineMeta } from '../illustrations';
import { IconButton } from './Button';

export interface CuisineCircleProps {
  slug: string;
  label: string;
  imageUrl?: string | null;
  selected?: boolean;
  onClick?: () => void;
  to?: string;
  variant?: 'app' | 'marketing' | 'small';
  index?: number;
  className?: string;
}

const V = {
  app: { box: 'w-24 gap-2 text-[13px] text-fg-2', disc: 'size-[88px] border border-line', art: 'size-[72px]', hover: 'group-hover:-translate-y-[3px] group-hover:shadow-card' },
  marketing: {
    box: 'w-[110px] gap-2.5 text-sm font-bold text-fg max-sm:w-[92px]',
    disc: 'size-[100px] border-[3px] border-card shadow-[0_0_0_1.5px_var(--line)] max-sm:size-[84px]',
    art: 'size-[78px] max-sm:size-[64px]',
    hover: 'group-hover:-translate-y-1 group-hover:shadow-[0_0_0_2px_var(--pri),var(--shadow)]',
  },
  small: { box: 'w-[76px] gap-2 text-[12.5px] font-semibold text-fg-2', disc: 'size-16 border-2 border-card shadow-[0_0_0_1.5px_var(--line)]', art: 'size-10', hover: '' },
};

export function CuisineCircle({ slug, label, imageUrl, selected, onClick, to, variant = 'app', index, className }: CuisineCircleProps) {
  const meta = cuisineMeta(slug);
  const v = V[variant];
  const inner = (
    <>
      <span
        className={cn(
          'grid shrink-0 place-items-center overflow-hidden rounded-full transition-[transform,box-shadow,border-color] duration-[250ms]',
          v.disc,
          v.hover,
          selected && 'border-pri! shadow-[0_0_0_2px_var(--pri)]!',
        )}
        style={{ background: `color-mix(in srgb, ${meta.hue} ${meta.pct}%, var(--card))` }}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <CuisineArt slug={slug} className={cn(v.art, 'transition-transform duration-[350ms] group-hover:-rotate-[8deg] group-hover:scale-[1.06]')} />
        )}
      </span>
      <span className={cn('text-center leading-tight', selected && 'font-semibold text-fg')}>{label}</span>
    </>
  );
  const cls = cn('group flex shrink-0 snap-start flex-col items-center animate-rise', v.box, className);
  const style = index !== undefined ? { animationDelay: `${index * 0.04}s` } : undefined;
  if (to) {
    return (
      <Link to={to} className={cls} style={style} aria-current={selected ? 'true' : undefined}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-pressed={selected ?? false} className={cls} style={style}>
      {inner}
    </button>
  );
}

/**
 * Horizontal scroll-snap row. `header` renders above-left (e.g. the h2); `controls` adds 36px prev/next
 * outline buttons above-right (hidden on phones).
 */
export function CuisineTrain({ children, label, header, controls = false, className }: { children: ReactNode; label: string; header?: ReactNode; controls?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * Math.max(240, (ref.current?.clientWidth ?? 600) * 0.7), behavior: 'smooth' });
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {header || controls ? (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">{header}</div>
          {controls ? (
            <div className="hidden shrink-0 gap-2 sm:flex">
              <IconButton icon="chevron-left" label="Scroll left" variant="outline" size="sm" onClick={() => scroll(-1)} />
              <IconButton icon="chevron-right" label="Scroll right" variant="outline" size="sm" onClick={() => scroll(1)} />
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        ref={ref}
        role="list"
        aria-label={label}
        className="no-scrollbar flex snap-x snap-mandatory gap-[18px] overflow-x-auto px-0.5 pb-1.5 pt-1 [mask-image:linear-gradient(90deg,#000_92%,transparent)] max-sm:gap-4"
      >
        {Array.isArray(children)
          ? children.flat().map((c, i) => (
              <div role="listitem" key={i} className="contents">
                {c}
              </div>
            ))
          : <div role="listitem" className="contents">{children}</div>}
      </div>
    </div>
  );
}
