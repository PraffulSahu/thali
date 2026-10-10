/**
 * Restaurant projection (`events.marketplace`, LLD §3.3 `restaurant_projection`, §9):
 * `restaurant.status_changed` / `restaurant.updated` upsert `{ownerUserId, name, status, location}`.
 * Ordered by envelope `occurredAt` (`eventAt`): an older event never overwrites a newer one.
 */
import type { ClientSession } from 'mongoose';
import type { GeoJsonPoint } from '@thali/contracts';
import type { EventHandlers } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { EventModule } from './types.js';

export async function upsertRestaurantProjection(
  ctx: OrdersContext,
  session: ClientSession,
  p: { restaurantId: string; ownerUserId: string; name: string; status: string; location?: GeoJsonPoint | null },
  at: Date,
): Promise<boolean> {
  const current = await ctx.models.RestaurantProjection.findById(p.restaurantId, { eventAt: 1 }).session(session).lean();
  if (current?.eventAt && new Date(current.eventAt).getTime() > at.getTime()) return false;
  await ctx.models.RestaurantProjection.updateOne(
    { _id: p.restaurantId },
    {
      $set: {
        ownerUserId: p.ownerUserId,
        name: p.name,
        status: p.status,
        location: p.location ? { type: 'Point', coordinates: [p.location.coordinates[0], p.location.coordinates[1]] } : null,
        eventAt: at,
      },
    },
    { upsert: true, session },
  );
  return true;
}

export function restaurantHandlers(ctx: OrdersContext): EventHandlers {
  return {
    'restaurant.status_changed': async (e, session) => {
      const p = e.payload;
      await upsertRestaurantProjection(ctx, session, { restaurantId: p.restaurantId, ownerUserId: p.ownerUserId, name: p.name, status: p.to, location: p.location }, new Date(e.occurredAt));
    },
    'restaurant.updated': async (e, session) => {
      const p = e.payload;
      await upsertRestaurantProjection(ctx, session, { restaurantId: p.restaurantId, ownerUserId: p.ownerUserId, name: p.name, status: p.status, location: p.location }, new Date(e.occurredAt));
    },
  };
}

export const restaurantEventsModule: EventModule = {
  name: 'restaurants',
  streams: ['events.marketplace'],
  handlers: restaurantHandlers,
};
