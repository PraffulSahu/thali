/**
 * Restaurant menu (board 11, design-spec §5.11): `GET /restaurants/:idOrSlug?lat&lng`.
 *   hero band: logo tile · name · "Biryani · Mughlai · Indiranagar · Open till 11:30 PM" (closesAt / nextOpenAt /
 *   paused) · Pure veg · description · stat cards Rating · Delivery (EST.) · Distance · Fee
 *   not-deliverable notice (11-10) disables every Add · sticky category nav with counts + scroll-spy
 *   (Recommended = MKT-9 `recommended[]`) · dish rows: "from ₹249", Add + / In cart · N / Sold out today /
 *   Unavailable (MKT-6) · customizer · floating cart dock + "Added …" toast.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  EstBadge,
  FilterPill,
  hueFor,
  InfoNotice,
  Lbl,
  PureVegBadge,
  QtyStepper,
  RatingBadge,
  Skeleton,
  SkeletonList,
  VegMark,
} from '../../components/ui';
import { RestaurantLogoArt } from '../../components/illustrations';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessage, isNotFound } from '../../lib/errors';
import { formatINR } from '../../lib/format';
import { cuisineName, useCart, type CartLine, type MenuItem, type RestaurantPageData } from './api';
import { CartDock } from './CartDock';
import { MAX_LINE_QTY, useAddToCart, useLineQuantity } from './cartState';
import { useShellBreadcrumb } from './ConsumerLayout';
import { fromPricePaise, ItemCustomizer, type CustomizerResult } from './ItemCustomizer';
import { LocationDialog } from './LocationPicker';
import { useChosenLocation } from './location';
import { DemoBadge, istTime } from './parts';
import { opensLabel, useCuisines } from './RestaurantCard';

type R = RestaurantPageData['restaurant'];
const rupees = (p: number) => formatINR(p).replace(/\.00$/, '');

/** "Open till 11:30 PM" / "Opens at 6:00 PM" / "Temporarily not accepting orders". */
export function openStateText(r: R): string {
  if (r.open) return r.closesAt ? `Open till ${istTime(r.closesAt)}` : 'Open now';
  if (r.closedReason === 'PAUSED') return 'Temporarily not accepting orders';
  if (r.nextOpenAt) return opensLabel(r.nextOpenAt);
  return 'Closed now';
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-card px-3.5 py-2.5">
      <Lbl>{label}</Lbl>
      <span className="flex items-center gap-1.5 text-[15px] font-semibold">{children}</span>
    </div>
  );
}

function DishRow({
  item, inCart, lines, blocked, onAdd, adding, anchor,
}: { item: MenuItem; inCart: number; lines: CartLine[]; blocked: string | null; onAdd: (i: MenuItem) => void; adding: boolean; anchor: boolean }) {
  const { setQuantity, pendingLineId } = useLineQuantity();
  const unavailable = !item.available;
  const customizable = item.customizationGroups.length > 0;
  const from = fromPricePaise(item);
  const soldOut = unavailable && item.unavailableReason === 'SOLD_OUT';
  const single = !customizable && lines.length === 1 ? lines[0]! : null;
  const hue = hueFor(item.id);
  let control;
  if (unavailable) {
    control = (
      <Button variant="outline" size="sm" disabled className="cursor-not-allowed shadow-[0_2px_6px_rgba(0,0,0,.08)]">
        Unavailable
      </Button>
    );
  } else if (inCart > 0 && single) {
    control = (
      <QtyStepper
        tone="primary"
        className="h-9 shadow-[0_2px_6px_rgba(0,0,0,.08)]"
        value={single.quantity}
        max={MAX_LINE_QTY}
        itemName={item.name}
        disabled={pendingLineId === single.lineId || blocked !== null}
        onChange={(q) => setQuantity(single, q)}
      />
    );
  } else if (inCart > 0) {
    control = (
      <Button size="sm" className="shadow-[0_2px_6px_rgba(0,0,0,.08)]" onClick={() => onAdd(item)} disabled={blocked !== null} aria-label={`${item.name}: ${inCart} in cart. Customise and add another`}>
        In cart · {inCart}
      </Button>
    );
  } else {
    control = (
      <Button
        variant="outline"
        size="sm"
        className="shadow-[0_2px_6px_rgba(0,0,0,.08)]"
        loading={adding}
        disabled={blocked !== null || adding}
        title={blocked ?? undefined}
        onClick={() => onAdd(item)}
        aria-label={`Add ${item.name}`}
      >
        Add +
      </Button>
    );
  }
  return (
    <li id={anchor ? `item-${item.id}` : undefined} className={cn('flex scroll-mt-28 gap-4 border-b border-line py-[18px]', unavailable && 'opacity-55')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <VegMark veg={item.isVeg} />
        <h3 className="font-sans text-base font-semibold tracking-normal">{item.name}</h3>
        <span className="text-sm tabular-nums">{from !== null ? `from ${rupees(from)}` : rupees(item.pricePaise)}</span>
        {unavailable ? (
          <span className="text-[13px] font-medium">{soldOut ? 'Sold out today' : 'Unavailable right now'}</span>
        ) : item.description ? (
          <p className="max-w-[520px] text-[13.5px] leading-normal text-fg-3">{item.description}</p>
        ) : null}
        {!unavailable && item.stockLeft != null ? <span className="text-[12.5px] font-medium text-warn">Only {item.stockLeft} left today</span> : null}
        {customizable && !unavailable ? <span className="text-xs text-fg-3">Customisable</span> : null}
      </div>
      <div className="flex shrink-0 flex-col items-center">
        <div
          aria-hidden="true"
          className="h-[104px] w-32 overflow-hidden rounded-[14px] border border-line max-sm:h-20 max-sm:w-24"
          style={{ background: unavailable ? 'var(--muted)' : `color-mix(in srgb, ${hue} 14%, var(--card))` }}
        >
          {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" className={cn('size-full object-cover', unavailable && 'grayscale')} /> : null}
        </div>
        <div className="-mt-[18px]">{control}</div>
      </div>
    </li>
  );
}

function RestaurantView({ data }: { data: RestaurantPageData }) {
  const { restaurant: r, delivery, menu } = data;
  const cart = useCart();
  const cuisines = useCuisines();
  const add = useAddToCart();
  const [vegOnly, setVegOnly] = useState(false);
  const [customizing, setCustomizing] = useState<MenuItem | null>(null);
  const [changing, setChanging] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const loc = useChosenLocation();
  useShellBreadcrumb(r.name, [r.name]);

  useEffect(() => {
    document.title = `${r.name} · Thali`;
    const hash = window.location.hash;
    if (hash.startsWith('#item-')) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [r.name]);

  const sections = useMemo(() => {
    const keep = (items: MenuItem[]) => (vegOnly ? items.filter((i) => i.isVeg) : items);
    const cats = [...menu].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => ({ id: c.id, name: c.name, items: keep(c.items) }));
    const rec = keep(data.recommended ?? []);
    return [...(rec.length ? [{ id: 'recommended', name: 'Recommended', items: rec }] : []), ...cats].filter((c) => c.items.length > 0);
  }, [menu, data.recommended, vegOnly]);

  // Scroll-spy: the section nearest the top sets aria-current on the category nav.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.replace(/^cat-/, ''));
      },
      { rootMargin: '-80px 0px -60% 0px' },
    );
    for (const s of sections) {
      const el = document.getElementById(`cat-${s.id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections]);

  const myLines = (cart.data?.groups.find((g) => g.restaurantId === r.id)?.lines ?? []) as CartLine[];
  const linesFor = (itemId: string) => myLines.filter((l) => l.itemId === itemId);

  const notDeliverable = delivery && !delivery.deliverable;
  const blocked = !r.open ? openStateText(r) : notDeliverable ? (delivery.reason ?? "Doesn't deliver to your location") : null;
  const locality = r.locality ?? r.address?.locality ?? null;
  const meta = [...r.cuisines.slice(0, 3).map((c) => cuisineName(c, cuisines.data)), locality, openStateText(r)].filter(Boolean).join(' · ');

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
  const hue = hueFor(r.id);

  return (
    <>
      <section className="border-b border-line bg-side backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-end justify-between gap-7 px-6 py-9 max-sm:px-4 max-sm:py-6">
          <div className="flex min-w-0 items-center gap-5 max-sm:gap-3.5">
            <div
              aria-hidden="true"
              className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-card-lg border border-line max-sm:size-[72px]"
              style={{ background: `color-mix(in srgb, ${hue} 18%, var(--card))`, color: hue }}
            >
              {r.logoUrl ? <img src={r.logoUrl} alt="" className="size-full object-cover" /> : <RestaurantLogoArt className="size-14" />}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-[40px] leading-none max-sm:text-[28px]">{r.name}</h1>
                {r.isVeg === 'PURE_VEG' || r.pureVeg ? <PureVegBadge /> : null}
                <DemoBadge show={r.isDemo} label="Demo restaurant" />
              </div>
              <span className={cn('text-[15px]', r.open ? 'text-fg-3' : 'font-medium text-acc-fg')}>{meta}</span>
              {r.description ? <p className="max-w-[560px] text-sm text-fg-2">{r.description}</p> : null}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2.5 max-md:grid-cols-2 max-md:w-full">
            <Stat label="Rating">
              {r.rating && r.rating.count >= 5 ? (
                <>
                  <span aria-hidden="true">★</span> {r.rating.average.toFixed(1)} <span className="font-normal text-fg-3">({r.rating.count})</span>
                </>
              ) : (
                <RatingBadge count={r.rating?.count ?? 0} />
              )}
            </Stat>
            <Stat label="Delivery">
              {delivery?.deliverable && delivery.etaMinutes != null ? (
                <>
                  {delivery.etaMinutes} min <EstBadge />
                </>
              ) : (
                <span className="text-fg-3">—</span>
              )}
            </Stat>
            <Stat label="Distance">{delivery?.distanceKm != null ? `${delivery.distanceKm.toFixed(1)} km` : <span className="text-fg-3">—</span>}</Stat>
            <Stat label="Fee">
              {delivery?.deliverable && delivery.deliveryFeePaise != null ? (delivery.deliveryFeePaise === 0 ? 'Free' : rupees(delivery.deliveryFeePaise)) : <span className="text-fg-3">—</span>}
            </Stat>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-[1200px] px-6 pb-16 pt-7 max-sm:px-4">
        {notDeliverable ? (
          <InfoNotice tone="warn" icon="alert" className="mb-5">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                {r.name} doesn&rsquo;t deliver to {loc?.label ?? 'your location'}
                {delivery.reason ? ` (${delivery.reason.toLowerCase().replace(/\.$/, '')})` : ''}. You can still browse.
              </span>
              <Button variant="link" size="sm" onClick={() => setChanging(true)}>
                Change location
              </Button>
            </span>
          </InfoNotice>
        ) : !delivery ? (
          <InfoNotice tone="info" icon="location" className="mb-5">
            <span className="flex flex-wrap items-center gap-x-3">
              Set your delivery location to see delivery time and fee.
              <Button variant="link" size="sm" onClick={() => setChanging(true)}>
                Set location
              </Button>
            </span>
          </InfoNotice>
        ) : null}
        {!r.open ? (
          <InfoNotice tone="warn" icon="clock" className="mb-5" role="status">
            {openStateText(r)}. You can browse the menu, but ordering is paused until then.
          </InfoNotice>
        ) : null}
        {add.error && !customizing ? (
          <InfoNotice tone="bad" icon="alert" role="alert" className="mb-5">
            Couldn&rsquo;t add to cart: {errorMessage(add.error)}
          </InfoNotice>
        ) : null}

        <div className="flex flex-wrap items-start gap-10 max-lg:gap-4">
          <nav aria-label="Menu categories" className="sticky top-5 flex max-w-[220px] flex-[1_1_180px] flex-col gap-0.5 max-lg:top-0 max-lg:z-10 max-lg:-mx-6 max-lg:max-w-none max-lg:flex-[1_1_100%] max-lg:flex-row max-lg:overflow-x-auto max-lg:bg-bg max-lg:px-6 max-lg:py-2 max-sm:-mx-4 max-sm:px-4">
            <Lbl className="px-3 pb-2.5 max-lg:hidden">Menu</Lbl>
            {sections.map((c) => {
              const current = (active ?? sections[0]?.id) === c.id;
              return (
                <a
                  key={c.id}
                  href={`#cat-${c.id}`}
                  aria-current={current ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    setActive(c.id);
                    document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className={cn(
                    'flex min-h-[38px] shrink-0 items-center justify-between gap-3 rounded-item px-3 text-sm text-fg-2 hover:bg-fill',
                    'aria-[current=true]:bg-fill aria-[current=true]:font-medium aria-[current=true]:text-fg',
                    'max-lg:rounded-pill max-lg:border max-lg:border-line max-lg:aria-[current=true]:border-fg max-lg:aria-[current=true]:bg-fg max-lg:aria-[current=true]:text-bg',
                  )}
                >
                  {c.name}
                  <span className="text-fg-3 max-lg:opacity-70">{c.items.length}</span>
                </a>
              );
            })}
          </nav>
          <div className="min-w-0 flex-[999_1_560px]">
            <div className="mb-2 flex justify-end">
              <FilterPill veg pressed={vegOnly} onClick={() => setVegOnly((v) => !v)}>
                Veg only
              </FilterPill>
            </div>
            {sections.length === 0 ? (
              <EmptyState
                icon="list"
                title={vegOnly ? 'No veg dishes here' : 'Menu coming soon'}
                description={vegOnly ? 'Turn off “Veg only” to see everything.' : 'This restaurant has not published dishes yet.'}
              />
            ) : (
              sections.map((c) => (
                <section key={c.id} id={`cat-${c.id}`} aria-labelledby={`cat-h-${c.id}`} className="mb-6 scroll-mt-24">
                  <h2 id={`cat-h-${c.id}`} className="mb-1.5 text-[22px]">
                    {c.name}
                  </h2>
                  <ul>
                    {c.items.map((i) => {
                      const lines = linesFor(i.id);
                      return (
                        <DishRow
                          key={`${c.id}-${i.id}`}
                          item={i}
                          lines={lines}
                          inCart={lines.reduce((n, l) => n + l.quantity, 0)}
                          blocked={blocked}
                          onAdd={onAdd}
                          adding={add.isPending && add.variables?.itemId === i.id && !customizing}
                          anchor={c.id !== 'recommended'}
                        />
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>
      </div>

      <CartDock />
      {customizing ? (
        <ItemCustomizer
          key={customizing.id}
          item={customizing}
          restaurantName={r.name}
          open
          onClose={() => setCustomizing(null)}
          onAdd={(res) => onCustomized(customizing, res)}
          busy={add.isPending}
          error={add.error}
        />
      ) : null}
      <LocationDialog open={changing} onClose={() => setChanging(false)} />
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
  if (q.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading restaurant…</span>
        <div className="border-b border-line bg-side">
          <div className="mx-auto flex max-w-[1200px] items-center gap-5 px-6 py-9">
            <Skeleton className="size-24 rounded-card-lg" />
            <div className="flex flex-1 flex-col gap-3">
              <Skeleton className="h-10 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </div>
        </div>
        <div className="mx-auto max-w-[1200px] px-6 pt-7">
          <SkeletonList count={4} />
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="mx-auto max-w-[1200px] px-6 pt-10">
        {isNotFound(q.error) ? (
          <EmptyState icon="store" title="Restaurant not found" description="It may no longer be listed on Thali." action={<ButtonLink to="/">Browse restaurants</ButtonLink>} />
        ) : (
          <ErrorState error={q.error} title="Couldn't load this restaurant" onRetry={() => void q.refetch()} retrying={q.isFetching} />
        )}
      </div>
    );
  }
  return <RestaurantView data={q.data} />;
}

