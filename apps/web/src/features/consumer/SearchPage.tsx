/**
 * Search (design-spec §5.10 frame + §7.2): `/search?q=` uses the discover grid with the header search filled.
 * `GET /discovery/search?lat&lng&q` (prefix item search on the server) → restaurant cards with their matched
 * dishes listed under each card ("Matches: Chicken Dum Biryani · ₹279"), then any other matching dishes.
 * Empty: "No matches for “…” that deliver to Home".
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, EmptyState, ErrorState, EstLegend, Price, SkeletonCard, VegMark } from '../../components/ui';
import { api } from '../../lib/api';
import { isDemoEstimate, type SearchResult } from './api';
import { CartDock } from './CartDock';
import { LocationDialog } from './LocationPicker';
import { useChosenLocation } from './location';
import { Accent } from './parts';
import { DiscoveryCard, useCuisines } from './RestaurantCard';

export default function SearchPage() {
  const loc = useChosenLocation();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const [changing, setChanging] = useState(false);
  const cuisines = useCuisines();

  const search = useQuery({
    queryKey: ['search', loc?.lat, loc?.lng, q],
    queryFn: () => api<SearchResult>('/discovery/search', { auth: false, query: { lat: loc!.lat, lng: loc!.lng, q } }),
    enabled: !!loc && q.length > 0,
  });

  const data = search.data;
  const covered = new Set(data?.restaurants.map((r) => r.id) ?? []);
  const otherDishes = data?.items.filter((i) => !covered.has(i.restaurantId) || !data.restaurants.find((r) => r.id === i.restaurantId)?.matchedItems?.some((m) => m.id === i.id)) ?? [];

  let body;
  if (!loc) {
    body = (
      <EmptyState
        icon="location"
        title="Set your delivery location first"
        description="We only show restaurants and dishes that can be delivered to you."
        action={<Button onClick={() => setChanging(true)}>Choose location</Button>}
      />
    );
  } else if (!q) {
    body = <EmptyState icon="search" title="What are you craving?" description="Type a dish, cuisine or restaurant name in the search bar above. Press / to jump to it." />;
  } else if (search.isPending) {
    body = (
      <div role="status" aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
        <span className="sr-only">Searching…</span>
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  } else if (search.isError) {
    body = <ErrorState error={search.error} title="Search failed" onRetry={() => void search.refetch()} retrying={search.isFetching} />;
  } else if (!data!.serviceable) {
    body = (
      <EmptyState
        icon="location"
        title="We don't deliver here yet"
        description={`No delivery area covers ${loc.label}.`}
        action={<Button onClick={() => setChanging(true)}>Try another location</Button>}
      />
    );
  } else if (data!.restaurants.length === 0 && data!.items.length === 0) {
    body = <EmptyState icon="search" title={`No matches for “${q}” that deliver to ${loc.label}`} description="Check the spelling, or try a dish or cuisine name." />;
  } else {
    body = (
      <>
        {data!.restaurants.length ? (
          <section aria-labelledby="restaurant-results" className="flex flex-col gap-3">
            <h2 id="restaurant-results" className="text-lg">
              Restaurants
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
              {data!.restaurants.map((r, i) => (
                <DiscoveryCard key={r.id} r={r} cuisines={cuisines.data} index={i % 12} />
              ))}
            </ul>
          </section>
        ) : null}
        {otherDishes.length ? (
          <section aria-labelledby="dish-results" className="flex flex-col gap-3">
            <h2 id="dish-results" className="text-lg">
              Dishes
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
              {otherDishes.map((i) => (
                <li key={`${i.restaurantId}-${i.id}`}>
                  <Link to={`/restaurants/${i.restaurantId}#item-${i.id}`} className="flex min-h-touch items-center gap-3 px-4 py-3 hover:bg-fill">
                    <VegMark veg={i.isVeg} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-fg">{i.name}</span>
                      <span className="block truncate text-[13px] text-fg-3">{i.restaurantName}</span>
                    </span>
                    <Price paise={i.pricePaise} size="sm" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  }

  const demo = data?.restaurants.some((r) => isDemoEstimate(r.etaSource));
  return (
    <>
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-[22px] px-6 pb-10 pt-7 max-sm:px-4 max-sm:pt-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[30px] leading-[1.1] max-sm:text-[28px]">{q ? <>Results for <Accent>“{q}”</Accent></> : 'Search'}</h1>
            <p className="text-sm text-fg-3" aria-live="polite">
              {loc ? `Restaurants and dishes that deliver to ${loc.label}` : 'Restaurants and dishes that deliver to you'}
            </p>
          </div>
          {data?.restaurants.length ? <EstLegend demo={demo} /> : null}
        </div>
        {body}
      </div>
      <CartDock />
      <LocationDialog open={changing} onClose={() => setChanging(false)} />
    </>
  );
}
