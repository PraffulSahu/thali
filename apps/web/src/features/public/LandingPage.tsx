/**
 * Public landing — board 00 (design-spec §5.00). Rendered inside <PublicShell> at `/welcome`, and at `/` while
 * no delivery location is chosen.
 *
 * Address flow (MKT-1): type → debounced `GET /discovery/places?q=` → pick → `GET /discovery/places/:id` →
 * serviceable ? store location (lib/location) and go to Discover (`/`, or the pending cuisine) :
 * "We don't deliver here yet". "Use my location" → browser geolocation → `GET /discovery/reverse` → same.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ADDRESS_INPUT_ID } from '../../components/layout/PublicShell';
import { AddressAutocomplete } from '../../components/location/AddressAutocomplete';
import {
  CUISINES,
  HeroBiryani,
  HeroDosa,
  HeroGulabJamun,
  HeroNoodles,
  HeroSunBlobs,
  PromoRestaurantsMark,
  PromoRidersBike,
  hasCuisineArt,
} from '../../components/illustrations';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { CuisineCircle } from '../../components/ui/CuisineCircle';
import { EstBadge } from '../../components/ui/EstBadge';
import { Icon, type IconName } from '../../components/ui/Icon';
import { useDocumentTitle } from '../../components/ui/PageHeader';
import { RatingBadge } from '../../components/ui/RestaurantCard';
import { VegMark } from '../../components/ui/VegMark';
import { roleEntryHref } from '../../components/layout/PublicShell';
import { GEO_MESSAGES, useGeolocation } from '../../hooks/useGeolocation';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { setChosenLocation, useChosenLocation } from '../../lib/location';
import { getPlace, reverseGeocode, shortLabel, type PlaceSuggestion } from '../../lib/places';

type Notice = { tone: 'warn' | 'bad' | 'info'; text: ReactNode } | null;

const NOT_SERVICEABLE = "We don't deliver here yet. Thali is a Bengaluru pilot — try another address in the city.";

interface CuisineItem {
  slug: string;
  name: string;
  imageUrl?: string | null;
}

const DEFAULT_CUISINES: CuisineItem[] = ['biryani', 'south-indian', 'north-indian', 'chinese', 'coastal', 'pizza', 'healthy', 'desserts', 'chai-snacks'].map(
  (slug) => ({ slug, name: CUISINES[slug]!.label }),
);

function useLandingCuisines(): CuisineItem[] {
  const q = useQuery({
    queryKey: ['cuisines'],
    queryFn: () => api<{ items: CuisineItem[] }>('/cuisines', { auth: false }).then((r) => r.items),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const withArt = (q.data ?? []).filter((c) => hasCuisineArt(c.slug) || c.imageUrl);
  return withArt.length ? withArt : DEFAULT_CUISINES;
}

/* ------------------------------------------------------------------ location flow */

function useLocationFlow() {
  const navigate = useNavigate();
  const geo = useGeolocation();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<'place' | 'gps' | null>(null);
  const pendingNext = useRef<string>('/');

  const go = () => navigate(pendingNext.current || '/');

  const choosePlace = async (s: PlaceSuggestion) => {
    setBusy('place');
    setNotice(null);
    try {
      const place = await getPlace(s.id);
      if (!place.serviceable) {
        setNotice({ tone: 'warn', text: NOT_SERVICEABLE });
        return;
      }
      setChosenLocation({
        lat: place.location.lat,
        lng: place.location.lng,
        label: s.primary,
        address: place.formattedAddress,
        source: 'address',
        placeId: place.id,
      });
      go();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const useMyLocation = async () => {
    setBusy('gps');
    setNotice(null);
    try {
      const fix = await geo.request();
      if (!fix) {
        setNotice({ tone: 'warn', text: GEO_MESSAGES[(geo.status === 'idle' || geo.status === 'locating' || geo.status === 'success' ? 'unavailable' : geo.status) as keyof typeof GEO_MESSAGES] ?? 'We couldn’t get your location. Type your address instead.' });
        return;
      }
      const here = await reverseGeocode({ lat: fix.lat, lng: fix.lng });
      if (!here.serviceable) {
        setNotice({ tone: 'warn', text: NOT_SERVICEABLE });
        return;
      }
      setChosenLocation({ lat: fix.lat, lng: fix.lng, label: shortLabel(here.label), address: here.label, source: 'gps' });
      go();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return { choosePlace, useMyLocation, notice, setNotice, busy, pendingNext, geoMessage: geo.message };
}

/* ------------------------------------------------------------------ sections */

function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1240px] px-6 max-sm:px-4', className)}>{children}</div>;
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('eyebrow', className)}>{children}</p>;
}

function HeroCartCard() {
  const line = (veg: boolean, name: string, price: string) => (
    <div className="flex items-center gap-2.5 text-sm">
      <VegMark veg={veg} size={13} />
      <span className="flex-1 font-medium text-fg">{name}</span>
      <span className="font-semibold tabular-nums text-fg">{price}</span>
    </div>
  );
  return (
    <div aria-hidden="true" className="pointer-events-none relative z-[1] w-[min(380px,100%)] rounded-card-lg border border-line bg-card shadow-float">
      <div className="flex items-start justify-between gap-3 border-b border-line p-[18px]">
        <div>
          <p className="font-display text-lg font-extrabold leading-tight tracking-[-0.025em]">Your cart</p>
          <p className="text-[13px] text-fg-3">2 kitchens · 2 deliveries · 1 payment</p>
        </div>
        <Badge tone="acc" dot>
          Split order
        </Badge>
      </div>
      <div className="flex flex-col gap-2.5 p-3.5">
        <div className="animate-split rounded-field bg-bg-2 p-3.5 [animation-delay:.2s]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[14.5px] font-bold">Spice Route</span>
            <span className="font-mono text-[11px] text-acc-fg">DELIVERY 1</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {line(false, 'Chicken Dum Biryani', '₹279')}
            {line(true, 'Double ka Meetha', '₹99')}
          </div>
        </div>
        <div className="rounded-field bg-bg-2 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[14.5px] font-bold">Green Leaf</span>
            <span className="font-mono text-[11px] text-ok">DELIVERY 2</span>
          </div>
          {line(true, 'Ghee Podi Masala Dosa', '₹180')}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-[18px] py-3.5">
        <div>
          <p className="text-xs text-fg-3">Total, incl. fees &amp; taxes</p>
          <p className="font-display text-2xl font-extrabold tracking-[-0.025em]">₹646.20</p>
        </div>
        <span className="inline-flex h-11 items-center rounded-pill bg-pri px-5 text-[15px] font-bold text-pri-fg shadow-pri">Pay once</span>
      </div>
    </div>
  );
}

function DishDisc({ children, className, size }: { children: ReactNode; className?: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn('absolute grid place-items-center rounded-full bg-white shadow-float', className)}
      style={{ width: size, height: size }}
    >
      {children}
    </span>
  );
}

function HeroArt() {
  return (
    <div aria-hidden="true" className="relative flex min-h-[500px] flex-[1_1_440px] items-center justify-center max-lg:min-h-[360px] max-sm:min-h-[320px]">
      <div className="absolute inset-x-0 inset-y-5 overflow-hidden rounded-art bg-sun max-sm:inset-y-3">
        <HeroSunBlobs className="absolute inset-0 size-full" />
      </div>
      <DishDisc size={120} className="-left-2 top-0 animate-bob max-sm:hidden">
        <HeroBiryani width={100} height={100} />
      </DishDisc>
      <DishDisc size={90} className="-top-4 right-6 animate-bob [animation-delay:1.2s] max-sm:hidden">
        <HeroGulabJamun width={74} height={74} />
      </DishDisc>
      <DishDisc size={132} className="-bottom-2 -right-2 animate-bob2 max-sm:size-24!">
        <HeroDosa width={112} height={112} />
      </DishDisc>
      <HeroCartCard />
    </div>
  );
}

const DOORS: Array<{ icon: IconName; tile: string; title: string; body: string; cta: string; to: (signedIn: boolean) => string }> = [
  { icon: 'bowl', tile: 'bg-pri text-white', title: 'Order food', body: 'Browse kitchens that deliver to your address. Sign in only at checkout.', cta: 'Start browsing', to: () => '/' },
  { icon: 'store', tile: 'bg-sun text-[#141414]', title: 'Run a restaurant', body: 'Get listed, manage menu and stock, accept orders fast, see payouts.', cta: 'Restaurant sign in', to: () => '/signin?role=restaurant' },
  { icon: 'bike', tile: 'bg-leaf text-white dark:text-[#121212]', title: 'Deliver with Thali', body: 'Go online, take offers, carry up to two orders at once, track earnings.', cta: 'Partner sign in', to: () => '/signin?role=partner' },
  { icon: 'shield-check', tile: 'bg-fg text-bg', title: 'Thali operations', body: 'Approvals, deliveries, refunds and system health. Email, password and MFA.', cta: 'Admin sign in', to: () => '/signin?role=admin' },
];

function Door({ door, signedIn, onBrowse }: { door: (typeof DOORS)[number]; signedIn: boolean; onBrowse?: (e: MouseEvent<HTMLElement>) => void }) {
  return (
    <Link
      to={door.to(signedIn)}
      onClick={door.cta === 'Start browsing' ? onBrowse : undefined}
      className="group flex min-h-[290px] flex-col gap-3 rounded-card-lg border border-line bg-card p-6 transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-1 hover:border-line-2 hover:shadow-float"
    >
      <span className={cn('mb-3 grid size-[52px] place-items-center rounded-card', door.tile)}>
        <Icon name={door.icon} size={26} strokeWidth={2.2} />
      </span>
      <h3 className="text-[21px] leading-tight">{door.title}</h3>
      <p className="text-[14.5px] leading-normal text-fg-3">{door.body}</p>
      <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[15px] font-extrabold text-acc-fg">
        {door.cta}
        <Icon name="arrow-right" size={16} className="transition-transform duration-200 group-hover:translate-x-[5px]" />
      </span>
    </Link>
  );
}

function HowCard({ n, title, body, children }: { n: number; title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-card-lg border border-line bg-card p-7">
      <span className="grid size-12 place-items-center rounded-full bg-acc-soft font-display text-xl font-extrabold text-acc-fg">{n}</span>
      <div aria-hidden="true" className="grid h-[110px] place-items-center rounded-field bg-bg-2">
        {children}
      </div>
      <h3 className="text-xl leading-tight">{title}</h3>
      <p className="text-[14.5px] leading-normal text-fg-3">{body}</p>
    </div>
  );
}

function PromiseCard({ children, body }: { children: ReactNode; body: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-card-lg border border-line bg-card p-5">
      <div className="flex min-h-7 items-center gap-2.5">{children}</div>
      <p className="text-[14.5px] text-fg-2">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function LandingPage() {
  useDocumentTitle('Order from many kitchens, pay once');
  const auth = useAuth();
  const loc = useChosenLocation();
  const { hash } = useLocation();
  const flow = useLocationFlow();
  const inputRef = useRef<HTMLInputElement>(null);
  const cuisines = useLandingCuisines();
  const navigate = useNavigate();
  const [hint, setHint] = useState<string | null>(null);
  const suggestions = useRef<PlaceSuggestion[]>([]);

  useEffect(() => {
    if (hash === '#address') inputRef.current?.focus();
  }, [hash]);

  /** Without a location, links into Discover first ask for an address, then continue to `next`. */
  const needLocation = (next: string, label?: string) => (e: MouseEvent<HTMLElement>) => {
    if (loc) return;
    e.preventDefault();
    flow.pendingNext.current = next;
    setHint(label ? `Set your delivery address to see ${label} near you.` : 'Set your delivery address to see who delivers to you.');
    inputRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    inputRef.current?.focus({ preventScroll: true });
  };

  /** "Find food" / Enter without a highlighted option: take the first suggestion, else continue or ask. */
  const findFood = (query: string, first: PlaceSuggestion | undefined) => {
    if (first && query.length >= 2) void flow.choosePlace(first);
    else if (loc && !query) navigate(flow.pendingNext.current || '/');
    else {
      setHint(query ? 'Pick your address from the suggestions.' : 'Start typing your address — a road, locality or landmark in Bengaluru.');
      inputRef.current?.focus();
    }
  };

  const notice = flow.notice ?? (hint ? { tone: 'info' as const, text: hint } : null);

  return (
    <>
      {/* 1 · Hero */}
      <section aria-labelledby="hero-title">
        <Container className="flex flex-wrap items-center gap-12 pb-[88px] pt-[72px] max-sm:gap-8 max-sm:pb-14 max-sm:pt-10">
          <div className="flex min-w-0 flex-[1_1_480px] animate-rise flex-col gap-6">
            <p className="inline-flex w-fit items-center gap-2 rounded-pill bg-sun-soft px-3.5 py-2 text-sm font-bold text-acc-fg">
              <span aria-hidden="true" className="size-[7px] animate-pulse-live rounded-full bg-acc" />
              Now delivering across Bengaluru
            </p>
            <h1 id="hero-title" className="text-[clamp(48px,6.4vw,84px)] leading-[.95] text-fg">
              Two kitchens.
              <br />
              <span className="text-acc">One checkout.</span>
            </h1>
            <p className="max-w-[34rem] text-[19px] font-medium leading-[1.55] text-fg-2 max-sm:text-[17px]">
              Biryani from one place, dosa from another. Put them in one cart, pay once, and track each delivery on its own.
            </p>

            <form
              id="address"
              aria-labelledby="address-title"
              onSubmit={(e) => e.preventDefault()}
              className="flex flex-col gap-3"
            >
              <h2 id="address-title" className="sr-only">
                Where should we deliver?
              </h2>
              <div className="relative flex max-w-[580px] flex-wrap items-center gap-2 rounded-[30px] border-[1.5px] border-line-2 bg-card p-2 shadow-card sm:rounded-pill">
                <AddressAutocomplete
                  ref={inputRef}
                  id={ADDRESS_INPUT_ID}
                  variant="hero"
                  label="Enter your delivery address"
                  bias={loc}
                  describedBy={notice ? 'address-notice' : undefined}
                  onSelect={(s) => void flow.choosePlace(s)}
                  onSubmitEmpty={findFood}
                  onItemsChange={(items) => {
                    suggestions.current = items;
                  }}
                  onQueryChange={() => {
                    setHint(null);
                    flow.setNotice(null);
                  }}
                />
                <div className="flex gap-2 max-sm:w-full">
                  <Button variant="ghost" size="lg" className="max-sm:flex-1" loading={flow.busy === 'gps'} onClick={() => void flow.useMyLocation()}>
                    Use my location
                  </Button>
                  <Button
                    size="lg"
                    className="max-sm:flex-1"
                    loading={flow.busy === 'place'}
                    onClick={() => findFood(inputRef.current?.value.trim() ?? '', suggestions.current[0])}
                  >
                    Find food
                  </Button>
                </div>
              </div>
              <div id="address-notice" aria-live="polite" className="min-h-0">
                {notice ? (
                  <p
                    className={cn(
                      'flex max-w-[580px] items-start gap-2 rounded-field px-4 py-3 text-sm',
                      notice.tone === 'warn' ? 'bg-warn-bg text-fg-2' : notice.tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-info-bg text-fg-2',
                    )}
                  >
                    <Icon name={notice.tone === 'info' ? 'info' : 'alert'} size={16} className={cn('mt-0.5 shrink-0', notice.tone === 'warn' ? 'text-warn' : notice.tone === 'info' ? 'text-info' : '')} />
                    <span>{notice.text}</span>
                  </p>
                ) : null}
              </div>
              {loc ? (
                <p className="text-sm text-fg-3">
                  Delivering to <strong className="text-fg">{loc.label}</strong>.{' '}
                  <Link to="/" className="font-bold text-acc-fg hover:underline">
                    See restaurants →
                  </Link>
                </p>
              ) : null}
            </form>

            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold text-fg-2">
              {['Only kitchens that deliver to you', 'Refunds per restaurant, to the rupee'].map((t) => (
                <li key={t} className="inline-flex items-center gap-2">
                  <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-full bg-ok-bg text-ok">
                    <Icon name="check" size={13} strokeWidth={2.6} />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroArt />
        </Container>
      </section>

      {/* 2 · Cuisines band */}
      <section aria-labelledby="cuisines-title" className="border-y border-line bg-band backdrop-blur-md">
        <Container className="flex flex-col gap-7 py-12">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="cuisines-title" className="text-[32px] leading-tight max-sm:text-[26px]">
              What are you craving?
            </h2>
            <Link to="/" onClick={needLocation('/')} className="inline-flex items-center gap-1 text-[15px] font-extrabold text-acc-fg hover:underline">
              See all restaurants <Icon name="arrow-right" size={16} />
            </Link>
          </div>
          <ul aria-label="Cuisines" className="no-scrollbar -mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-1 pt-1">
            {cuisines.map((c, i) => {
              const href = `/?cuisine=${encodeURIComponent(c.slug)}`;
              return (
                <li key={c.slug} className="shrink-0 snap-start">
                  <CuisineCircle variant="marketing" slug={c.slug} label={c.name} imageUrl={c.imageUrl} to={href} index={i} onClick={needLocation(href, c.name)} />
                </li>
              );
            })}
          </ul>
        </Container>
      </section>

      {/* 3 · Doors */}
      <section aria-labelledby="doors-title">
        <Container className="flex flex-col gap-4 pb-10 pt-[88px] max-sm:pt-16">
          <Eyebrow>Start here</Eyebrow>
          <h2 id="doors-title" className="text-[clamp(34px,4vw,48px)] leading-[1.02]">
            Pick your door.
          </h2>
          <p className="max-w-[40rem] text-[17px] leading-[1.55] text-fg-3">
            One Thali, four ways in. Everyone signs in the same way; what you see depends on your role.
          </p>
          <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-4">
            {DOORS.map((d) => (
              <Door key={d.title} door={d} signedIn={auth.isAuthenticated} onBrowse={needLocation('/')} />
            ))}
          </div>
        </Container>
      </section>

      {/* 4 · How it works */}
      <section aria-labelledby="how-title">
        <Container className="flex flex-col gap-4 py-[72px] max-sm:py-14">
          <Eyebrow>How it works</Eyebrow>
          <h2 id="how-title" className="text-[clamp(34px,4vw,48px)] leading-[1.02]">
            One cart that splits itself.
          </h2>
          <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4">
            <HowCard n={1} title="Fill one cart from any kitchens" body="No “replace your cart?” pop-ups. Add from every restaurant that delivers to you.">
              <span className="flex items-center gap-3">
                <span className="h-10 w-16 rounded-control bg-pri" />
                <Icon name="plus" size={16} className="text-fg-3" />
                <span className="h-10 w-16 rounded-control bg-leaf" />
              </span>
            </HowCard>
            <HowCard n={2} title="Pay once" body="See each restaurant’s fees and taxes before you pay. The total is just their sum.">
              <span className="inline-flex h-12 items-center rounded-pill bg-pri px-5 text-[15px] font-bold text-pri-fg shadow-pri">Pay ₹646.20</span>
            </HowCard>
            <HowCard n={3} title="Each kitchen delivers on its own" body="If one declines, only that part is refunded. The rest of your order carries on.">
              <span className="flex w-full flex-col gap-3 px-5 text-[13.5px] font-semibold">
                <span className="flex items-center justify-between">
                  Spice Route <Badge tone="ok" dot>Delivered</Badge>
                </span>
                <span className="flex items-center justify-between">
                  Green Leaf <Badge tone="info" dot>Refunded ₹218.10</Badge>
                </span>
              </span>
            </HowCard>
          </div>
        </Container>
      </section>

      {/* 5 · Promise band */}
      <section aria-labelledby="promise-title" className="border-y border-line bg-band backdrop-blur-md">
        <Container className="flex flex-wrap items-center gap-12 py-20 max-sm:py-14">
          <div className="flex flex-[1_1_380px] flex-col gap-4">
            <Eyebrow>Our promise</Eyebrow>
            <h2 id="promise-title" className="text-[clamp(32px,3.6vw,44px)] leading-[1.04]">
              No made-up numbers.
            </h2>
            <p className="max-w-[28rem] text-[16.5px] leading-[1.6] text-fg-3">
              If we’re estimating, we say so. If something is simulated, it’s labelled. If there aren’t enough reviews to mean anything, we don’t show stars.
            </p>
          </div>
          <div className="grid flex-[1_1_560px] grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-3">
            <PromiseCard body="Ratings appear only after 5 reviews.">
              <RatingBadge count={0} />
              <span className="text-[13px] text-fg-3">vs</span>
              <RatingBadge avg={4.3} count={126} solid />
            </PromiseCard>
            <PromiseCard body="Delivery times tell you where they come from.">
              <span className="text-base font-bold">32 min</span>
              <EstBadge variant="marketing">ESTIMATE</EstBadge>
            </PromiseCard>
            <PromiseCard body="Payouts show “Paid” only with a bank reference.">
              <span className="font-mono text-[15px]">UTR 4021 8833 1190</span>
            </PromiseCard>
            <PromiseCard body="Paid, refunded and pending — always shown separately.">
              <span className="flex w-full items-center justify-between text-[15px] font-bold">
                Net after refund <span className="text-ok">₹428.10</span>
              </span>
            </PromiseCard>
          </div>
        </Container>
      </section>

      {/* 6 · Promo pair */}
      <section aria-label="For restaurants and delivery partners">
        <Container className="grid grid-cols-[repeat(auto-fit,minmax(min(460px,100%),1fr))] gap-5 py-20 max-sm:py-14">
          <div id="restaurants" className="on-color relative flex min-h-[320px] flex-col gap-4 overflow-hidden rounded-block bg-[#d23f11] p-10 text-white max-sm:p-7">
            <PromoRestaurantsMark className="pointer-events-none absolute -bottom-[60px] -right-[50px] size-[220px] opacity-[.18]" />
            <p className="eyebrow text-[#ffd7c7]!">For restaurants</p>
            <h2 className="max-w-[24rem] text-[34px] leading-[1.05]">A counter screen built for rush hour.</h2>
            <p className="max-w-[28rem] text-base leading-[1.6] text-[#ffe6dc]">
              New orders chime in with a countdown. Accept with a prep time in one tap, mark ready, hand over with a pickup code. Earnings and payouts in the same place.
            </p>
            <div className="relative mt-auto flex flex-wrap gap-3 pt-4">
              <ButtonLink to={roleEntryHref('restaurant', auth.isAuthenticated)} variant="on-chili" size="lg">
                List your restaurant
              </ButtonLink>
              <ButtonLink to="/signin?role=restaurant" variant="on-chili-outline" size="lg">
                See the console
              </ButtonLink>
            </div>
          </div>
          <div id="riders" className="on-color relative flex min-h-[320px] flex-col gap-4 overflow-hidden rounded-block bg-[#141414] p-10 text-white max-sm:p-7">
            <PromoRidersBike className="pointer-events-none absolute -bottom-10 -right-[30px] h-[200px] w-[240px] opacity-[.16]" />
            <p className="eyebrow text-[#ffc145]!">For delivery partners</p>
            <h2 className="max-w-[24rem] text-[34px] leading-[1.05]">Clear offers. Honest earnings.</h2>
            <p className="max-w-[28rem] text-base leading-[1.6] text-[#c9c9c9]">
              See distance, time and why a second order fits your route before you accept. Codes at pickup and drop keep every handover clean.
            </p>
            <div className="relative mt-auto flex flex-wrap gap-3 pt-4">
              <ButtonLink to={roleEntryHref('partner', auth.isAuthenticated)} variant="on-ink" size="lg">
                Apply to ride
              </ButtonLink>
              <ButtonLink to="/signin?role=partner" variant="on-ink-outline" size="lg">
                See the partner app
              </ButtonLink>
            </div>
          </div>
        </Container>
      </section>

      {/* 7 · CTA */}
      <section aria-labelledby="cta-title">
        <Container className="pb-20 max-sm:pb-14">
          <div className="on-color relative flex flex-wrap items-center justify-between gap-6 rounded-block bg-[#ffb020] px-11 py-[52px] max-sm:px-7 max-sm:py-10">
            <span aria-hidden="true" className="absolute -top-10 right-[22%] grid size-[110px] place-items-center rounded-full bg-white opacity-95 shadow-float max-md:hidden">
              <HeroNoodles width={88} height={88} />
            </span>
            <div className="flex flex-col gap-2">
              <h2 id="cta-title" className="text-[clamp(34px,4vw,50px)] leading-none text-[#141414]">
                Hungry now?
              </h2>
              <p className="text-[17px] font-medium text-[#3d2a00]">See who delivers to you in a few seconds.</p>
            </div>
            <Button variant="dark" size="xl" className="max-sm:w-full" loading={flow.busy === 'gps'} onClick={() => void flow.useMyLocation()}>
              Find food near me <Icon name="arrow-right" size={18} />
            </Button>
          </div>
        </Container>
      </section>
    </>
  );
}
