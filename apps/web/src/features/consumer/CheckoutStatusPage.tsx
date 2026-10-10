/**
 * Checkout status (PRD C-9, M-5 "customer leaves the payment page"): polls `GET /checkouts/:id` every 3 s while
 * AWAITING_PAYMENT (plus `order.updated` SSE) and shows "Confirming payment…" until the SERVER reports the
 * order placed — the browser's payment callback is never trusted. Leaving and coming back resumes here.
 * A failed attempt (paymentStatus FAILED while still AWAITING_PAYMENT) can be retried on the same intent;
 * PAYMENT_FAILED / EXPIRED are terminal (the cart is kept).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { Badge, ButtonLink, Card, Countdown, Icon, PageHeader, Price, QueryState, Skeleton, Spinner } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { usePolling } from '../../hooks/usePolling';
import { useRealtime } from '../../hooks/useRealtime';
import { CART_KEY, fetchCheckout, type CheckoutResponse } from './api';
import { DemoBadge, SeparateDeliveryNote } from './parts';
import { PayButton } from './PaymentStep';

export const checkoutKey = (id: string) => ['checkout', id] as const;
const PLACED = new Set(['PAID_PLACED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED']);

function StatusBody({ data }: { data: CheckoutResponse }) {
  const { checkout: c, payment } = data;
  const ctx = { kind: 'checkout' as const, checkoutId: c.id, description: `Order ${c.code}` };

  if (PLACED.has(c.status)) {
    return (
      <Card className="mx-auto max-w-xl" padding="lg">
        <div className="mb-3 flex items-center gap-3">
          <span className="grid size-12 place-items-center rounded-full bg-success-50 text-success-700">
            <Icon name="check" size={28} />
          </span>
          <div>
            <h2 className="text-xl font-bold text-slate-900">Order placed</h2>
            <p className="text-sm text-slate-600">
              Payment confirmed · <Price paise={c.pricing.totalPaise} size="sm" /> <DemoBadge show={c.isDemo} label="Demo payment" />
            </p>
          </div>
        </div>
        <ul className="mb-4 space-y-2">
          {c.children.map((ch) => (
            <li key={ch.id} className="rounded-control border border-slate-200 px-3 py-2">
              <p className="font-medium text-slate-900">{ch.restaurantName}</p>
              <SeparateDeliveryNote note={ch.delivery?.note} />
            </li>
          ))}
        </ul>
        {c.children.length > 1 ? <p className="mb-4 text-sm text-slate-600">Each restaurant confirms and delivers its part separately — track them on the order page.</p> : null}
        <ButtonLink to={`/orders/${c.id}`} fullWidth size="lg" iconRight="chevron-right">
          Track your order
        </ButtonLink>
      </Card>
    );
  }

  if (c.status === 'PAYMENT_FAILED' || c.status === 'EXPIRED') {
    return (
      <Card className="mx-auto max-w-xl text-center" padding="lg" tone="warn">
        <Icon name="alert" size={32} className="mx-auto mb-2 text-warn-700" />
        <h2 className="text-xl font-bold text-slate-900">{c.status === 'EXPIRED' ? 'This checkout expired — your cart is still saved' : 'Payment failed — your cart is still saved'}</h2>
        <p className="my-3 text-sm text-slate-700">You weren&rsquo;t charged for this attempt. Any reserved items were released; check the cart and try again.</p>
        <ButtonLink to="/cart" size="lg">
          Back to cart
        </ButtonLink>
      </Card>
    );
  }

  // AWAITING_PAYMENT
  const attemptFailed = c.paymentStatus === 'FAILED';
  return (
    <Card className="mx-auto max-w-xl text-center" padding="lg">
      {attemptFailed ? (
        <>
          <Icon name="alert" size={32} className="mx-auto mb-2 text-danger-700" />
          <h2 className="text-xl font-bold text-slate-900" role="status">
            Payment failed — try again
          </h2>
          <p className="my-3 text-sm text-slate-700">The payment didn&rsquo;t go through. Your items are held until the timer runs out.</p>
        </>
      ) : (
        <>
          <Spinner className="mx-auto mb-3" />
          <h2 className="text-xl font-bold text-slate-900" role="status" aria-live="polite">
            Confirming payment…
          </h2>
          <p className="my-3 text-sm text-slate-700">
            We&rsquo;re waiting for the payment provider to confirm. This page updates automatically — it&rsquo;s safe to leave and come back.
          </p>
        </>
      )}
      <p className="mb-4 flex items-center justify-center gap-2 text-sm text-slate-600">
        Amount <Price paise={c.pricing.totalPaise} size="sm" />
        {c.expiresAt ? (
          <>
            · <Countdown to={c.expiresAt} label="Reservation expires in" expiredLabel="Reservation expired" />
          </>
        ) : null}
      </p>
      {payment ? (
        <div className="flex flex-col items-center gap-2">
          {!attemptFailed ? <p className="text-sm text-slate-600">Haven&rsquo;t paid yet, or closed the payment window?</p> : null}
          <PayButton payment={payment} context={ctx} variant={attemptFailed ? 'primary' : 'secondary'} label={attemptFailed ? 'Try again' : undefined} />
        </div>
      ) : null}
      {c.isDemo ? (
        <Badge tone="info" className="mt-4">
          Demo mode — simulated payment
        </Badge>
      ) : null}
    </Card>
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
  const placed = q.data && PLACED.has(q.data.checkout.status);
  useEffect(() => {
    if (placed) {
      void qc.invalidateQueries({ queryKey: CART_KEY });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    }
  }, [placed, qc]);

  return (
    <>
      <PageHeader
        title={q.data ? `Order ${q.data.checkout.code}` : 'Order status'}
        back={{ to: '/orders', label: 'Orders' }}
      />
      <QueryState query={q} loading={<Skeleton className="mx-auto h-64 w-full max-w-xl" />} errorTitle="Couldn't load the payment status">
        {(data) => <StatusBody data={data} />}
      </QueryState>
    </>
  );
}

export default function CheckoutStatusPage() {
  const { checkoutId = '' } = useParams();
  return (
    <RequireAuth signInMessage="Sign in to see your payment status.">
      <StatusView checkoutId={checkoutId} />
    </RequireAuth>
  );
}
