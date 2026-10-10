/**
 * Consumer home (PRD C-1..C-3): choose a location, then browse restaurants that actually DELIVER to it
 * (`GET /discovery/restaurants?lat&lng…`, cursor-paginated), with banners, filters and sort. A drop point
 * outside every service area gets a clear "we don't deliver here yet" state.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Card, EmptyState, ErrorState, LoadMore, PageHeader, SkeletonList } from '../../components/ui';
import { api } from '../../lib/api';
import { discoveryQuery, type Banner } from './api';
import { DiscoveryFilters, hasActiveFilters, useDiscoveryFilters } from './DiscoveryFilters';
import { LocationDialog, LocationPicker } from './LocationPicker';
import { useChosenLocation } from './location';
import { RestaurantCard } from './RestaurantCard';

function bannerHref(b: Banner): string {
  if (b.linkType === 'RESTAURANT') return `/restaurants/${b.linkValue}`;
  if (b.linkType === 'CUISINE') return `/?cuisine=${encodeURIComponent(b.linkValue)}`;
  return '/cart';
}

function Banners() {
  const banners = useQuery({
    queryKey: ['banners'],
    queryFn: () => api<{ items: Banner[] }>('/banners', { auth: false }).then((r) => r.items),
    staleTime: 5 * 60_000,
  });
  if (!banners.data?.length) return null;
  return (
    <section aria-label="Offers and highlights" className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
      {banners.data.map((b) => (
        <Link key={b.id} to={bannerHref(b)} className="relative block w-72 shrink-0 snap-start overflow-hidden rounded-card border border-slate-200 bg-slate-100">
          <img src={b.imageUrl} alt="" className="aspect-[2/1] w-full object-cover" loading="lazy" />
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-900/80 to-transparent p-3 text-sm font-semibold text-white">
            {b.title}
            {b.linkType === 'COUPON' ? <span className="ml-1 font-normal">· code {b.linkValue}</span> : null}
          </span>
          {b.isDemo ? (
            <Badge tone="info" className="absolute right-2 top-2">
              Demo
            </Badge>
          ) : null}
        </Link>
      ))}
    </section>
  );
}

export default function HomePage() {
  const loc = useChosenLocation();
  const [filters, setFilters, clearFilters] = useDiscoveryFilters();
  const [changing, setChanging] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['discovery', loc?.lat, loc?.lng, filters],
    queryFn: ({ pageParam }) => discoveryQuery(loc!, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: loc !== null,
  });

  if (!loc) {
    return (
      <>
        <PageHeader title="Where should we deliver?" description="We only show restaurants that can actually deliver to your location." />
        <Card className="max-w-xl">
          <LocationPicker onDone={() => undefined} />
        </Card>
      </>
    );
  }

  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Restaurants near you"
        description={
          <span>
            Delivering to <strong className="font-semibold text-slate-800">{loc.label}</strong>{' '}
            <Button variant="link" size="sm" onClick={() => setChanging(true)}>
              Change
            </Button>
          </span>
        }
      />
      <div className="space-y-5">
        <Banners />
        <DiscoveryFilters value={filters} onChange={setFilters} onClear={clearFilters} />
        <section aria-label="Restaurants" aria-busy={list.isFetching}>
          {list.isPending ? (
            <div role="status">
              <span className="sr-only">Finding restaurants that deliver to you…</span>
              <SkeletonList count={4} />
            </div>
          ) : list.isError && !list.data ? (
            <ErrorState error={list.error} title="Couldn't load restaurants" onRetry={() => void list.refetch()} retrying={list.isFetching} />
          ) : first && !first.serviceable ? (
            <EmptyState
              icon="location"
              title="We don't deliver here yet"
              description={`No delivery area covers ${loc.label}. Try another address — restaurants must be inside an active service area and their delivery radius.`}
              action={<Button onClick={() => setChanging(true)}>Change location</Button>}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon="store"
              title={hasActiveFilters(filters) ? 'No restaurants match these filters' : 'No restaurants deliver here right now'}
              description={hasActiveFilters(filters) ? 'Try removing a filter.' : 'Restaurants may be paused or outside their delivery radius. Check back soon.'}
              action={hasActiveFilters(filters) ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button> : undefined}
            />
          ) : (
            <>
              {first?.serviceArea ? (
                <p className="mb-3 text-sm text-slate-600">
                  {items.length}
                  {list.hasNextPage ? '+' : ''} restaurants deliver to {first.serviceArea.name}
                </p>
              ) : null}
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((r) => (
                  <RestaurantCard key={r.id} r={r} />
                ))}
              </ul>
              <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} label="Show more restaurants" />
            </>
          )}
        </section>
      </div>
      <LocationDialog open={changing} onClose={() => setChanging(false)} />
    </>
  );
}
