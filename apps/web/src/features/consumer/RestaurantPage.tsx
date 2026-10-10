/**
 * Restaurant page (PRD C-4): `GET /restaurants/:idOrSlug?lat&lng` — header with open state, delivery estimate
 * for the chosen location, category navigation, veg markers, unavailable items greyed out, and the
 * customizer for items with customization groups. Adding goes to the (guest or user) cart.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  FoodMarker,
  Icon,
  PageHeader,
  Price,
  QueryState,
  Skeleton,
  SkeletonList,
  Switch,
  useToast,
} from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, isNotFound } from '../../lib/errors';
import { formatDateTime, formatDistanceKm, formatTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import { cartApi, useCartWriter, type AddItemInput, type MenuItem, type RestaurantPageData } from './api';
import { ItemCustomizer, type CustomizerResult } from './ItemCustomizer';
import { useChosenLocation } from './location';
import { DemoBadge, EtaText } from './parts';
import { priceBandLabel, RatingBadge } from './RestaurantCard';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function closedText(r: RestaurantPageData['restaurant']): string {
  if (r.closedReason === 'PAUSED') return r.nextOpenAt ? `Not taking orders until ${formatTime(r.nextOpenAt)}` : 'Not taking orders right now';
  if (r.nextOpenAt) return `Closed now · opens ${formatDateTime(r.nextOpenAt)}`;
  return 'Closed now';
}

function useAddToCart() {
  const write = useCartWriter();
  const { toast } = useToast();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (input: AddItemInput) => cartApi.add(input),
    onSuccess: (res, input) => {
      write(res.cart);
      const line = res.cart.groups.flatMap((g) => g.lines).find((l) => l.lineId === res.lineId);
      toast({
        title: `Added ${line?.name ?? 'item'} to your cart`,
        description: input.quantity > 1 ? `${input.quantity} items` : undefined,
        tone: 'success',
        action: { label: 'View cart', onClick: () => navigate('/cart') },
      });
    },
  });
}

function MenuItemRow({ item, disabledReason, onAdd, adding }: { item: MenuItem; disabledReason: string | null; onAdd: (item: MenuItem) => void; adding: boolean }) {
  const unavailable = !item.available;
  const customizable = item.customizationGroups.length > 0;
  return (
    <li id={`item-${item.id}`} className={cn('flex gap-3 py-4', unavailable && 'opacity-60')} aria-disabled={unavailable || undefined}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <FoodMarker veg={item.isVeg} />
          <h3 className="font-semibold text-slate-900">{item.name}</h3>
        </div>
        <Price paise={item.pricePaise} />
        {item.description ? <p className="line-clamp-2 text-sm text-slate-600">{item.description}</p> : null}
        <div className="flex flex-wrap gap-1">
          {customizable ? <Badge tone="neutral">Customisable</Badge> : null}
          {item.tags.slice(0, 3).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex w-28 shrink-0 flex-col items-center gap-2">
        {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" className={cn('aspect-square w-28 rounded-control object-cover', unavailable && 'grayscale')} /> : null}
        {unavailable ? (
          <span className="text-sm font-medium text-slate-600">Unavailable</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            fullWidth
            disabled={disabledReason !== null || adding}
            title={disabledReason ?? undefined}
            onClick={() => onAdd(item)}
            aria-label={`Add ${item.name}`}
          >
            Add
          </Button>
        )}
      </div>
    </li>
  );
}

function RestaurantView({ data }: { data: RestaurantPageData }) {
  const { restaurant: r, delivery, menu } = data;
  const [vegOnly, setVegOnly] = useState(false);
  const [customizing, setCustomizing] = useState<MenuItem | null>(null);
  const add = useAddToCart();

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#item-')) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, []);

  const categories = useMemo(
    () =>
      [...menu]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({ ...c, items: vegOnly ? c.items.filter((i) => i.isVeg) : c.items }))
        .filter((c) => c.items.length > 0),
    [menu, vegOnly],
  );

  const disabledReason = !r.open ? closedText(r) : delivery && !delivery.deliverable ? (delivery.reason ?? "Doesn't deliver to your location") : null;

  const onAdd = (item: MenuItem) => {
    add.reset();
    if (item.customizationGroups.length) setCustomizing(item);
    else add.mutate({ restaurantId: r.id, itemId: item.id, quantity: 1, selections: [] });
  };
  const onCustomized = (item: MenuItem, res: CustomizerResult) =>
    add.mutate(
      { restaurantId: r.id, itemId: item.id, quantity: res.quantity, selections: res.selections, ...(res.note ? { note: res.note } : {}) },
      { onSuccess: () => setCustomizing(null) },
    );

  return (
    <>
      <PageHeader
        title={r.name}
        back={{ to: '/', label: 'Restaurants' }}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <RatingBadge rating={r.rating} />
            {r.open ? <Badge tone="success">Open</Badge> : <Badge tone="neutral">{closedText(r)}</Badge>}
            {r.isVeg === 'PURE_VEG' ? <Badge tone="success">Pure veg</Badge> : null}
            <DemoBadge show={r.isDemo} label="Demo restaurant" />
          </span>
        }
        description={[r.cuisines.join(', '), priceBandLabel(r.priceBand)].filter(Boolean).join(' · ')}
      />
      {r.imageUrl ? <img src={r.imageUrl} alt="" className="mb-4 aspect-[3/1] w-full rounded-card object-cover" /> : null}

      <Card className="mb-4" padding="sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-700">
          {delivery ? (
            delivery.deliverable ? (
              <>
                <EtaText minutes={delivery.etaMinutes} distanceKm={delivery.distanceKm} source={delivery.etaSource} />
                {delivery.deliveryFeePaise !== undefined ? (
                  <span>
                    Delivery <Price paise={delivery.deliveryFeePaise} size="sm" freeLabel="free" />
                  </span>
                ) : null}
                {delivery.minOrderPaise ? (
                  <span>
                    Min order <Price paise={delivery.minOrderPaise} size="sm" />
                  </span>
                ) : null}
              </>
            ) : (
              <span className="flex items-center gap-1.5 font-medium text-warn-800">
                <Icon name="alert" size={16} /> {delivery.reason ?? "Doesn't deliver to your location"}
                {delivery.distanceKm != null ? ` (${formatDistanceKm(delivery.distanceKm)} away)` : ''}
              </span>
            )
          ) : (
            <span>Set your location to see delivery time and fee.</span>
          )}
          {r.packagingFeePaise > 0 ? (
            <span>
              Packaging <Price paise={r.packagingFeePaise} size="sm" />
            </span>
          ) : null}
          <span>~{r.avgPrepMinutes} min prep</span>
        </div>
        {r.address ? <p className="mt-1 text-xs text-slate-600">{[r.address.line1, r.address.city].join(', ')}</p> : null}
        {r.hours.length ? (
          <details className="mt-1 text-xs text-slate-600">
            <summary className="cursor-pointer py-1">Opening hours (IST)</summary>
            <ul>
              {r.hours.map((h, i) => (
                <li key={`${h.day}-${i}`}>
                  {DAYS[h.day]} {h.open}–{h.close}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      {r.description ? <p className="mb-4 text-sm text-slate-700">{r.description}</p> : null}

      <div className="sticky top-16 z-10 -mx-4 mb-2 border-b border-slate-200 bg-canvas/95 px-4 py-2 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <nav aria-label="Menu categories" className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
            {categories.map((c) => (
              <a key={c.id} href={`#cat-${c.id}`} className="min-h-touch shrink-0 content-center rounded-pill border border-slate-300 bg-surface px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
                {c.name} <span className="text-slate-500">({c.items.length})</span>
              </a>
            ))}
          </nav>
          <Switch label="Veg only" checked={vegOnly} onChange={(e) => setVegOnly(e.target.checked)} />
        </div>
      </div>
      {disabledReason ? (
        <p role="status" className="mb-2 rounded-control bg-warn-50 px-3 py-2 text-sm text-warn-800">
          {disabledReason}. You can browse the menu, but ordering is unavailable right now.
        </p>
      ) : null}
      {add.error && !customizing ? (
        <p role="alert" className="mb-2 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-800">
          Couldn&rsquo;t add to cart: {errorMessage(add.error)}
        </p>
      ) : null}

      {categories.length === 0 ? (
        <EmptyState icon="list" title={vegOnly ? 'No veg items' : 'Menu coming soon'} description={vegOnly ? 'Turn off "Veg only" to see everything.' : 'This restaurant has not published items yet.'} />
      ) : (
        categories.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} aria-labelledby={`cat-h-${c.id}`} className="scroll-mt-32">
            <h2 id={`cat-h-${c.id}`} className="mt-4 text-lg font-semibold text-slate-900">
              {c.name}
            </h2>
            <ul className="divide-y divide-slate-100">
              {c.items.map((i) => (
                <MenuItemRow key={i.id} item={i} disabledReason={disabledReason} onAdd={onAdd} adding={add.isPending && !customizing} />
              ))}
            </ul>
          </section>
        ))
      )}

      {customizing ? (
        <ItemCustomizer
          key={customizing.id}
          item={customizing}
          open
          onClose={() => setCustomizing(null)}
          onAdd={(res) => onCustomized(customizing, res)}
          busy={add.isPending}
          error={add.error}
        />
      ) : null}
    </>
  );
}

export default function RestaurantPage() {
  const { idOrSlug = '' } = useParams();
  const loc = useChosenLocation();
  const q = useQuery({
    queryKey: ['restaurant', idOrSlug, loc?.lat, loc?.lng],
    queryFn: () => api<RestaurantPageData>(`/restaurants/${encodeURIComponent(idOrSlug)}`, { auth: false, query: loc ? { lat: loc.lat, lng: loc.lng } : undefined }),
  });
  if (q.isError && isNotFound(q.error)) {
    return (
      <EmptyState
        icon="store"
        title="Restaurant not found"
        description="It may no longer be listed on Thali."
        action={<ButtonLink to="/">Browse restaurants</ButtonLink>}
      />
    );
  }
  return (
    <QueryState
      query={q}
      loading={
        <div className="space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="aspect-[3/1] w-full" />
          <SkeletonList count={4} />
        </div>
      }
      errorTitle="Couldn't load this restaurant"
    >
      {(data) => <RestaurantView data={data} />}
    </QueryState>
  );
}
