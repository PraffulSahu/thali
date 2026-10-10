/**
 * Restaurant card (design-spec §3.20) — presentational; the consumer area maps API data onto it.
 *
 *   <RestaurantCard
 *     to={`/restaurants/${r.slug}`} id={r.id} name={r.name} imageUrl={r.imageUrl}
 *     cuisines={['Biryani', 'Mughlai']} priceBand={2}
 *     rating={{ avg: 4.3, count: 126 }}            // "New" when count < 5 or null (honest-data rule)
 *     etaMin={32} distanceKm={2.1} deliveryFeePaise={2900}
 *     open={r.open} stateLabel={r.open ? undefined : 'Opens at 6:00 PM'}   // or 'Not accepting orders'
 *     pureVeg={r.isVeg} offer={r.offer}            // offer badge ONLY when the API returns one (MKT-8)
 *   />
 *   <RestaurantCard variant="marketing" … />      // horizontal promo card (board 02)
 *   <RatingBadge avg={4.3} count={126} />  <RatingBadge count={2} />  ("New")
 */
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { formatPaise } from './Price';
import { hueFor } from './Avatar';
import { EstBadge } from './EstBadge';
import { PureVegBadge } from './VegMark';
import { RestaurantCoverArt } from '../illustrations';

export const MIN_RATINGS_TO_SHOW = 5;

export function RatingBadge({ avg, count, solid, className }: { avg?: number | null; count?: number | null; solid?: boolean; className?: string }) {
  const rated = avg != null && (count ?? 0) >= MIN_RATINGS_TO_SHOW;
  if (!rated) {
    return (
      <span className={cn('inline-flex h-6 shrink-0 items-center rounded-xs bg-fill px-2 text-xs font-semibold text-fg-3', className)}>
        New
        <span className="sr-only"> — fewer than {MIN_RATINGS_TO_SHOW} ratings</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-xs px-2 text-xs font-semibold tabular-nums',
        solid ? 'bg-[#12813f] text-white' : 'bg-ok-bg text-ok',
        className,
      )}
    >
      <span aria-hidden="true">★</span>
      <span className="sr-only">Rated</span> {avg!.toFixed(1)}
      {count != null ? <span className={solid ? undefined : 'font-medium'}> ({count})</span> : null}
      <span className="sr-only"> ratings</span>
    </span>
  );
}

export interface RestaurantCardProps {
  to: string;
  /** Used to pick the identity hue when there is no image. */
  id: string;
  name: string;
  imageUrl?: string | null;
  cuisines?: string[];
  priceBand?: 1 | 2 | 3 | number | null;
  rating?: { avg?: number | null; count?: number | null } | null;
  etaMin?: number | null;
  /** Mark the ETA as an estimate (default true: every ETA is an estimate). */
  etaEstimate?: boolean;
  distanceKm?: number | null;
  deliveryFeePaise?: number | null;
  /** false → card dims to .62 and "Closed now" replaces the ETA. */
  open?: boolean;
  /** Chili state badge: "Opens at 6:00 PM", "Not accepting orders", "Temporarily not accepting orders". */
  stateLabel?: string | null;
  pureVeg?: boolean;
  offer?: { label: string; code?: string | null } | null;
  variant?: 'app' | 'marketing';
  /** Stagger index for the entrance animation. */
  index?: number;
  className?: string;
}

function Meta({ items }: { items: React.ReactNode[] }) {
  const shown = items.filter(Boolean);
  return (
    <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-fg-2">
      {shown.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-2.5">
          {i > 0 ? <span aria-hidden="true" className="text-fg-3">·</span> : null}
          {it}
        </span>
      ))}
    </p>
  );
}

export function RestaurantCard(props: RestaurantCardProps) {
  const {
    to, id, name, imageUrl, cuisines = [], priceBand, rating, etaMin, etaEstimate = true, distanceKm, deliveryFeePaise,
    open = true, stateLabel, pureVeg, offer, variant = 'app', index, className,
  } = props;
  const hue = hueFor(id);
  const cuisineLine = [...cuisines, priceBand ? '₹'.repeat(Number(priceBand)) : null].filter(Boolean).join(' · ');
  const eta = !open ? 'Closed now' : etaMin != null ? (
    <>
      {etaMin} min{etaEstimate ? ' est.' : ''}
    </>
  ) : null;
  const meta = [
    eta,
    distanceKm != null ? `${distanceKm.toFixed(1)} km` : null,
    deliveryFeePaise != null ? (deliveryFeePaise === 0 ? 'Free delivery' : `${formatPaise(deliveryFeePaise).replace(/\.00$/, '')} delivery`) : null,
  ];

  const cover = (h: string) => (
    <div className={cn('relative overflow-hidden', h)} style={{ background: `color-mix(in srgb, ${hue} 16%, var(--card))` }}>
      {imageUrl ? (
        <img src={imageUrl} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <RestaurantCoverArt className="absolute inset-0 size-full" style={{ color: hue }} />
      )}
      {offer ? (
        <span className="absolute bottom-2.5 left-2.5 rounded-badge bg-[var(--offer-bg)] px-2 py-[5px] text-[11px] font-extrabold leading-none text-[var(--offer-fg)]">
          {offer.label}
        </span>
      ) : null}
    </div>
  );

  if (variant === 'marketing') {
    return (
      <Link to={to} className={cn('flex overflow-hidden rounded-card-lg border border-line bg-card text-fg transition-[border-color,box-shadow] duration-200 hover:border-line-2 hover:shadow-card', className)}>
        <div className="relative w-[150px] shrink-0" style={{ background: 'var(--offer-gradient)' }}>
          {offer ? (
            <span className="absolute bottom-2.5 left-2.5 rounded-badge bg-[var(--offer-bg)] px-2 py-[5px] text-[11px] font-extrabold leading-none text-[var(--offer-fg)]">{offer.label}</span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[7px] px-4 py-3.5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-lg leading-tight">{name}</h3>
            <RatingBadge avg={rating?.avg} count={rating?.count} solid />
          </div>
          {cuisineLine ? <p className="text-sm text-fg-3">{cuisineLine}</p> : null}
          <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold text-fg-2">
            {etaMin != null ? (
              <>
                {etaMin} min <EstBadge />
              </>
            ) : null}
            {distanceKm != null ? <span>· {distanceKm.toFixed(1)} km</span> : null}
            {deliveryFeePaise != null ? <span>· {formatPaise(deliveryFeePaise).replace(/\.00$/, '')} delivery</span> : null}
          </p>
        </div>
      </Link>
    );
  }

  return (
    <Link
      to={to}
      style={index !== undefined ? { animationDelay: `${index * 0.05}s` } : undefined}
      className={cn(
        'group flex animate-rise flex-col overflow-hidden rounded-card border border-line bg-card text-fg no-underline transition-[transform,box-shadow,border-color,opacity] duration-200',
        'hover:-translate-y-[3px] hover:border-line-2 hover:shadow-card',
        !open && 'opacity-[.62]',
        className,
      )}
    >
      <div className="relative border-b border-line">
        {cover('h-[150px] max-sm:h-[140px]')}
        {pureVeg || stateLabel ? (
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            {pureVeg ? <PureVegBadge /> : null}
            {stateLabel ? (
              <span className="inline-flex h-6 items-center rounded-pill bg-pri px-[9px] text-xs font-medium text-pri-fg">{stateLabel}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4 pt-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate font-sans text-base font-semibold tracking-[-0.015em]">{name}</h3>
          <RatingBadge avg={rating?.avg} count={rating?.count} />
        </div>
        {cuisineLine ? <p className="truncate text-[13.5px] text-fg-3">{cuisineLine}</p> : null}
        <Meta items={meta} />
      </div>
    </Link>
  );
}
