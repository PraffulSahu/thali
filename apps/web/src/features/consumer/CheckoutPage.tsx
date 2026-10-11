/**
 * Checkout (board 12, design-spec §5.12; PRD C-9). The server is the authority: `POST /cart/preview` re-quotes
 * prices, stock, open status, coupon, membership and serviceability for the chosen address and returns one
 * priced child per restaurant. `?restaurant=<id>` = per-restaurant checkout (ORD-3 `restaurantIds` on preview
 * and checkout; the other carts stay saved).
 *
 * "Pay ₹X" posts `/checkouts` with `expectedTotalPaise` and an Idempotency-Key generated once per attempt (same
 * payload) and reused on retries / double clicks. 422 PRICE_CHANGED → old vs new dialog; problems → list with
 * "Fix cart" links; 409 CHECKOUT_ALREADY_PAID → link to the paid order; 409 CART_CHANGED → re-preview. On success
 * the payment step opens (Razorpay popup or the labelled demo page) and the status page waits for the server.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  AddAddressCard,
  AddressCard,
  BillBreakdown,
  Button,
  Dialog,
  ErrorState,
  Icon,
  InfoNotice,
  Input,
  Price,
  Skeleton,
  SkeletonCard,
  StepNumber,
  Toggle,
  VegMark,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { newIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useAuth } from '../../lib/auth';
import { errorMessage, isApiError } from '../../lib/errors';
import { formatINR, plural } from '../../lib/format';
import {
  addressToInput,
  cartApi,
  checkoutConflict,
  couponsKey,
  createCheckout,
  fetchCoupons,
  fetchMyMemberships,
  formatAddress,
  isDemoEstimate,
  MEMBERSHIP_KEY,
  previewCart,
  priceChangedDetails,
  problemsFromError,
  useAddresses,
  useCart,
  type CartPreview,
  type CreateCheckoutBody,
  type PriceChangedDetails,
  type QuoteProblem,
} from './api';
import { AddressForm } from './AddressesPage';
import { useChosenLocation } from './location';
import { Accent, billRows, EmptyCart } from './parts';
import { usePaymentLauncher } from './PaymentStep';

const CartDrawer = lazy(() => import('./CartDrawer'));
const MAX_ADDRESSES = 10;
const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'];
const rupees = (p: number) => formatINR(p).replace(/\.00$/, '');

function Section({ n, title, action, children }: { n: number; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const id = `checkout-step-${n}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <StepNumber n={n} />
        <h2 id={id} className="text-[17px]">
          {title}
        </h2>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

function PriceChangedDialog({ details, previous, onClose, onConfirm, busy }: { details: PriceChangedDetails | null; previous: CartPreview | undefined; onClose: () => void; onConfirm: (total: number) => void; busy: boolean }) {
  if (!details) return null;
  const before = new Map(previous?.children.map((c) => [c.restaurantId, c.breakdown.totalPaise]) ?? []);
  const changed = details.children.filter((c) => before.get(c.restaurantId) !== c.breakdown.totalPaise);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Prices changed"
      description={`Total changed from ${formatINR(details.expectedTotalPaise)} to ${formatINR(details.pricing.totalPaise)}. Something changed since you last looked (prices, fees or offers).`}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(details.pricing.totalPaise)} loading={busy}>
            Confirm · Pay {formatINR(details.pricing.totalPaise)}
          </Button>
        </div>
      }
    >
      <dl className="flex flex-col gap-2 text-[14.5px]">
        <div className="flex justify-between text-fg-2">
          <dt>You saw</dt>
          <dd>
            <s>{formatINR(details.expectedTotalPaise)}</s>
          </dd>
        </div>
        <div className="flex justify-between font-semibold">
          <dt>New total</dt>
          <dd>{formatINR(details.pricing.totalPaise)}</dd>
        </div>
      </dl>
      {changed.length ? (
        <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3 text-sm">
          {changed.map((c) => (
            <li key={c.restaurantId} className="flex justify-between gap-2">
              <span>{c.restaurantName}</span>
              <Price paise={c.breakdown.totalPaise} was={before.get(c.restaurantId)} size="sm" />
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

function CheckoutContent() {
  const qc = useQueryClient();
  const { isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const onlyRestaurant = params.get('restaurant');
  const cart = useCart();
  const addresses = useAddresses();
  const chosen = useChosenLocation();
  const coupons = useQuery({ queryKey: couponsKey(isAuthenticated), queryFn: () => fetchCoupons(isAuthenticated), retry: false, staleTime: 60_000 });
  const membership = useQuery({ queryKey: MEMBERSHIP_KEY, queryFn: fetchMyMemberships, retry: false });
  const { launch, opening, error: launchError } = usePaymentLauncher();
  const compact = useMediaQuery('(max-width: 1023px)', false);

  const [addressId, setAddressId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [showOffers, setShowOffers] = useState(false);
  const [coupon, setCoupon] = useState<string | null | undefined>(undefined);
  const [useMembership, setUseMembership] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitProblems, setSubmitProblems] = useState<QuoteProblem[]>([]);
  const [conflict, setConflict] = useState<ReturnType<typeof checkoutConflict>>(null);
  const [priceChange, setPriceChange] = useState<PriceChangedDetails | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => {
    if (addressId || !addresses.data?.length) return;
    const list = addresses.data;
    const pick = list.find((a) => a.id === chosen?.addressId) ?? list.find((a) => a.isDefault) ?? list[0]!;
    setAddressId(pick.id);
  }, [addresses.data, addressId, chosen?.addressId]);

  useEffect(() => {
    if (coupon === undefined && cart.data) setCoupon(cart.data.couponCode);
  }, [cart.data, coupon]);

  const groups = cart.data?.groups ?? [];
  const subsetValid = onlyRestaurant ? groups.some((g) => g.restaurantId === onlyRestaurant) : false;
  const restaurantIds = onlyRestaurant && subsetValid && groups.length > 1 ? [onlyRestaurant] : undefined;
  const address = useMemo(() => addresses.data?.find((a) => a.id === addressId) ?? null, [addresses.data, addressId]);
  const hasItems = groups.length > 0;
  const preview = useQuery({
    queryKey: ['checkout-preview', addressId, coupon ?? null, useMembership, cart.data?.cartVersion, restaurantIds?.join(',') ?? '*'],
    queryFn: () => previewCart({ address: addressToInput(address!), couponCode: coupon ?? null, useMembership, ...(restaurantIds ? { restaurantIds } : {}) }),
    enabled: !!address && hasItems && coupon !== undefined,
    placeholderData: (prev) => prev,
  });
  const activeMembership = membership.data?.current?.status === 'ACTIVE' ? membership.data.current : null;

  const applyCoupon = (code: string | null) => {
    const c = code?.trim().toUpperCase() || null;
    setCoupon(c);
    setCouponInput('');
    setShowOffers(false);
    void cartApi.setCoupon(c).catch(() => undefined); // persisted for next visit; the preview decides validity
  };

  const submit = async (expectedTotalPaise: number) => {
    if (inFlight.current || !address) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitProblems([]);
    setConflict(null);
    // I-1: send the coupon only when the preview applied it; otherwise `null` (= no coupon) so Pay charges exactly the
    // previewed total instead of failing on a coupon the preview already reported unusable. The cart keeps its coupon.
    const appliedCoupon = coupon && preview.data?.coupon?.valid && preview.data.coupon.code === coupon ? coupon : null;
    const body: CreateCheckoutBody = {
      address: addressToInput(address),
      couponCode: appliedCoupon,
      useMembership,
      expectedTotalPaise,
      ...(restaurantIds ? { restaurantIds } : {}),
    };
    const payload = JSON.stringify(body);
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { payload, key: newIdempotencyKey() };
    try {
      const res = await createCheckout(body, attempt.current.key);
      attempt.current = null;
      setPriceChange(null);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      if (res.payment) await launch(res.payment, { kind: 'checkout', checkoutId: res.checkout.id, description: `Order ${res.checkout.code}` });
    } catch (e) {
      const changed = priceChangedDetails(e);
      const c = checkoutConflict(e);
      if (changed) setPriceChange(changed);
      else if (c) {
        setConflict(c);
        attempt.current = null;
        void cart.refetch();
        void preview.refetch();
      } else {
        const problems = problemsFromError(e);
        if (problems.length) {
          setSubmitProblems(problems);
          void preview.refetch();
        } else setSubmitError(e);
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  if (cart.isPending) {
    return (
      <div role="status" aria-busy="true" className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <span className="sr-only">Loading checkout…</span>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-2/3" />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard />
      </div>
    );
  }
  if (cart.isError) return <ErrorState error={cart.error} title="Couldn't load your cart" onRetry={() => void cart.refetch()} />;
  if (!hasItems) return <EmptyCart />;

  const p = preview.data;
  const problems = submitProblems.length ? submitProblems : (p?.problems ?? []);
  const total = p?.pricing.totalPaise;
  const payDisabled = !p || !p.canCheckout || submitProblems.length > 0 || preview.isFetching || !address;
  const kitchens = p?.children.length ?? (restaurantIds ? 1 : groups.length);
  const word = NUMBER_WORDS[kitchens] ?? String(kitchens);
  const lineVeg = new Map(groups.flatMap((g) => g.lines.map((l) => [l.lineId, l.isVeg] as const)));
  const subsetName = restaurantIds ? groups.find((g) => g.restaurantId === restaurantIds[0])?.restaurantName : null;
  const couponOk = p?.coupon?.valid ? p.coupon : null;
  const couponBad = p?.coupon && !p.coupon.valid ? p.coupon : null;
  // I-1: say why an unusable coupon isn't applied; Pay then charges the shown total without it (never a sure 422)
  const scopeNames = couponBad?.reason === 'NOT_APPLICABLE' ? (couponBad.restaurantIds ?? []).map((id) => groups.find((g) => g.restaurantId === id)?.restaurantName).filter(Boolean) : [];
  const couponProblem = couponBad
    ? couponBad.reason === 'NOT_APPLICABLE' && restaurantIds
      ? `${scopeNames.length ? `Applies to ${scopeNames.join(', ')}` : 'Applies to other restaurants'} — not used on this checkout. It stays on your cart for that order.`
      : `${couponBad.message ?? `${couponBad.code} can't be used on this order.`} Not applied — you pay the total shown.`
    : null;
  const recalculating = preview.isFetching && !!p;
  const payLabel = submitting || opening ? 'Opening secure payment…' : total !== undefined ? `Pay ${formatINR(total)}` : 'Pay';

  const payButton = (
    <Button fullWidth size="lg" className="h-[50px] text-[15px]" disabled={payDisabled} loading={submitting || opening} onClick={() => total !== undefined && void submit(total)}>
      {payLabel}
    </Button>
  );
  const payErrors = (
    <>
      {problems.length ? (
        <div role="alert" className="flex flex-col gap-2 rounded-field bg-warn-bg p-3.5 text-[13.5px] text-warn">
          <p className="flex items-center gap-2 font-semibold">
            <Icon name="alert" size={16} /> Some items can&rsquo;t be ordered right now
          </p>
          <ul className="flex flex-col gap-1.5">
            {problems.map((pr, i) => (
              <li key={`${pr.code}-${pr.itemId ?? pr.restaurantId ?? i}`} className="flex flex-wrap items-center justify-between gap-2 text-fg-2">
                <span>{pr.message || pr.code}</span>
                {pr.restaurantId ? (
                  <Link to={`/restaurants/${pr.restaurantId}`} className="font-semibold text-acc-fg underline">
                    Fix cart
                  </Link>
                ) : (
                  <button type="button" onClick={() => setCartOpen(true)} className="font-semibold text-acc-fg underline">
                    Fix cart
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {submitError || launchError ? (
        <div role="alert" className="rounded-field bg-bad-bg p-3 text-[13.5px] text-bad">
          Couldn&rsquo;t start payment: {errorMessage(submitError ?? launchError)}
          {isApiError(submitError) && submitError.requestId ? <span className="block text-xs">Reference: {submitError.requestId}</span> : null}
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <div className="flex flex-wrap items-start gap-8 pt-5 max-sm:pt-2">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-7">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[34px] leading-[1.05] max-sm:text-[28px]">
              {word} {kitchens === 1 ? 'kitchen' : 'kitchens'}, <Accent>one payment.</Accent>
            </h1>
            {kitchens > 1 ? <p className="text-[15px] text-fg-3">Each restaurant cooks and delivers on its own. If one can&rsquo;t, only that part is refunded.</p> : null}
          </div>

          {restaurantIds ? (
            <InfoNotice tone="info" icon="info">
              <span className="flex flex-wrap items-center gap-x-3">
                Checking out only {subsetName}. Your other carts stay saved.
                <Link to="/checkout" className="font-semibold underline">
                  Check out everything
                </Link>
              </span>
            </InfoNotice>
          ) : null}
          {onlyRestaurant && !subsetValid ? (
            <InfoNotice tone="warn" icon="info" role="status">
              That restaurant isn&rsquo;t in your cart — showing the whole cart.
            </InfoNotice>
          ) : null}
          {conflict?.reason === 'CHECKOUT_ALREADY_PAID' ? (
            <InfoNotice tone="ok" icon="check" role="alert">
              <span className="flex flex-wrap items-center gap-x-3">
                You already paid for an order with these items, so we didn&rsquo;t charge you again.
                {conflict.checkoutId ? (
                  <Link to={`/orders/${conflict.checkoutId}`} className="font-semibold underline">
                    Track that order
                  </Link>
                ) : null}
              </span>
            </InfoNotice>
          ) : conflict ? (
            <InfoNotice tone="warn" icon="refresh" role="alert">
              Your cart changed while checking out. We&rsquo;ve refreshed the totals — review them and pay again.
            </InfoNotice>
          ) : null}

          <Section n={1} title="Delivery address">
            {addresses.isPending ? (
              <Skeleton className="h-[86px] w-full" />
            ) : addresses.isError ? (
              <ErrorState compact error={addresses.error} title="Couldn't load your addresses" onRetry={() => void addresses.refetch()} />
            ) : (
              <div role="radiogroup" aria-label="Deliver to" className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5">
                {(addresses.data ?? []).map((a) => {
                  const unserviceable = a.id === addressId && problems.some((pr) => pr.code === 'NOT_SERVICEABLE' && !pr.restaurantId);
                  return (
                    <AddressCard
                      key={a.id}
                      name="address"
                      value={a.id}
                      label={a.label || 'Address'}
                      address={[formatAddress(a), a.landmark ? `near ${a.landmark}` : null].filter(Boolean).join(' · ')}
                      isDefault={a.isDefault}
                      checked={a.id === addressId}
                      onSelect={() => setAddressId(a.id)}
                      disabledReason={unserviceable ? 'Outside delivery area' : undefined}
                    />
                  );
                })}
                {(addresses.data?.length ?? 0) >= MAX_ADDRESSES ? (
                  <button type="button" disabled className="flex min-h-[76px] items-center justify-center rounded-field border border-dashed border-line-2 px-4 text-sm text-fg-3">
                    Address limit reached
                  </button>
                ) : (
                  <AddAddressCard onClick={() => setAdding(true)} />
                )}
              </div>
            )}
          </Section>

          <Section n={2} title="Offers & membership">
            <div className="overflow-hidden rounded-card border border-line bg-card">
              {couponOk || couponBad ? (
                <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                  <span className={couponOk ? 'grid size-9 shrink-0 place-items-center rounded-item bg-ok-bg text-ok' : 'grid size-9 shrink-0 place-items-center rounded-item bg-warn-bg text-warn'}>
                    <Icon name="tag" size={18} />
                  </span>
                  <span className="flex min-w-40 flex-1 flex-col gap-0.5" aria-live="polite">
                    <span className="font-mono text-sm font-medium">{(couponOk ?? couponBad)!.code}</span>
                    {couponOk ? (
                      <span className="text-[13px] text-ok">
                        Applied · −{formatINR(couponOk.discountPaise)}
                        {kitchens > 1 && couponOk.discountPaise > 0 ? (couponOk.restaurantIds?.length && couponOk.restaurantIds.length < kitchens ? ', on eligible restaurants only' : `, split across ${kitchens === 2 ? 'both' : 'all'} restaurants`) : ''}
                      </span>
                    ) : (
                      <span className="text-[13px] text-warn">{couponProblem}</span>
                    )}
                  </span>
                  <Button variant="ghost" onClick={() => applyCoupon(null)}>
                    Remove
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 px-4 py-3.5">
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (couponInput.trim()) applyCoupon(couponInput);
                    }}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-item bg-fill text-fg-3">
                      <Icon name="tag" size={18} />
                    </span>
                    <label className="min-w-40 flex-1">
                      <span className="sr-only">Coupon code</span>
                      <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value)} maxLength={40} autoCapitalize="characters" placeholder="Coupon code" className="font-mono uppercase" />
                    </label>
                    <Button type="submit" variant="outline" disabled={!couponInput.trim() || (coupon != null && preview.isFetching)}>
                      Apply
                    </Button>
                    <Button type="button" variant="link" size="sm" aria-expanded={showOffers} onClick={() => setShowOffers((s) => !s)}>
                      View offers
                    </Button>
                  </form>
                  {showOffers ? (
                    coupons.isPending ? (
                      <Skeleton className="h-12 w-full" />
                    ) : coupons.data?.length ? (
                      <ul aria-label="Available offers" className="flex flex-col divide-y divide-line rounded-field border border-line">
                        {coupons.data.map((c) => (
                          <li key={c.code} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="font-mono text-[13.5px] font-medium">{c.code}</span>
                              <span className="text-[12.5px] text-fg-3">
                                {c.offerHeadline ?? c.description}
                                {c.minOrderPaise ? ` · min order ${rupees(c.minOrderPaise)}` : ''}
                                {c.firstOrderOnly ? ' · first order only' : ''}
                              </span>
                            </span>
                            <Button size="xs" variant="outline" onClick={() => applyCoupon(c.code)}>
                              Apply
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[13px] text-fg-3">No offers you can use right now.</p>
                    )
                  ) : null}
                </div>
              )}
              <div className="flex items-center gap-3 border-t border-line px-4 py-3.5">
                {activeMembership ? (
                  <>
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span id="plus-label" className="text-[14.5px] font-medium">
                        Use Thali Plus benefits
                      </span>
                      <span className="text-[13px] text-fg-3">
                        {activeMembership.plan.benefits.freeDeliveriesPerPeriod > 0
                          ? `${activeMembership.freeDeliveriesRemaining} of ${activeMembership.plan.benefits.freeDeliveriesPerPeriod} free deliveries left this plan period`
                          : activeMembership.plan.name}
                      </span>
                    </span>
                    <Toggle checked={useMembership} onChange={setUseMembership} labelledBy="plus-label" pending={recalculating && useMembership !== (p?.membership?.applied ?? false)} />
                  </>
                ) : (
                  <Link to="/membership" className="flex flex-1 items-center justify-between gap-2 text-[14.5px] font-medium hover:text-acc-fg">
                    Get Thali Plus for free deliveries
                    <Icon name="arrow-right" size={16} />
                  </Link>
                )}
              </div>
              {recalculating ? (
                <div aria-live="polite" className="animate-open border-t border-line bg-warn-bg px-4 py-2.5 text-[13px] text-warn">
                  Recalculating totals with the server…
                </div>
              ) : useMembership && p?.membership && !p.membership.applied ? (
                <div className="border-t border-line px-4 py-2.5 text-[13px] text-fg-3">No Thali Plus benefit applies to this order.</div>
              ) : null}
            </div>
          </Section>

          <Section
            n={3}
            title="Review items"
            action={
              <button type="button" onClick={() => setCartOpen(true)} className="text-[13px] text-fg-3 underline underline-offset-2 hover:text-fg">
                Edit cart
              </button>
            }
          >
            {p?.deliveryExplanation && kitchens > 1 ? <p className="text-[13px] text-fg-3">{p.deliveryExplanation}</p> : null}
            {!address ? (
              <p className="text-sm text-fg-3">Choose or add a delivery address to see your order priced.</p>
            ) : preview.isPending ? (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-2.5">
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : preview.isError && !p ? (
              <ErrorState compact error={preview.error} title="Couldn't price your order" onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-2.5">
                {p!.children.map((c, i) => (
                  <section key={c.restaurantId} aria-label={c.restaurantName} className="flex flex-col gap-3 rounded-card border border-line bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-sans text-[15px] font-semibold tracking-normal">{c.restaurantName}</h3>
                      <span className="font-mono text-[11px] uppercase text-fg-3">
                        Delivery {i + 1} · ~{c.etaMinutes} min est.{isDemoEstimate(c.etaSource) ? ' (demo)' : ''}
                      </span>
                    </div>
                    {c.lines.map((l) => (
                      <div key={l.lineId} className="flex items-center gap-2.5 text-sm">
                        <VegMark veg={lineVeg.get(l.lineId) ?? true} size={13} />
                        <span className="min-w-0 flex-1">
                          {l.quantity} × {l.name}
                          {l.addOns.length ? <span className="text-fg-3"> · {l.addOns.map((a) => a.name).join(', ')}</span> : null}
                        </span>
                        <span className="tabular-nums">{rupees(l.lineTotalPaise)}</span>
                      </div>
                    ))}
                    <p className="text-xs text-fg-3">{c.delivery?.note && /separately/i.test(c.delivery.note) ? c.delivery.note : 'Delivered separately'}</p>
                  </section>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="w-full flex-[1_1_340px] lg:sticky lg:top-6 lg:max-w-[400px]">
          {p ? (
            <BillBreakdown
              key={p.children.map((c) => c.restaurantId).join(',')}
              sticky={false}
              groups={p.children.map((c) => ({ id: c.restaurantId, name: c.restaurantName, totalPaise: c.breakdown.totalPaise, rows: billRows(c.breakdown) }))}
              totalPaise={p.pricing.totalPaise}
              action={
                compact ? undefined : (
                  <div className="flex flex-col gap-2.5">
                    {payErrors}
                    {payButton}
                  </div>
                )
              }
              footnote="Totals come from Thali’s server. If a price changes before you pay, we’ll show old vs new and ask you to confirm."
            />
          ) : (
            <div aria-label="Bill, per restaurant" className="flex flex-col gap-3 rounded-card border border-line bg-card p-5">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-12 w-full" />
              {!address && addresses.data ? <p className="text-sm text-fg-3">Choose a delivery address to see the total.</p> : null}
            </div>
          )}
          {compact ? <div className="mt-3 flex flex-col gap-2.5">{payErrors}</div> : null}
        </div>
      </div>

      {/* ≤1023 sticky pay bar (design-spec §6.4) */}
      {compact ? (
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-line bg-card px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <span className="flex flex-col">
          <span className="text-xs text-fg-3">To pay{kitchens > 1 ? ` · ${plural(kitchens, 'delivery', 'deliveries')}` : ''}</span>
          <span className="text-xl font-semibold tabular-nums">{total !== undefined ? formatINR(total) : '—'}</span>
        </span>
        <div className="flex-1">{payButton}</div>
      </div>
      ) : null}

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a delivery address" size="lg">
        {adding ? (
          <AddressForm
            onSaved={(a) => {
              setAdding(false);
              setAddressId(a.id);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
      </Dialog>
      {cartOpen ? (
        <Suspense fallback={null}>
          <CartDrawer open onClose={() => setCartOpen(false)} />
        </Suspense>
      ) : null}
      <PriceChangedDialog
        details={priceChange}
        previous={p}
        busy={submitting}
        onClose={() => {
          setPriceChange(null);
          void preview.refetch();
        }}
        onConfirm={(t) => void submit(t)}
      />
    </>
  );
}

export default function CheckoutPage() {
  return (
    <RequireAuth signInMessage="Sign in with your phone number to place your order. Your cart is kept.">
      <CheckoutContent />
    </RequireAuth>
  );
}

