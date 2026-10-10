/**
 * Restaurant state machine (LLD 4.6) via contracts `restaurantTransitions`: asserts the transition,
 * updates status/statusReason/statusHistory and enqueues `restaurant.status_changed`. Runs inside
 * the caller's transaction; the caller saves the document (OCC version check).
 */
import type { ClientSession } from 'mongoose';
import { assertTransition, restaurantTransitions, type Actor, type RestaurantStatus } from '@thali/contracts';
import type { AppContext } from '../context.js';
import { emitStatusChanged } from '../events/restaurant-events.js';
import type { RestaurantHydrated } from './restaurant-view.js';

export async function transitionRestaurant(
  ctx: AppContext,
  session: ClientSession,
  doc: RestaurantHydrated,
  to: RestaurantStatus,
  by: { actor: Actor; actorId: string; reason?: string },
): Promise<void> {
  const from = doc.status as RestaurantStatus;
  assertTransition(restaurantTransitions, from, to, by.actor);
  doc.status = to;
  doc.statusReason = by.reason ?? undefined;
  doc.statusHistory.push({ from, to, actorId: by.actorId, reason: by.reason, at: ctx.now() });
  await emitStatusChanged(ctx.conn, session, doc, from, to, by.reason);
}
