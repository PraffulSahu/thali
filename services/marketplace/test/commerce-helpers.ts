/** Task 9 test helpers: menu/coupon/plan/membership seeding, event publishing, consumer, listening server. */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Types } from 'mongoose';
import type { EventPayloads, EventType, ServiceName } from '@thali/contracts';
import { createEnvelope, startConsumer, streamKey, inboxModel } from '@thali/service-kit';
import { testLogger, waitFor } from '@thali/service-kit/testing';
import { buildEventHandlers, handlerModules } from '../src/events/handlers.js';
import type { Harness } from './helpers.js';

export const oid = () => new Types.ObjectId().toHexString();

export async function seedCategory(h: Harness, restaurantId: string, active = true): Promise<string> {
  const c = await h.models.MenuCategory.create({ restaurantId, name: `Cat ${oid().slice(-4)}`, sortOrder: 0, active });
  return String(c._id);
}

/** Insert a menu item directly. Defaults: ₹150, veg, available, untracked, no customizations. */
export async function seedItem(h: Harness, restaurantId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const categoryId = (fields.categoryId as string | undefined) ?? (await seedCategory(h, restaurantId));
  const doc = await h.models.MenuItem.create({
    restaurantId,
    categoryId,
    name: `Item ${oid().slice(-4)}`,
    pricePaise: 15000,
    isVeg: true,
    available: true,
    trackStock: false,
    stockQty: 0,
    reservedQty: 0,
    customizationGroups: [],
    ...fields,
  });
  return String(doc._id);
}

export async function item(h: Harness, id: string) {
  return h.models.MenuItem.findById(id).lean();
}

export async function seedCoupon(h: Harness, fields: Record<string, unknown> = {}) {
  const now = Date.now();
  const doc = await h.models.Coupon.create({
    code: `C${oid().slice(-8).toUpperCase()}`,
    description: 'test coupon',
    type: 'FLAT',
    valuePaise: 5000,
    minOrderPaise: 0,
    validFrom: new Date(now - 86400000),
    validTo: new Date(now + 86400000),
    totalLimit: 100,
    perUserLimit: 5,
    usedCount: 0,
    heldCount: 0,
    active: true,
    firstOrderOnly: false,
    ...fields,
  });
  return { id: String(doc._id), code: doc.code };
}

export const defaultBenefits = { freeDeliveryMinOrderPaise: 20000, freeDeliveriesPerPeriod: 2, extraDiscountBps: 500, extraDiscountCapPaise: 5000 };

export async function seedPlan(h: Harness, fields: Record<string, unknown> = {}) {
  const doc = await h.models.MembershipPlan.create({
    name: 'Thali Plus',
    pricePaise: 9900,
    durationDays: 30,
    benefits: defaultBenefits,
    terms: 'Free delivery on orders above ₹200, up to 2 per month.',
    active: true,
    ...fields,
  });
  return String(doc._id);
}

export async function seedActiveMembership(h: Harness, userId: string, fields: Record<string, unknown> = {}, benefits = defaultBenefits) {
  const planId = await seedPlan(h, { benefits });
  const now = Date.now();
  const doc = await h.models.Membership.create({
    userId,
    planId,
    planSnapshot: { name: 'Thali Plus', pricePaise: 9900, durationDays: 30, benefits, terms: 't' },
    status: 'ACTIVE',
    startsAt: new Date(now - 86400000),
    endsAt: new Date(now + 29 * 86400000),
    paymentIntentId: oid(),
    freeDeliveriesUsed: 0,
    freeDeliveriesHeld: 0,
    usage: [],
    ...fields,
  });
  return String(doc._id);
}

export async function publishEvent<T extends EventType>(
  h: Harness,
  producer: ServiceName,
  type: T,
  payload: EventPayloads[T],
  opts: { id?: string } = {},
) {
  const env = createEnvelope(type, payload, { producer, aggregateId: 'agg' });
  const envelope = opts.id ? { ...env, id: opts.id } : env;
  await h.tr.redis.xadd(streamKey(h.tr.prefix, `events.${producer}`), '*', 'data', JSON.stringify(envelope));
  return envelope;
}

/** Real stream consumer over the registered handler modules (fast backoff for tests). */
export function startCommerceConsumer(h: Harness) {
  const { handlers, streams } = buildEventHandlers(h.ctx, handlerModules);
  return startConsumer({
    conn: h.db.conn,
    redis: h.tr.redis,
    logger: testLogger('marketplace'),
    service: 'marketplace',
    streamPrefix: h.tr.prefix,
    streams,
    handlers,
    backoffBaseMs: 20,
    maxBackoffMs: 200,
    claimIdleMs: 300,
    blockMs: 100,
  });
}

/** Wait until the consumer has committed the given event ids. */
export async function processed(h: Harness, ...ids: string[]) {
  await waitFor(async () => (await inboxModel(h.db.conn).countDocuments({ _id: { $in: ids } })) === ids.length, { timeoutMs: 10000 });
}

/** A real listening server so concurrent requests are truly concurrent. */
export async function listen(h: Harness): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = h.app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
