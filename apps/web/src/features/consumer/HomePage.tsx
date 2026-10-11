/**
 * Discover (board 10, design-spec §5.10): `/` once a delivery location is set.
 *   cuisine band (`GET /cuisines`, facet counts) · filters (aside ≥1024, pill row below) · "Delivering to Home"
 *   + counts (MKT-2 `counts`, aria-live) · EST. legend · restaurant grid (`GET /discovery/restaurants`, cursor
 *   pages) · admin banners (must-not-lose) · floating multi-cart dock.
 * Pre-states (10-43): skeleton cards · no location → prompt · not serviceable → "We don't deliver here yet" ·
 * error → Retry · empty → Clear filters.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, Button, CuisineCircle, EmptyState, ErrorState, EstLegend, IconButton, LoadMore, SkeletonCard } from '../../components/ui';
import { CuisineArt } from '../../components/illustrations';
import { api } from '../../lib/api';
import { plural } from '../../lib/format';
import { cuisineName, discoveryQuery, isDemoEstimate, type Banner, type Cuisine, type DiscoveryFilterState, type DiscoveryPage } from './api';
import { CartDock } from './CartDock';
import { FiltersAside, FiltersRow, hasActiveFilters, useDiscoveryFilters } from './DiscoveryFilters';
import { LocationDialog } from './LocationPicker';
import { useChosenLocation } from './location';
import { Accent } from './parts';
import { DiscoveryCard, useCuisines } from './RestaurantCard';

function bannerHref(b: Banner): string {
  if (b.linkType === 'RESTAURANT') return `/restaurants/${b.linkValue}`;
  if (b.linkType === 'CUISINE') return `/?cuisine=${encodeURIComponent(b.linkValue)}`;
  return '/offers';
}

/** Admin-configured banners (must-not-lose; "DEMO" labelled). Caption on a --card strip (readable in both themes). */
function Banners() {
  const banners = useQuery({
    queryKey: ['banners'],
    queryFn: () => api<{ items: Banner[] }>('/banners', { auth: false }).then((r) => r.items),
    staleTime: 5 * 60_000,
  });
  if (!banners.data?.length) return null;
  return (
    <section aria-label="Offers and highlights" className="no-scrollbar -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
      {banners.data.map((b) => (
        <Link key={b.id} to={bannerHref(b)} className="group relative flex w-72 shrink-0 snap-start flex-col overflow-hidden rounded-card border border-line bg-card hover:border-line-2 hover:shadow-card">
          <img src={b.imageUrl} alt="" className="aspect-[2/1] w-full bg-fill object-contain" loading="lazy" />
          <span className="flex items-center gap-2 px-3.5 py-2.5 text-[13.5px] font-semibold text-fg">
            <span className="min-w-0 flex-1 truncate">{b.title}</span>
            {b.linkType === 'COUPON' ? <span className="shrink-0 font-mono text-[11px] font-medium text-acc-fg">{b.linkValue}</span> : null}
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

/** 10-09…10-21: cuisine train with prev/next (disabled at the ends). */
function CuisineBand({ cuisines, facets, selected, onSelect }: { cuisines: Cuisine[]; facets?: Map<string, number>; selected: string | null; onSelect: (slug: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [cuisines.length]);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * (ref.current?.clientWidth ?? 600), behavior: 'smooth' });
  const label = (c: Cuisine) => {
    const n = facets?.get(c.slug);
    return n === undefined ? undefined : `${c.name}, ${plural(n, 'restaurant')}`;
  };
  return (
    <section aria-label="Browse by cuisine" className="border-b border-line bg-side backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1360px] flex-col gap-3.5 px-6 pb-[18px] pt-[22px] max-sm:px-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl">
            What are you <Accent>craving?</Accent>
          </h2>
          <div className="ml-auto flex gap-1.5 max-sm:hidden">
            <IconButton icon="chevron-left" label="Scroll cuisines left" variant="outline" size="sm" disabled={edges.start} onClick={() => scroll(-1)} />
            <IconButton icon="chevron-right" label="Scroll cuisines right" variant="outline" size="sm" disabled={edges.end} onClick={() => scroll(1)} />
          </div>
        </div>
        <div ref={ref} onScroll={measure} role="list" aria-label="Cuisines" className="no-scrollbar flex snap-x gap-[18px] overflow-x-auto px-0.5 pb-1.5 pt-1 max-sm:gap-4">
          <div role="listitem" className="contents">
            <CuisineCircle slug="all" label="All" selected={!selected} onClick={() => onSelect(null)} index={0} />
          </div>
          {cuisines.map((c, i) => (
            <div role="listitem" key={c.id} className="contents" aria-label={label(c)}>
              <CuisineCircle slug={c.slug} label={c.name} imageUrl={c.imageUrl} selected={selected === c.slug} onClick={() => onSelect(selected === c.slug ? null : c.slug)} index={i + 1} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function countText(f: DiscoveryFilterState, cuisines: Cuisine[] | undefined, first: DiscoveryPage | undefined, loaded: { open: number; total: number }, more: boolean): string {
  const prefix = f.cuisine?.length ? `${f.cuisine.map((c) => cuisineName(c, cuisines)).join(', ')} · ` : '';
  const total = first?.counts?.total ?? loaded.total;
  const open = first?.counts?.open ?? loaded.open;
  const plus = !first?.counts && more ? '+' : '';
  return `${prefix}${open}${plus} open now · ${total}${plus} ${total === 1 ? 'restaurant delivers here' : 'restaurants deliver here'}`;
}

function Main({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-[22px]">{children}</div>;
}

export default function HomePage() {
  const loc = useChosenLocation();
  const [filters, setFilters, clearFilters] = useDiscoveryFilters();
  const [changing, setChanging] = useState(false);
  const cuisines = useCuisines();

  const list = useInfiniteQuery({
    queryKey: ['discovery', loc?.lat, loc?.lng, filters],
    queryFn: ({ pageParam }) => discoveryQuery(loc!, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: loc !== null,
  });

  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const facets = first?.facets ? new Map(first.facets.cuisines.map((c) => [c.slug, c.count])) : undefined;
  const selectedCuisine = filters.cuisine?.[0] ?? null;
  const anyEstimate = items.length > 0;
  const demoEstimate = items.some((r) => isDemoEstimate(r.etaSource));
  const cuisineLabel = selectedCuisine ? cuisineName(selectedCuisine, cuisines.data) : null;

  let body: ReactNode;
  if (!loc) {
    body = (
      <EmptyState
        icon="location"
        title="Set your delivery location"
        description="We only show restaurants that can actually deliver to you."
        action={<Button onClick={() => setChanging(true)}>Choose location</Button>}
      />
    );
  } else if (list.isPending) {
    body = (
      <div role="status" aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
        <span className="sr-only">Finding restaurants that deliver to you…</span>
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  } else if (list.isError && !list.data) {
    body = <ErrorState error={list.error} title="Couldn't load restaurants" onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  } else if (first && !first.serviceable) {
    body = (
      <EmptyState
        icon="location"
        title="We don't deliver here yet"
        description={`No delivery area covers ${loc.label}. Try another address — restaurants must be inside an active service area and their delivery radius.`}
        action={<Button onClick={() => setChanging(true)}>Try another location</Button>}
      />
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-2 bg-card px-6 py-10 text-center">
        <CuisineArt slug={selectedCuisine ?? 'all'} className="size-[72px]" />
        <h2 className="font-sans text-[17px] font-semibold tracking-normal">
          {cuisineLabel ? `No ${cuisineLabel} restaurants deliver to ${loc.label} right now.` : hasActiveFilters(filters) ? `No restaurants match these filters at ${loc.label}.` : `No restaurants deliver to ${loc.label} right now.`}
        </h2>
        <p className="text-sm text-fg-3">
          {hasActiveFilters(filters) ? 'Try another cuisine, or clear filters to see everything that delivers here.' : 'Restaurants may be outside their delivery radius. Check back soon.'}
        </p>
        {hasActiveFilters(filters) ? (
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <>
        <ul aria-label="Restaurants" aria-busy={list.isFetching} className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
          {items.map((r, i) => (
            <DiscoveryCard key={r.id} r={r} cuisines={cuisines.data} index={i % 12} />
          ))}
        </ul>
        <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} label="Show more restaurants" />
      </>
    );
  }

  const loaded = { open: items.filter((r) => r.open).length, total: items.length };

  return (
    <>
      <CuisineBand cuisines={cuisines.data ?? []} facets={facets} selected={selectedCuisine} onSelect={(slug) => setFilters({ cuisine: slug ? [slug] : [] })} />
      <div className="mx-auto w-full max-w-[1360px] px-6 pb-10 pt-7 max-sm:px-4 max-sm:pt-5">
        <FiltersRow value={filters} onChange={setFilters} className="mb-5 lg:hidden" />
        <div className="flex flex-wrap items-start gap-7">
          <FiltersAside value={filters} onChange={setFilters} className="max-w-[240px] flex-[1_1_200px] max-lg:hidden" />
          <Main>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <h1 className="text-[30px] leading-[1.1] max-sm:text-[28px]">
                  Delivering to <Accent>{loc?.label ?? 'you'}</Accent>
                </h1>
                <p className="text-sm text-fg-3" aria-live="polite">
                  {loc && first?.serviceable && !list.isPending ? countText(filters, cuisines.data, first, loaded, !!list.hasNextPage) : ' '}
                </p>
              </div>
              {anyEstimate ? <EstLegend demo={demoEstimate} /> : null}
            </div>
            {loc && first?.serviceable ? <Banners /> : null}
            {body}
          </Main>
        </div>
      </div>
      <CartDock />
      <LocationDialog open={changing} onClose={() => setChanging(false)} />
    </>
  );
}
