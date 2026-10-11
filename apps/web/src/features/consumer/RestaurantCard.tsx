/**
 * Discovery item → design-system RestaurantCard (design-spec §3.20, 10-31): cover/hue art, Pure veg, chili state
 * badge ("Opens at 6:00 PM" / "Not accepting orders"), rating or "New" (≥5 rule), cuisines + price band,
 * "32 min est. · 2.1 km · ₹29 delivery" or "Closed now", MKT-8 offer badge only when the API sends one.
 * Search results add "Matches: Chicken Dum Biryani · ₹279" lines.
 */
import { useQuery } from '@tanstack/react-query';
import { RestaurantCard as Card } from '../../components/ui';
import { formatINR } from '../../lib/format';
import { cuisineName, CUISINES_KEY, fetchCuisines, type Cuisine, type DiscoveryRestaurant } from './api';
import { istTime } from './parts';

export function useCuisines() {
  return useQuery({ queryKey: CUISINES_KEY, queryFn: fetchCuisines, staleTime: 10 * 60_000 });
}

/** "Opens at 6:00 PM" (today, IST) / "Opens Tue, 11:00 AM". */
export function opensLabel(iso: string, now = Date.now()): string {
  const day = (d: number | string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(d));
  if (day(iso) === day(now)) return `Opens at ${istTime(iso)}`;
  const wd = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date(iso));
  return `Opens ${wd}, ${istTime(iso)}`;
}

/** State badge for a closed restaurant (null when open). Paused = "Not accepting orders" (MKT-3). */
export function closedStateLabel(r: Pick<DiscoveryRestaurant, 'open' | 'closedReason' | 'nextOpenAt'>): string | null {
  if (r.open) return null;
  if (r.closedReason === 'PAUSED') return 'Not accepting orders';
  if (r.nextOpenAt) return opensLabel(r.nextOpenAt);
  return 'Closed now';
}

export function DiscoveryCard({ r, cuisines, index }: { r: DiscoveryRestaurant; cuisines?: Cuisine[]; index?: number }) {
  return (
    <li className="flex list-none flex-col">
      <Card
        to={`/restaurants/${r.slug || r.id}`}
        id={r.id}
        name={r.name}
        imageUrl={r.imageUrl}
        cuisines={r.cuisines.slice(0, 2).map((c) => cuisineName(c, cuisines))}
        priceBand={r.priceBand}
        rating={r.rating ? { avg: r.rating.average, count: r.rating.count } : null}
        etaMin={r.etaMinutes}
        distanceKm={r.distanceKm}
        deliveryFeePaise={r.deliveryFeePaise}
        open={r.open}
        stateLabel={closedStateLabel(r)}
        pureVeg={r.isVeg === 'PURE_VEG'}
        offer={r.offer ?? null}
        index={index}
        className="h-full"
      />
      {r.matchedItems?.length ? (
        <ul aria-label={`Dishes matching your search at ${r.name}`} className="mt-2 flex flex-col gap-1 px-1">
          {r.matchedItems.slice(0, 3).map((m) => (
            <li key={m.id} className="truncate text-[13.5px] text-fg-2">
              <span className="text-fg-3">Matches:</span> {m.name} · {formatINR(m.pricePaise).replace(/\.00$/, '')}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
