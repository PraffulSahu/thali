/** A deliverable restaurant in discovery/search lists (PRD C-2): open state, ETA estimate, delivery fee, rating or "New". */
import { Link } from 'react-router';
import { Badge, FoodMarker, Icon, Price } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { DiscoveryRestaurant } from './api';
import { DemoBadge, EtaText } from './parts';

export function RatingBadge({ rating }: { rating: { average: number; count: number } | null }) {
  if (!rating) return <Badge tone="neutral">New</Badge>;
  return (
    <Badge tone="success" icon="star">
      {rating.average.toFixed(1)} <span className="sr-only">out of 5 from</span>
      <span className="font-normal">({rating.count})</span>
    </Badge>
  );
}

export const priceBandLabel = (b: number | null) => (b ? '₹'.repeat(b) : null);

export function RestaurantCard({ r }: { r: DiscoveryRestaurant }) {
  return (
    <li className="list-none">
      <Link
        to={`/restaurants/${r.slug || r.id}`}
        className={cn(
          'group block overflow-hidden rounded-card border border-slate-200 bg-surface shadow-raised transition-[box-shadow,border-color] hover:border-slate-300 hover:shadow-overlay focus-visible:outline-none',
          !r.open && 'opacity-80',
        )}
      >
        <div className="relative aspect-[16/9] bg-slate-100">
          {r.imageUrl ? (
            <img src={r.imageUrl} alt="" loading="lazy" className={cn('h-full w-full object-cover', !r.open && 'grayscale')} />
          ) : (
            <div className="grid h-full place-items-center text-slate-400" aria-hidden>
              <Icon name="store" size={36} />
            </div>
          )}
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            {!r.open ? <Badge tone="neutral" variant="solid">{r.nextOpenAt ? `Closed · opens ${formatTime(r.nextOpenAt)}` : 'Closed now'}</Badge> : null}
            <DemoBadge show={r.isDemo} />
          </div>
        </div>
        <div className="space-y-1 p-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-slate-900 group-hover:underline">{r.name}</h3>
            <RatingBadge rating={r.rating} />
          </div>
          <p className="flex items-center gap-1.5 truncate text-sm text-slate-600">
            {r.isVeg === 'PURE_VEG' ? (
              <span className="inline-flex items-center gap-1 text-veg">
                <FoodMarker veg size={12} /> Pure veg ·
              </span>
            ) : null}
            {r.cuisines.join(', ')}
            {priceBandLabel(r.priceBand) ? <span aria-label={`price band ${r.priceBand} of 3`}> · {priceBandLabel(r.priceBand)}</span> : null}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <EtaText minutes={r.etaMinutes} distanceKm={r.distanceKm} source={r.etaSource} />
            <span className="text-sm text-slate-700">
              Delivery <Price paise={r.deliveryFeePaise} size="sm" freeLabel="free" />
            </span>
          </div>
          {r.matchedItems?.length ? (
            <p className="truncate text-sm text-slate-600">
              Matches: {r.matchedItems.slice(0, 3).map((i) => i.name).join(', ')}
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
