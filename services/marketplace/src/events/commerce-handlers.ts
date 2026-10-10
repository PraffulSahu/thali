/**
 * Commerce consumers (LLD §9) — `cg.marketplace` on `events.orders` + `events.payments`.
 * Each handler runs inside the consumer's transaction (inbox dedupe by event id); business-level
 * idempotency (same checkout, different event id) comes from the conditional status updates in
 * `domain/reservations.ts` / `domain/memberships.ts`.
 *
 *  checkout.confirmed  → commit reservation (stock, coupon REDEEMED, membership usage USED)
 *  checkout.released   → release holds; unknown checkoutId (orders' orphan release) = no-op
 *  order.rejected      → restock that child's restaurant lines (after commit)
 *  order.cancelled     → restock only if cancelled before PREPARING: `fromStatus` ∈ {PLACED, ACCEPTED}
 *                        when orders sends it (additive field), else only CUSTOMER cancels (customers
 *                        can cancel only from PLACED, LLD 4.1)
 *  payment.captured / payment.failed (purpose MEMBERSHIP) → activate / cancel the pending membership
 */
import type { EventHandlers } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import { activateMembership, failMembershipPayment } from '../domain/memberships.js';
import { closeChild, commitReservation, releaseReservation } from '../domain/reservations.js';
import type { EventHandlerModule } from './handlers.js';

const RESTOCK_FROM = new Set(['PLACED', 'ACCEPTED']);

export function shouldRestockOnCancel(p: { actor: string; fromStatus?: unknown }): boolean {
  if (typeof p.fromStatus === 'string') return RESTOCK_FROM.has(p.fromStatus);
  return p.actor === 'CUSTOMER';
}

export const commerceHandlerModule: EventHandlerModule = {
  name: 'commerce',
  streams: ['events.orders', 'events.payments'],
  handlers(ctx: AppContext): EventHandlers {
    return {
      'checkout.confirmed': async (e, session) => {
        const out = await commitReservation(ctx, session, e.payload.checkoutId, e.payload.childOrderIds);
        if (out === 'MISSING' || out === 'RELEASED') ctx.logger.warn({ checkoutId: e.payload.checkoutId, out }, 'checkout.confirmed without a HELD reservation');
      },
      'checkout.released': async (e, session) => {
        await releaseReservation(ctx, session, e.payload.checkoutId, e.payload.reason);
      },
      'order.rejected': async (e, session) => {
        const p = e.payload;
        await closeChild(ctx, session, { checkoutId: p.checkoutId, childOrderId: p.childOrderId, restaurantId: p.restaurantId, restock: true });
      },
      'order.cancelled': async (e, session) => {
        const p = e.payload; // fromStatus is in @thali/contracts (optional for older events)
        await closeChild(ctx, session, { checkoutId: p.checkoutId, childOrderId: p.childOrderId, restaurantId: p.restaurantId, restock: shouldRestockOnCancel(p) });
      },
      'payment.captured': async (e, session) => {
        if (e.payload.purpose !== 'MEMBERSHIP') return;
        await activateMembership(ctx, session, e.payload, e.correlationId);
      },
      'payment.failed': async (e, session) => {
        if (e.payload.purpose !== 'MEMBERSHIP') return;
        await failMembershipPayment(ctx, session, e.payload);
      },
    };
  },
};
