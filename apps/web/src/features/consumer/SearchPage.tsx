/** Search deliverable restaurants and dishes (PRD C-3): `GET /discovery/search?lat&lng&q` (debounced, query in URL). */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Card, EmptyState, ErrorState, Field, FoodMarker, Input, PageHeader, Price, SkeletonList } from '../../components/ui';
import { api } from '../../lib/api';
import type { SearchResult } from './api';
import { LocationPicker } from './LocationPicker';
import { useChosenLocation } from './location';
import { RestaurantCard } from './RestaurantCard';

export default function SearchPage() {
  const loc = useChosenLocation();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);

  useEffect(() => {
    const t = setTimeout(() => {
      const v = input.trim();
      if (v !== q) setParams(v ? { q: v } : {}, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [input, q, setParams]);

  const search = useQuery({
    queryKey: ['search', loc?.lat, loc?.lng, q],
    queryFn: () => api<SearchResult>('/discovery/search', { auth: false, query: { lat: loc!.lat, lng: loc!.lng, q } }),
    enabled: !!loc && q.length > 0,
  });

  return (
    <>
      <PageHeader title="Search" description="Restaurants and dishes that deliver to you." />
      {!loc ? (
        <Card className="max-w-xl">
          <p className="mb-3 text-sm text-slate-700">Set your delivery location first so we only show places that deliver to you.</p>
          <LocationPicker onDone={() => undefined} />
        </Card>
      ) : (
        <div className="space-y-5">
          <form role="search" onSubmit={(e) => e.preventDefault()}>
            <Field label="Search restaurants or dishes" hideLabel>
              <Input icon="search" type="search" placeholder="Biryani, dosa, pizza…" value={input} maxLength={100} onChange={(e) => setInput(e.target.value)} />
            </Field>
          </form>
          {!q ? (
            <EmptyState icon="search" title="What are you craving?" description="Type a dish, cuisine or restaurant name." compact />
          ) : search.isPending ? (
            <div role="status">
              <span className="sr-only">Searching…</span>
              <SkeletonList count={3} />
            </div>
          ) : search.isError ? (
            <ErrorState error={search.error} title="Search failed" onRetry={() => void search.refetch()} />
          ) : !search.data.serviceable ? (
            <EmptyState icon="location" title="We don't deliver here yet" description={`No delivery area covers ${loc.label}.`} action={<Button onClick={() => setParams({})}>Clear search</Button>} />
          ) : search.data.restaurants.length === 0 && search.data.items.length === 0 ? (
            <EmptyState icon="search" title={`No results for “${q}”`} description="Check the spelling or try a broader term." />
          ) : (
            <>
              {search.data.items.length ? (
                <section aria-labelledby="dish-results">
                  <h2 id="dish-results" className="mb-2 text-lg font-semibold text-slate-900">
                    Dishes
                  </h2>
                  <ul className="divide-y divide-slate-100 rounded-card border border-slate-200 bg-surface">
                    {search.data.items.map((i) => (
                      <li key={`${i.restaurantId}-${i.id}`}>
                        <Link to={`/restaurants/${i.restaurantId}#item-${i.id}`} className="flex min-h-touch items-center gap-3 px-3 py-2 hover:bg-slate-50">
                          <FoodMarker veg={i.isVeg} />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium text-slate-900">{i.name}</span>
                            <span className="block text-sm text-slate-600">{i.restaurantName}</span>
                          </span>
                          <Price paise={i.pricePaise} size="sm" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {search.data.restaurants.length ? (
                <section aria-labelledby="restaurant-results">
                  <h2 id="restaurant-results" className="mb-2 text-lg font-semibold text-slate-900">
                    Restaurants
                  </h2>
                  <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {search.data.restaurants.map((r) => (
                      <RestaurantCard key={r.id} r={r} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      )}
    </>
  );
}
