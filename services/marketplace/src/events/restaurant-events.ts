/**
 * Restaurant events (LLD 9) — always emitted through the outbox inside the caller's transaction.
 */
import type { ClientSession, Connection } from 'mongoose';
import type { GeoJsonPoint, RestaurantStatus } from '@thali/contracts';
import { emitEvent } from '@thali/service-kit';

interface RestaurantLike {
  _id: unknown;
  ownerUserId: string;
  name: string;
  status: string;
  location?: { type?: string; coordinates: number[] } | null;
}

/** Events require a location; drafts without one carry [0,0] (orders only projects APPROVED ones). */
const point = (r: RestaurantLike): GeoJsonPoint => ({
  type: 'Point',
  coordinates: (r.location?.coordinates?.length === 2 ? [r.location.coordinates[0]!, r.location.coordinates[1]!] : [0, 0]) as [number, number],
});

const opts = (r: RestaurantLike) => ({ producer: 'marketplace' as const, aggregateId: String(r._id) });

export function emitRestaurantSubmitted(conn: Connection, session: ClientSession, r: RestaurantLike) {
  return emitEvent(conn, session, 'restaurant.submitted', { restaurantId: String(r._id), ownerUserId: r.ownerUserId }, opts(r));
}

export function emitEmailVerificationRequested(conn: Connection, session: ClientSession, r: RestaurantLike, email: string, verifyUrl: string) {
  return emitEvent(conn, session, 'restaurant.email_verification_requested', { restaurantId: String(r._id), email, verifyUrl }, opts(r));
}

export function emitStatusChanged(
  conn: Connection,
  session: ClientSession,
  r: RestaurantLike,
  from: RestaurantStatus,
  to: RestaurantStatus,
  reason?: string,
) {
  return emitEvent(
    conn,
    session,
    'restaurant.status_changed',
    { restaurantId: String(r._id), ownerUserId: r.ownerUserId, name: r.name, from, to, ...(reason ? { reason } : {}), location: point(r) },
    opts(r),
  );
}

export function emitRestaurantUpdated(conn: Connection, session: ClientSession, r: RestaurantLike) {
  return emitEvent(
    conn,
    session,
    'restaurant.updated',
    { restaurantId: String(r._id), ownerUserId: r.ownerUserId, name: r.name, status: r.status as RestaurantStatus, location: point(r) },
    opts(r),
  );
}
