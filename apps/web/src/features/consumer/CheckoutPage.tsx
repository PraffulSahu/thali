/**
 * Checkout (PRD C-9, §4.5). The server is the authority: `POST /cart/preview` re-quotes prices, stock, open
 * status, coupon, membership and serviceability for the chosen address and returns a per-restaurant breakdown.
 * "Pay ₹X" posts `/checkouts` with `expectedTotalPaise` and an Idempotency-Key that is generated once per
 * attempt (same payload) and reused on retries / double clicks. PRICE_CHANGED shows the difference and asks to
 * confirm; cart problems link back to the cart. On success the payment step opens (Razorpay or demo page).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  PageHeader,
  Price,
  QueryState,
  RadioGroup,
  Skeleton,
  SkeletonList,
  Switch,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { newIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { errorMessage, isApiError } from '../../lib/errors';
import { formatINR } from '../../lib/format';
import {
  addressToInput,
  cartApi,
  createCheckout,
  fetchCoupons,
  fetchMyMemberships,
  formatAddress,
  MEMBERSHIP_KEY,
  previewCart,
  priceChangedDetails,
  problemsFromError,
  useAddresses,
  useCart,
  type CartPreview,
  type CreateCheckoutBody,
  type PriceChangedDetails,
  type PricedChild,
  type QuoteProblem,
  type SavedAddress,
} from './api';
import { AddressForm } from './AddressesPage';
import { useChosenLocation } from './location';
import { BreakdownRows, EtaText, SeparateDeliveryNote } from './parts';
import { usePaymentLauncher } from './PaymentStep';

function ChildBreakdown({ child }: { child: PricedChild }) {
  return (
    <Card as="section" aria-label={child.restaurantName}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">{child.restaurantName}</h3>
        <EtaText minutes={child.etaMinutes} distanceKm={child.distanceKm} source={child.etaSource} />
      </div>
      <SeparateDeliveryNote note={child.delivery?.note} className="mb-2" />
      <ul className="mb-2 space-y-0.5 text-sm text-slate-700">
        {child.lines.map((l) => (
          <li key={l.lineId} className="flex justify-between gap-2">
            <span>
              {l.quantity} × {l.name}
              {l.addOns.length ? <span className="text-slate-500"> ({l.addOns.map((a) => a.name).join(', ')})</span> : null}
            </span>
            <Price paise={l.lineTotalPaise} size="sm" tone="muted" />
          </li>
        ))}
      </ul>
      <BreakdownRows b={child.breakdown} totalLabel="Restaurant total" />
    </Card>
  );
}

function ProblemList({ problems }: { problems: QuoteProblem[] }) {
  if (!problems.length) return null;
  return (
    <Card tone="warn" aria-label="Problems with your cart">
      <h2 className="mb-2 flex items-center gap-2 font-semibold text-warn-800">
        <Icon name="alert" size={18} /> Some items can&rsquo;t be ordered right now
      </h2>
      <ul className="space-y-2">
        {problems.map((p, i) => (
          <li key={`${p.code}-${p.itemId ?? p.restaurantId ?? i}`} className="flex flex-wrap items-center justify-between gap-2 text-sm text-warn-800">
            <span>{p.message || p.code}</span>
            <Link to="/cart" className="font-semibold text-brand-700 underline">
              Fix in cart
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PriceChangedDialog({
  details,
  previous,
  onClose,
  onConfirm,
  busy,
}: {
  details: PriceChangedDetails | null;
  previous: CartPreview | undefined;
  onClose: () => void;
  onConfirm: (total: number) => void;
  busy: boolean;
}) {
  if (!details) return null;
  const before = new Map(previous?.children.map((c) => [c.restaurantId, c.breakdown.totalPaise]) ?? []);
  const changed = details.children.filter((c) => before.get(c.restaurantId) !== c.breakdown.totalPaise);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Prices changed"
      description="Something in your order changed since you last looked (prices, fees or offers). Review the new total before paying."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>
            Review order
          </Button>
          <Button onClick={() => onConfirm(details.pricing.totalPaise)} loading={busy}>
            Pay {formatINR(details.pricing.totalPaise)}
          </Button>
        </div>
      }
    >
      <dl className="space-y-1">
        <div className="flex justify-between text-slate-700">
          <dt>You saw</dt>
          <dd>
            <s>{formatINR(details.expectedTotalPaise)}</s>
          </dd>
        </div>
        <div className="flex justify-between font-semibold text-slate-900">
          <dt>New total</dt>
          <dd>{formatINR(details.pricing.totalPaise)}</dd>
        </div>
      </dl>
      {changed.length ? (
        <ul className="mt-3 space-y-1 border-t border-slate-200 pt-3 text-sm text-slate-700">
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

function AddressStep({
  addresses,
  selectedId,
  onSelect,
}: {
  addresses: SavedAddress[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Card as="section" aria-label="Delivery address">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Delivery address</h2>
        <Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(true)}>
          Add new
        </Button>
      </div>
      {addresses.length === 0 ? (
        <EmptyState compact icon="location" title="Add a delivery address" description="We need the exact drop point to check which restaurants can deliver." action={<Button onClick={() => setAdding(true)}>Add address</Button>} />
      ) : (
        <RadioGroup
          legend="Deliver to"
          hideLegend
          name="address"
          variant="cards"
          value={selectedId}
          onChange={onSelect}
          options={addresses.map((a) => ({
            value: a.id,
            label: (
              <span>
                {a.label || 'Address'} {a.isDefault ? <Badge tone="neutral">Default</Badge> : null}
              </span>
            ),
            description: formatAddress(a),
          }))}
        />
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a delivery address" size="lg">
        {adding ? (
          <AddressForm
            onSaved={(a) => {
              setAdding(false);
              onSelect(a.id);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
      </Dialog>
    </Card>
  );
}

function CheckoutContent() {
  const qc = useQueryClient();
  const cart = useCart();
  const addresses = useAddresses();
  const chosen = useChosenLocation();
  const coupons = useQuery({ queryKey: ['coupons', 'available'], queryFn: fetchCoupons, retry: false, staleTime: 60_000 });
  const membership = useQuery({ queryKey: MEMBERSHIP_KEY, queryFn: fetchMyMemberships, retry: false });
  const { launch, opening, error: launchError } = usePaymentLauncher();

  const [addressId, setAddressId] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<string | null | undefined>(undefined);
  const [useMembership, setUseMembership] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitProblems, setSubmitProblems] = useState<QuoteProblem[]>([]);
  const [priceChange, setPriceChange] = useState<PriceChangedDetails | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);

  // initial address: chosen saved address -> default -> first
  useEffect(() => {
    if (addressId || !addresses.data?.length) return;
    const list = addresses.data;
    const pick = list.find((a) => a.id === chosen?.addressId) ?? list.find((a) => a.isDefault) ?? list[0]!;
    setAddressId(pick.id);
  }, [addresses.data, addressId, chosen?.addressId]);

  // initial coupon from the cart
  useEffect(() => {
    if (coupon === undefined && cart.data) {
      setCoupon(cart.data.couponCode);
      setCouponInput(cart.data.couponCode ?? '');
    }
  }, [cart.data, coupon]);

  const address = useMemo(() => addresses.data?.find((a) => a.id === addressId) ?? null, [addresses.data, addressId]);
  const hasItems = (cart.data?.groups.length ?? 0) > 0;
  const preview = useQuery({
    queryKey: ['checkout-preview', addressId, coupon ?? null, useMembership, cart.data?.cartVersion],
    queryFn: () => previewCart({ address: addressToInput(address!), couponCode: coupon ?? null, useMembership }),
    enabled: !!address && hasItems && coupon !== undefined,
  });
  const activeMembership = membership.data?.active && membership.data.active.status === 'ACTIVE' ? membership.data.active : null;

  const applyCoupon = (code: string | null) => {
    const c = code?.trim().toUpperCase() || null;
    setCoupon(c);
    setCouponInput(c ?? '');
    void cartApi.setCoupon(c).catch(() => undefined); // persisted for next visit; preview decides validity
  };

  const submit = async (expectedTotalPaise: number) => {
    if (inFlight.current || !address) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitProblems([]);
    const body: CreateCheckoutBody = {
      address: addressToInput(address),
      ...(coupon ? { couponCode: coupon } : {}),
      useMembership,
      expectedTotalPaise,
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
      if (changed) {
        setPriceChange(changed);
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

  if (cart.data && !hasItems) {
    return (
      <EmptyState icon="cart" title="Your cart is empty" description="Add dishes before checking out." action={<ButtonLink to="/">Find restaurants</ButtonLink>} />
    );
  }

  const p = preview.data;
  const problems = submitProblems.length ? submitProblems : (p?.problems ?? []);
  const total = p?.pricing.totalPaise;
  const payDisabled = !p || !p.canCheckout || submitProblems.length > 0 || preview.isFetching;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <QueryState query={addresses} loading={<Skeleton className="h-32 w-full" />}>
          {(list) => <AddressStep addresses={list} selectedId={addressId} onSelect={setAddressId} />}
        </QueryState>

        <Card as="section" aria-label="Offers">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Offers</h2>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyCoupon(couponInput);
            }}
          >
            <Field label="Coupon code" className="flex-1">
              <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value)} maxLength={40} autoCapitalize="characters" />
            </Field>
            <Button type="submit" variant="secondary" disabled={!couponInput.trim()}>
              Apply
            </Button>
          </form>
          {coupons.data?.length ? (
            <div className="mt-2 flex flex-wrap gap-2" aria-label="Available coupons">
              {coupons.data.map((c) => (
                <button key={c.code} type="button" className="min-h-touch rounded-pill border border-dashed border-brand-300 px-3 text-sm text-brand-800 hover:bg-brand-50" onClick={() => applyCoupon(c.code)} title={c.description}>
                  {c.code}
                </button>
              ))}
            </div>
          ) : null}
          {p?.coupon ? (
            <p aria-live="polite" className={p.coupon.valid ? 'mt-2 text-sm text-success-800' : 'mt-2 text-sm text-warn-800'}>
              {p.coupon.valid ? (
                <>
                  <Icon name="check" size={14} /> {p.coupon.code} applied — you save {formatINR(p.coupon.discountPaise)}.
                </>
              ) : (
                <>{p.coupon.message ?? `${p.coupon.code} can't be used on this order.`}</>
              )}{' '}
              <Button variant="link" size="sm" onClick={() => applyCoupon(null)}>
                Remove
              </Button>
            </p>
          ) : null}
          <div className="mt-3 border-t border-slate-200 pt-3">
            {activeMembership ? (
              <Switch
                label="Use membership benefits"
                description="Free deliveries and extra discounts from your plan, checked by the server."
                checked={useMembership}
                onChange={(e) => setUseMembership(e.target.checked)}
              />
            ) : (
              <p className="text-sm text-slate-600">
                <Link to="/membership" className="font-medium text-brand-700 underline">
                  Get a membership
                </Link>{' '}
                for free deliveries on eligible orders.
              </p>
            )}
            {useMembership && p?.membership && !p.membership.applied ? <p className="mt-1 text-sm text-warn-800">No membership benefit applies to this order.</p> : null}
          </div>
        </Card>

        <ProblemList problems={problems} />

        {address ? (
          <section aria-label="Order breakdown by restaurant" className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">Your order</h2>
            {preview.isPending && !p ? <SkeletonList count={2} /> : null}
            {preview.isError && !p ? (
              <Card tone="danger">
                <p className="text-sm text-danger-800">Couldn&rsquo;t price your order: {errorMessage(preview.error)}</p>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => void preview.refetch()}>
                  Retry
                </Button>
              </Card>
            ) : null}
            {p?.deliveryExplanation ? <p className="rounded-control bg-info-50 px-3 py-2 text-sm text-info-800">{p.deliveryExplanation}</p> : null}
            {p?.children.map((c) => <ChildBreakdown key={c.restaurantId} child={c} />)}
          </section>
        ) : null}
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card as="section" aria-label="Total to pay">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Bill total</h2>
          {p ? <BreakdownRows b={p.pricing} totalLabel="To pay" /> : <Skeleton className="h-32 w-full" />}
          {p && p.children.length > 1 ? <p className="mt-2 text-xs text-slate-600">Includes a delivery fee for each of the {p.children.length} restaurants.</p> : null}
          <div className="mt-4 space-y-2">
            {submitError || launchError ? (
              <div role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-800">
                Couldn&rsquo;t start payment: {errorMessage(submitError ?? launchError)}
                {isApiError(submitError) && submitError.requestId ? <span className="block text-xs">Reference: {submitError.requestId}</span> : null}
              </div>
            ) : null}
            <Button
              fullWidth
              size="lg"
              icon="wallet"
              disabled={payDisabled}
              loading={submitting || opening}
              onClick={() => total !== undefined && void submit(total)}
            >
              {total !== undefined ? `Pay ${formatINR(total)}` : 'Pay'}
            </Button>
            {!address && addresses.data ? <p className="text-center text-sm text-slate-600">Choose a delivery address to see the total.</p> : null}
            <p className="text-center text-xs text-slate-600">Prices, stock and offers are re-checked by the server before payment.</p>
          </div>
        </Card>
      </aside>

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
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <>
      <PageHeader title="Checkout" back={{ to: '/cart', label: 'Cart' }} />
      <RequireAuth signInMessage="Sign in with your phone number to place your order. Your cart is kept.">
        <CheckoutContent />
      </RequireAuth>
    </>
  );
}
