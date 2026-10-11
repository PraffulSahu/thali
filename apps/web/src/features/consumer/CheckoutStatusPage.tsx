/**
 * Checkout status (design-spec §7.2; PRD C-9, M-5): polls `GET /checkouts/:id` every 3 s while AWAITING_PAYMENT
 * (plus `order.updated` SSE) and shows "Confirming your payment…" until the SERVER reports the order placed — the
 * browser's payment callback is never trusted. Leaving and coming back resumes here.
 *   placed → "Order placed." + per-restaurant rows with chips + "Track order"
 *   failed attempt (still AWAITING_PAYMENT) → --bad box + "Try payment again" (same intent)
 *   PAYMENT_FAILED / EXPIRED → neutral box, cart kept, "Back to cart" · CANCELLED → neutral box
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { ButtonLink, Countdown, ErrorState, Icon, Price, Skeleton, SkeletonList, Spinner, StatusPill } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { usePolling } from '../../hooks/usePolling';
import { useRealtime } from '../../hooks/useRealtime';
import { CART_KEY, fetchCheckout, type CheckoutResponse } from './api';
import { Accent, DemoBadge } from './parts';
import { PayButton } from './PaymentStep';

export const checkoutKey = (id: string) => ['checkout', id] as const;
const PLACED = new Set(['PAID_PLACED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED']);
const SETTLED = new Set(['PAID_PLACED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED']);

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5 rounded-card-lg border border-line bg-card p-7 shadow-card max-sm:p-5">{children}</div>;
}

function StatusBody({ data }: { data: CheckoutResponse }) {
  const { checkout: c, payment } = data;
  const ctx = { kind: 'checkout' as const, checkoutId: c.id, description: `Order ${c.code}` };

  if (PLACED.has(c.status)) {
    return (
      <Frame>
        <span className="grid size-12 place-items-center rounded-full bg-ok-bg text-ok">
          <Icon name="check" size={26} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[34px] leading-[1.05]">
            Order <Accent>placed.</Accent>
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-3">
            <span className="font-mono">{c.code}</span> · Payment confirmed · <Price paise={c.pricing.totalPaise} size="sm" /> <DemoBadge show={c.isDemo} label="Demo payment" />
          </p>
        </div>
        <ul className="flex flex-col divide-y divide-line rounded-field border border-line">
          {c.children.map((ch, i) => (
            <li key={ch.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="flex flex-col">
                <span className="text-[14.5px] font-medium">{ch.restaurantName}</span>
                <span className="font-mono text-[11px] uppercase text-fg-3">Delivery {i + 1} · delivered separately</span>
              </span>
              <StatusPill kind="childOrder" status={ch.status} />
            </li>
          ))}
        </ul>
        {c.children.length > 1 ? <p className="text-[13.5px] text-fg-3">Each restaurant confirms and delivers its part separately — track them on the order page.</p> : null}
        <ButtonLink to={`/orders/${c.id}`} fullWidth size="lg" iconRight="arrow-right">
          Track order
        </ButtonLink>
      </Frame>
    );
  }

  if (c.status === 'CANCELLED') {
    return (
      <Frame>
        <h1 className="text-[28px]">This order was cancelled</h1>
        <div className="rounded-field border border-line bg-bg-2 p-4 text-sm text-fg-2">
          Your payment was received, but the order didn&rsquo;t go ahead. Any refund and the reason are shown on the order page.
        </div>
        <ButtonLink to={`/orders/${c.id}`} size="lg" fullWidth>
          View order and refund
        </ButtonLink>
      </Frame>
    );
  }

  if (c.status === 'PAYMENT_FAILED' || c.status === 'EXPIRED') {
    return (
      <Frame>
        <h1 className="text-[28px]">{c.status === 'EXPIRED' ? 'This checkout expired' : 'Payment didn’t go through'}</h1>
        <div className="rounded-field border border-line bg-bg-2 p-4 text-sm text-fg-2">
          {c.status === 'EXPIRED' ? 'This checkout expired — your cart is still saved.' : 'Payment failed — your cart is still saved.'} You weren&rsquo;t charged for this attempt, and any reserved items were released.
        </div>
        <ButtonLink to="/cart" size="lg" fullWidth>
          Back to cart
        </ButtonLink>
      </Frame>
    );
  }

  const attemptFailed = c.paymentStatus === 'FAILED';
  return (
    <Frame>
      {attemptFailed ? (
        <>
          <h1 className="text-[28px]" role="status">
            Payment failed — try again
          </h1>
          <div className="rounded-field bg-bad-bg p-4 text-sm text-bad">The payment didn&rsquo;t go through. Your items are held until the timer runs out.</div>
        </>
      ) : (
        <>
          <Spinner size={28} label={null} />
          <h1 className="text-[28px]" role="status" aria-live="polite">
            Confirming your payment…
          </h1>
          <p className="text-sm text-fg-2">We&rsquo;re waiting for the payment provider to confirm. This page updates automatically — it&rsquo;s safe to leave and come back.</p>
          <SkeletonList count={Math.min(3, c.children.length || 1)} />
        </>
      )}
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-3">
        Amount <Price paise={c.pricing.totalPaise} size="sm" />
        {c.expiresAt ? (
          <>
            · <Countdown to={c.expiresAt} label="Reservation expires in" expiredLabel="Reservation expired" />
          </>
        ) : null}
      </p>
      {payment ? (
        <div className="flex flex-col gap-2">
          {!attemptFailed ? <p className="text-sm text-fg-3">Haven&rsquo;t paid yet, or closed the payment window?</p> : null}
          <PayButton payment={payment} context={ctx} variant={attemptFailed ? 'primary' : 'secondary'} label={attemptFailed ? 'Try payment again' : undefined} />
        </div>
      ) : null}
      {c.isDemo ? <DemoBadge show label="Demo mode — simulated payment" /> : null}
    </Frame>
  );
}

function StatusView({ checkoutId }: { checkoutId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: checkoutKey(checkoutId), queryFn: () => fetchCheckout(checkoutId) });
  const awaiting = q.data?.checkout.status === 'AWAITING_PAYMENT';
  usePolling(() => q.refetch(), 3000, { enabled: awaiting || q.isError, pauseWhenHidden: true });
  useRealtime<{ checkoutId?: string }>(
    ['order.updated'],
    (e) => {
      if (e.data.checkoutId === checkoutId) void q.refetch();
    },
    { fallbackRefetch: q.refetch, enabled: awaiting },
  );
  const placed = q.data && SETTLED.has(q.data.checkout.status);
  useEffect(() => {
    if (placed) {
      void qc.invalidateQueries({ queryKey: CART_KEY });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    }
  }, [placed, qc]);

  if (q.isPending) return <Skeleton className="mx-auto h-72 w-full max-w-[560px] rounded-card-lg" />;
  if (q.isError) return <ErrorState error={q.error} title="Couldn't load the payment status" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return <StatusBody data={q.data} />;
}

export default function CheckoutStatusPage() {
  const { checkoutId = '' } = useParams();
  return (
    <div className="pt-6">
      <RequireAuth signInMessage="Sign in to see your payment status.">
        <StatusView checkoutId={checkoutId} />
      </RequireAuth>
    </div>
  );
}
