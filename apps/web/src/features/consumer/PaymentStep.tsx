/**
 * Hosted payment step (PRD C-9), shared by checkout and membership purchase.
 *
 * - provider `razorpay`: loads Razorpay Standard Checkout (`https://checkout.razorpay.com/v1/checkout.js`) and
 *   opens `new Razorpay({ key, order_id, amount, currency, name, prefill, handler, modal: { ondismiss } })`.
 *   The handler result is sent to `POST /payments/:intentId/verify`, which only triggers server reconciliation;
 *   the browser callback is NEVER treated as "paid" — the status page waits for the server (PAID_PLACED).
 * - provider `mock` (demo/sandbox): goes to the labeled DemoPayPage (`/demo-pay/:intentId`).
 */
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, InlineError } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { ApiError } from '../../lib/errors';
import { formatINR } from '../../lib/format';
import { verifyPayment, type PaymentView, type RazorpayHandlerResponse } from './api';

export const RAZORPAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  theme?: { color?: string };
  handler: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void; confirm_close?: boolean };
}
interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (resp: { error?: { description?: string; reason?: string } }) => void): void;
}
type RazorpayCtor = new (options: RazorpayOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let scriptPromise: Promise<RazorpayCtor> | null = null;

/** Loads checkout.js once (shared promise; retried on the next call after a failure). */
export function loadRazorpay(): Promise<RazorpayCtor> {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!scriptPromise) {
    scriptPromise = new Promise<RazorpayCtor>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = RAZORPAY_SCRIPT_URL;
      s.async = true;
      s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay failed to initialise')));
      s.onerror = () => reject(new Error("Couldn't load the payment window. Check your connection and try again."));
      document.head.appendChild(s);
    }).catch((e: unknown) => {
      scriptPromise = null;
      throw e;
    });
  }
  return scriptPromise;
}

export type PaymentContext =
  | { kind: 'checkout'; checkoutId: string; description?: string }
  | { kind: 'membership'; description?: string };

export function statusPathFor(ctx: PaymentContext, intentId: string): string {
  return ctx.kind === 'checkout' ? `/checkout/status/${ctx.checkoutId}` : `/membership?payment=${encodeURIComponent(intentId)}`;
}

/** Returns `launch(payment, ctx)`; resolves once the provider window is open (or the demo page is shown). */
export function usePaymentLauncher() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);

  const launch = useCallback(
    async (payment: PaymentView, ctx: PaymentContext) => {
      if (busyRef.current) return;
      setError(null);
      const statusPath = statusPathFor(ctx, payment.intentId);
      if (payment.provider !== 'razorpay') {
        const back = encodeURIComponent(statusPath);
        navigate(`/demo-pay/${payment.intentId}?return=${back}`);
        return;
      }
      if (!payment.keyId || !payment.providerOrderId) {
        setError(new ApiError({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', status: 502, message: 'Payment is not configured right now. Please try again later.' }));
        return;
      }
      busyRef.current = true;
      setOpening(true);
      try {
        const Razorpay = await loadRazorpay();
        let settled = false;
        const rzp = new Razorpay({
          key: payment.keyId,
          order_id: payment.providerOrderId,
          amount: payment.amountPaise,
          currency: payment.currency,
          name: 'Thali',
          description: ctx.description ?? (ctx.kind === 'checkout' ? 'Food order' : 'Thali membership'),
          prefill: {
            ...(typeof user?.name === 'string' && user.name ? { name: user.name } : {}),
            ...(typeof user?.email === 'string' && user.email ? { email: user.email } : {}),
            ...(typeof user?.phone === 'string' && user.phone ? { contact: user.phone } : {}),
          },
          theme: { color: '#C2410C' },
          handler: (resp) => {
            settled = true;
            // Reconcile only; the status page decides from the server's state.
            void verifyPayment(payment.intentId, resp)
              .catch(() => undefined)
              .finally(() => navigate(statusPath));
          },
          modal: {
            ondismiss: () => {
              if (!settled) navigate(statusPath);
            },
          },
        });
        rzp.open();
      } catch (e) {
        setError(e);
      } finally {
        busyRef.current = false;
        setOpening(false);
      }
    },
    [navigate, user],
  );

  return { launch, opening, error };
}

/** "Pay ₹X" / "Try again" button for an existing payment intent (status page, membership page). */
export function PayButton({
  payment,
  context,
  label,
  variant = 'primary',
}: {
  payment: PaymentView;
  context: PaymentContext;
  label?: string;
  variant?: 'primary' | 'secondary';
}) {
  const { launch, opening, error } = usePaymentLauncher();
  return (
    <div className="space-y-2">
      <Button variant={variant} loading={opening} icon="wallet" onClick={() => void launch(payment, context)}>
        {label ?? `Pay ${formatINR(payment.amountPaise)}`}
      </Button>
      <InlineError error={error} />
    </div>
  );
}
