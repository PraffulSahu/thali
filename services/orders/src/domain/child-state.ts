/**
 * State helpers shared by every child-order / checkout state change (Task 11 placement/release,
 * Task 12 `transitionChild`). All mutate in-memory docs only — callers save with `{ session }`
 * inside their transaction and emit events through the outbox.
 */
import {
  assertTransition,
  checkoutTransitions,
  childOrderTransitions,
  deriveCheckoutStatus,
  type Actor,
  type CheckoutStatus,
  type ChildOrderStatus,
} from '@thali/contracts';
import type { CheckoutGroupDoc } from '../models/checkout-group.js';
import type { ChildOrder, ChildOrderDoc } from '../models/child-order.js';

export interface TransitionMeta {
  actor: Actor;
  actorId?: string | null;
  reason?: string | null;
  at?: Date;
}

/** Timestamp field set when a child enters a status (LLD §3.3 / §4.1). */
export const CHILD_STATUS_TIMESTAMP: Partial<Record<ChildOrderStatus, keyof ChildOrder>> = {
  PLACED: 'placedAt',
  ACCEPTED: 'acceptedAt',
  READY_FOR_PICKUP: 'readyAt',
  PICKED_UP: 'pickedUpAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
};

/**
 * Validate (`assertTransition` → 409 ORDER_INVALID_TRANSITION) and apply one child transition:
 * status, statusHistory entry, entry timestamp. Does not save.
 */
export function applyChildTransition(child: ChildOrderDoc, to: ChildOrderStatus, meta: TransitionMeta): void {
  const from = child.status;
  assertTransition(childOrderTransitions, from, to, meta.actor);
  const at = meta.at ?? new Date();
  child.status = to;
  child.statusHistory.push({ from, to, actor: meta.actor, actorId: meta.actorId ?? null, reason: meta.reason ?? null, at });
  const tsField = CHILD_STATUS_TIMESTAMP[to];
  if (tsField) child.set(tsField, at);
}

/**
 * Recompute the parent status from its children (LLD §4.2 `deriveCheckoutStatus`), validate the
 * checkout transition (SYSTEM) and record history when it changed. Does not save.
 */
export function applyDerivedCheckoutStatus(
  group: CheckoutGroupDoc,
  childStatuses: ChildOrderStatus[],
  meta: Omit<TransitionMeta, 'actor'> & { actor?: Actor } = {},
): { from: CheckoutStatus; to: CheckoutStatus; changed: boolean } {
  const from = group.status;
  const to = deriveCheckoutStatus(childStatuses, from);
  if (to === from) return { from, to, changed: false };
  assertTransition(checkoutTransitions, from, to, 'SYSTEM');
  group.status = to;
  group.statusHistory.push({
    from,
    to,
    actor: meta.actor ?? 'SYSTEM',
    actorId: meta.actorId ?? null,
    reason: meta.reason ?? null,
    at: meta.at ?? new Date(),
  });
  return { from, to, changed: true };
}
