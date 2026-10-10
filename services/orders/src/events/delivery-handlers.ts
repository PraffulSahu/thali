/**
 * Delivery event consumers (`events.delivery`, LLD §4.1 / §8 / §9). Child transitions go through
 * `transitionChild` (actor SYSTEM). Ordering rules:
 *  - `delivery.picked_up` while ACCEPTED/PREPARING is allowed (restaurant forgot "ready")
 *  - `delivery.started` / `delivery.delivered` arriving early walk the missing steps implicitly
 *    (PICKED_UP → OUT_FOR_DELIVERY → DELIVERED, one history entry + event each)
 *  - anything that implies an earlier state than the current one is stale → ignored (no error,
 *    so duplicates / late copies are no-ops and never dead-letter)
 *  - events for a job other than the child's recorded `deliveryJobId` are ignored
 *  - `delivery.assigned` / `delivery.unassigned` only update the mirror (job, partner,
 *    deliveryStatus), ordered by envelope `occurredAt`.
 */
import { Types, type ClientSession } from 'mongoose';
import type { ChildOrderStatus, EventEnvelope } from '@thali/contracts';
import type { EventHandlers } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { ChildOrderDoc } from '../models/child-order.js';
import { appendOrderEvents } from '../models/order-event.js';
import { queueOwnerOrder, transitionChild } from '../domain/lifecycle.js';
import { publishChildUpdate } from '../domain/place.js';
import type { EventModule } from './types.js';

const PRE_PICKUP: ChildOrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];

type DeliveryEventType = 'delivery.assigned' | 'delivery.unassigned' | 'delivery.picked_up' | 'delivery.started' | 'delivery.delivered' | 'delivery.failed';

/** Status path each lifecycle event needs from the child's current status ([] = stale / not applicable). */
export function pathFor(type: DeliveryEventType, status: ChildOrderStatus): ChildOrderStatus[] {
  const pre = PRE_PICKUP.includes(status);
  switch (type) {
    case 'delivery.picked_up':
      return pre ? ['PICKED_UP'] : [];
    case 'delivery.started':
      return pre ? ['PICKED_UP', 'OUT_FOR_DELIVERY'] : status === 'PICKED_UP' ? ['OUT_FOR_DELIVERY'] : [];
    case 'delivery.delivered':
      if (pre) return ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED'];
      if (status === 'PICKED_UP') return ['OUT_FOR_DELIVERY', 'DELIVERED'];
      return status === 'OUT_FOR_DELIVERY' ? ['DELIVERED'] : [];
    case 'delivery.failed':
      return status === 'PICKED_UP' || status === 'OUT_FOR_DELIVERY' ? ['DELIVERY_FAILED'] : [];
    default:
      return [];
  }
}

const MIRROR: Partial<Record<DeliveryEventType, string>> = {
  'delivery.picked_up': 'PICKED_UP',
  'delivery.started': 'OUT_FOR_DELIVERY',
  'delivery.delivered': 'DELIVERED',
  'delivery.failed': 'FAILED',
};

async function loadChild(ctx: OrdersContext, session: ClientSession, e: EventEnvelope<DeliveryEventType>): Promise<ChildOrderDoc | null> {
  const { childOrderId, jobId } = e.payload;
  const child = Types.ObjectId.isValid(childOrderId) ? await ctx.models.ChildOrder.findById(childOrderId).session(session) : null;
  if (!child) {
    ctx.logger.warn({ childOrderId, type: e.type, eventId: e.id }, 'delivery event for unknown child order; ignored');
    return null;
  }
  if (child.deliveryJobId && child.deliveryJobId !== jobId) {
    ctx.logger.warn({ childOrderId, jobId, expected: child.deliveryJobId, type: e.type }, 'delivery event for a different job; ignored');
    return null;
  }
  return child;
}

async function publishMirror(ctx: OrdersContext, session: ClientSession, child: ChildOrderDoc): Promise<void> {
  const group = await ctx.models.CheckoutGroup.findById(child.checkoutGroupId).session(session);
  if (group) publishChildUpdate(ctx, session, group, child);
  queueOwnerOrder(ctx, session, child);
}

async function onLifecycle(ctx: OrdersContext, session: ClientSession, e: EventEnvelope<'delivery.picked_up' | 'delivery.started' | 'delivery.delivered' | 'delivery.failed'>) {
  const child = await loadChild(ctx, session, e);
  if (!child) return;
  const path = pathFor(e.type, child.status);
  if (!path.length) {
    ctx.logger.info({ childOrderId: String(child._id), status: child.status, type: e.type, eventId: e.id }, 'stale or inapplicable delivery event; ignored');
    return;
  }
  const p = e.payload as { jobId: string; partnerUserId?: string; at?: string; distanceKm?: number; reason?: string };
  if (!child.deliveryJobId) child.deliveryJobId = p.jobId;
  child.deliveryStatus = MIRROR[e.type] ?? child.deliveryStatus ?? null;
  child.deliveryUpdatedAt = new Date(e.occurredAt);
  if (e.type === 'delivery.delivered' && typeof p.distanceKm === 'number') child.deliveryDistanceKm = p.distanceKm;
  await child.save({ session });

  const at = p.at && !Number.isNaN(Date.parse(p.at)) ? new Date(p.at) : new Date();
  for (const to of path) {
    await transitionChild(ctx, session, String(child._id), to, {
      actor: 'SYSTEM',
      reason: to === 'DELIVERY_FAILED' ? (p.reason ?? 'Delivery failed') : e.type,
      correlationId: e.correlationId,
      extra: {
        deliveryJobId: p.jobId,
        ...(p.partnerUserId ? { partnerUserId: p.partnerUserId } : {}),
        ...(typeof p.distanceKm === 'number' ? { deliveryDistanceKm: p.distanceKm } : {}),
        at,
      },
    });
  }
}

export function deliveryHandlers(ctx: OrdersContext): EventHandlers {
  return {
    'delivery.assigned': async (e, session) => {
      const child = await loadChild(ctx, session, e);
      if (!child) return;
      const occurred = new Date(e.occurredAt);
      const newer = !child.deliveryUpdatedAt || child.deliveryUpdatedAt.getTime() <= occurred.getTime();
      if (!newer && child.partner) return; // stale assignment (a later unassign/progress already applied)
      const p = e.payload;
      child.deliveryJobId = p.jobId;
      child.partner = { partnerId: p.partnerId, partnerUserId: p.partnerUserId, name: p.partnerName, vehicle: { type: p.vehicle.type, registrationNumber: p.vehicle.registrationNumber } };
      if (newer) {
        if (PRE_PICKUP.includes(child.status) || child.status === 'PLACED') child.deliveryStatus = 'ASSIGNED';
        child.deliveryUpdatedAt = occurred;
      }
      await child.save({ session });
      await appendOrderEvents(ctx.conn, session, [
        {
          checkoutGroupId: child.checkoutGroupId,
          childOrderId: child._id,
          type: e.type,
          actor: 'SYSTEM',
          data: { jobId: p.jobId, partnerId: p.partnerId, partnerName: p.partnerName, vehicleType: p.vehicle.type },
          at: occurred,
        },
      ]);
      await publishMirror(ctx, session, child);
    },
    'delivery.unassigned': async (e, session) => {
      const child = await loadChild(ctx, session, e);
      if (!child) return;
      const occurred = new Date(e.occurredAt);
      if (child.deliveryUpdatedAt && child.deliveryUpdatedAt.getTime() > occurred.getTime()) return;
      if (!PRE_PICKUP.includes(child.status)) return; // unassign only happens before pickup
      child.deliveryJobId = child.deliveryJobId ?? e.payload.jobId;
      child.partner = null;
      child.deliveryStatus = 'PENDING_ASSIGNMENT';
      child.deliveryUpdatedAt = occurred;
      await child.save({ session });
      await appendOrderEvents(ctx.conn, session, [
        { checkoutGroupId: child.checkoutGroupId, childOrderId: child._id, type: e.type, actor: 'SYSTEM', data: { jobId: e.payload.jobId, reason: e.payload.reason }, at: occurred },
      ]);
      await publishMirror(ctx, session, child);
    },
    'delivery.picked_up': (e, session) => onLifecycle(ctx, session, e),
    'delivery.started': (e, session) => onLifecycle(ctx, session, e),
    'delivery.delivered': (e, session) => onLifecycle(ctx, session, e),
    'delivery.failed': (e, session) => onLifecycle(ctx, session, e),
  };
}

export const deliveryEventsModule: EventModule = {
  name: 'delivery',
  streams: ['events.delivery'],
  handlers: deliveryHandlers,
};
