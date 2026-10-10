import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope, startConsumer, subscribeRealtime, withTransaction, type ConsumerHandle, type RealtimeSubscription } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import type { EventEnvelope, EventPayloads, EventType } from '@thali/contracts';
import { createEventHandlers, type OrdersLookup } from '../src/events/handlers.js';
import { createHarness, oid, type Harness } from './helpers.js';

let h: Harness;
let consumer: ConsumerHandle;
let rt: RealtimeSubscription;
const realtime: { channel: string; event: string; data: any }[] = [];
const orders = {
  map: new Map<string, string>(),
  async getChildOrder(id: string) {
    const userId = this.map.get(id);
    return userId ? { id, userId } : null;
  },
} satisfies OrdersLookup & { map: Map<string, string> };

const CUSTOMER = oid();
const OWNER = oid();
const handlersFor = () => createEventHandlers({ dispatcher: h.dispatcher, directory: h.directory, orders, logger: console as never, now: () => new Date(h.clock.now) });

beforeAll(async () => {
  h = await createHarness('handlers');
  rt = await subscribeRealtime(h.redis, ['user:*', 'owner:*', 'partner:*', 'admin'], (channel, m) => realtime.push({ channel, event: m.event, data: m.data }));
  consumer = startConsumer({
    conn: h.conn, redis: h.redis, logger: (await import('@thali/service-kit')).createLogger('t', { level: 'silent' }), service: 'notifications',
    streamPrefix: h.config.EVENT_STREAM_PREFIX,
    streams: ['events.orders', 'events.marketplace', 'events.delivery', 'events.payments', 'events.identity'],
    handlers: createEventHandlers({ dispatcher: h.dispatcher, directory: h.directory, orders, logger: console as never }),
    backoffBaseMs: 20, maxBackoffMs: 100, blockMs: 100,
  });
  await consumer.ready;
});
afterAll(async () => {
  await consumer.stop();
  await rt.close();
  await h.close();
});
beforeEach(() => {
  realtime.length = 0;
  h.directory.users.clear();
  h.directory.down = false;
  h.sms.calls = [];
  h.email.calls = [];
  h.directory.add({ id: CUSTOMER, phone: '+919876543210', email: 'asha@example.com' });
  h.directory.add({ id: OWNER, phone: '+919811122233', email: 'owner@example.com', roles: ['CONSUMER', 'RESTAURANT_OWNER'] });
});

async function publish<T extends EventType>(type: T, payload: EventPayloads[T], producer: 'orders' | 'marketplace' | 'delivery' | 'payments' | 'identity' = 'orders') {
  const env = createEnvelope(type, payload, { producer, aggregateId: oid() });
  await xadd(env, producer);
  return env;
}
async function xadd(env: EventEnvelope, producer: string) {
  await h.redis.xadd(`${h.config.EVENT_STREAM_PREFIX}events.${producer}`, '*', 'data', JSON.stringify(env));
}
const where = (userId: string, channel: string) => h.models.Notification.find({ userId, channel }).lean();

describe('order.rejected', () => {
  const payload = (): EventPayloads['order.rejected'] => ({
    childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), reason: 'Out of paneer', refundPaise: 25000,
  });

  it('delivered twice (duplicate stream entries) -> one in-app notification + one SMS, realtime published once', async () => {
    const env = createEnvelope('order.rejected', payload(), { producer: 'orders', aggregateId: oid() });
    await xadd(env, 'orders');
    await xadd(env, 'orders');
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: env.id })) >= 2);
    await new Promise((r) => setTimeout(r, 300)); // let the duplicate be consumed
    await h.dispatcher.dispatchDue();

    const inApp = await where(CUSTOMER, 'IN_APP');
    const sms = await where(CUSTOMER, 'SMS');
    expect(inApp).toHaveLength(1);
    expect(sms).toHaveLength(1);
    expect(await h.models.Notification.countDocuments({ sourceEventId: env.id })).toBe(2); // email pref is off
    expect(inApp[0]!.dedupeKey).toBe(`${env.id}:IN_APP:${CUSTOMER}`);
    expect(sms[0]!.dedupeKey).toBe(`${env.id}:SMS:${CUSTOMER}`);
    expect(inApp[0]).toMatchObject({ template: 'order_rejected', status: 'SENT' });
    expect(sms[0]).toMatchObject({ status: 'SENT', template: 'order_rejected' });

    expect(h.sms.calls).toHaveLength(1);
    expect(h.sms.calls[0]!.to).toBe('+919876543210');
    expect(h.sms.calls[0]!.body).toContain('250.00'); // refund amount
    expect(h.sms.calls[0]!.body.toLowerCase()).toContain('other restaurants');

    await waitFor(() => realtime.some((r) => r.event === 'notification'));
    const notes = realtime.filter((r) => r.channel === `user:${CUSTOMER}` && r.event === 'notification');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ id: String(inApp[0]!._id), title: expect.any(String), body: expect.stringContaining('250.00') });
  });

  it('the handler itself is idempotent when invoked twice with the same envelope (dedupeKey, no inbox)', async () => {
    const handlers = handlersFor();
    const env = createEnvelope('order.rejected', payload(), { producer: 'orders', aggregateId: oid() });
    for (let i = 0; i < 2; i++) await withTransaction(h.conn, (s) => handlers['order.rejected']!(env as never, s));
    expect(await h.models.Notification.countDocuments({ sourceEventId: env.id, channel: 'IN_APP' })).toBe(1);
    expect(await h.models.Notification.countDocuments({ sourceEventId: env.id, channel: 'SMS' })).toBe(1);
  });
});

describe('preferences and recipients', () => {
  it('order.placed: customer gets in-app + transactional SMS even with prefs off; owner gets in-app + SMS; email only if opted in', async () => {
    h.directory.add({ id: CUSTOMER, email: 'asha@example.com', notificationPrefs: { orderEmail: true } as never });
    const env = await publish('order.placed', { childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), restaurantOwnerId: OWNER, code: 'TH-ABCD1234', totalPaise: 45000, acceptBy: new Date().toISOString() });
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: env.id })) === 5);
    const cust = await h.models.Notification.find({ userId: CUSTOMER, sourceEventId: env.id }).lean();
    expect(cust.map((n) => n.channel).sort()).toEqual(['EMAIL', 'IN_APP', 'SMS']);
    expect(cust.every((n) => n.template === 'order_placed_customer')).toBe(true);
    const owner = await h.models.Notification.find({ userId: OWNER, sourceEventId: env.id }).lean();
    expect(owner.map((n) => n.channel).sort()).toEqual(['IN_APP', 'SMS']);
    expect(owner.every((n) => n.template === 'order_placed_restaurant')).toBe(true);
  });

  it('order.accepted respects prefs: SMS only when orderSms=true, email only when orderEmail=true', async () => {
    const payload = (): EventPayloads['order.accepted'] => ({
      childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), prepMinutes: 20,
      pickup: { name: 'R', address: 'A', location: { type: 'Point', coordinates: [77, 12] } },
      drop: { name: 'D', address: 'B', location: { type: 'Point', coordinates: [77, 12] }, phoneMasked: '+91*****3210' },
      pickupCode: '1111', deliveryCode: '2222',
    });
    const a = await publish('order.accepted', payload());
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: a.id })) === 1);
    expect((await h.models.Notification.findOne({ sourceEventId: a.id }).lean())!.channel).toBe('IN_APP');
    // pickup/delivery codes must not appear in any notification record
    expect(JSON.stringify(await h.models.Notification.find({ sourceEventId: a.id }).lean())).not.toMatch(/1111|2222/);

    h.directory.add({ id: CUSTOMER, notificationPrefs: { orderSms: true, orderEmail: true } as never });
    const b = await publish('order.accepted', payload());
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: b.id })) === 3);
  });

  it('user without a phone/email gets only in-app; blocked users get no SMS/email', async () => {
    h.directory.add({ id: CUSTOMER, phone: null, email: null, notificationPrefs: { orderSms: true, orderEmail: true } as never });
    const a = await publish('order.delivered', deliveredPayload());
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: a.id })) === 1);
    h.directory.add({ id: CUSTOMER, status: 'BLOCKED', notificationPrefs: { orderSms: true, orderEmail: true } as never });
    const b = await publish('order.delivered', deliveredPayload());
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: b.id })) === 1);
    expect((await h.models.Notification.findOne({ sourceEventId: b.id }).lean())!.channel).toBe('IN_APP');
  });

  it('unknown user -> event is consumed without notifications; identity outage -> retried then succeeds', async () => {
    const ghost = await publish('order.delivered', { ...deliveredPayload(), userId: oid() });
    await waitFor(async () => (await h.conn.collection('inbox').countDocuments({ _id: ghost.id } as never)) === 1);
    expect(await h.models.Notification.countDocuments({ sourceEventId: ghost.id })).toBe(0);

    h.directory.down = true;
    const e = await publish('order.delivered', deliveredPayload());
    await waitFor(() => h.directory.lookups > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.models.Notification.countDocuments({ sourceEventId: e.id })).toBe(0);
    h.directory.down = false;
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: e.id })) >= 1);
  });
});

const deliveredPayload = (): EventPayloads['order.delivered'] => ({
  childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), restaurantOwnerId: OWNER,
  breakdown: {} as never, commissionBps: 1500, deliveryJobId: oid(), partnerUserId: oid(), deliveryDistanceKm: 3.2,
});

describe('other events', () => {
  it('restaurant.email_verification_requested emails the payload address, never stores or logs verifyUrl', async () => {
    const verifyUrl = 'https://thali.test/api/v1/restaurants/verify-email?token=SECRET_TOKEN_abc123';
    const env = await publish('restaurant.email_verification_requested', { restaurantId: oid(), email: 'Owner@Resto.example', verifyUrl }, 'marketplace');
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: env.id })) === 1);
    const doc = await h.models.Notification.findOne({ sourceEventId: env.id }).lean();
    expect(doc).toMatchObject({ channel: 'EMAIL', template: 'restaurant_email_verification', status: 'QUEUED' });
    expect(doc!.userId ?? null).toBeNull();
    expect(JSON.stringify(doc)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(doc)).not.toContain('Owner@Resto');
    expect(doc!.to).toMatch(/^o\*+@resto\.example$/i);

    await h.dispatcher.dispatchDue();
    const sent = h.email.calls.filter((c) => c.idempotencyKey === doc!.dedupeKey);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('owner@resto.example');
    expect(sent[0]!.text).toContain(verifyUrl);
    expect(sent[0]!.html).toContain('SECRET_TOKEN_abc123');
    expect(h.logs.text).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(await h.models.Notification.findById(doc!._id).lean())).not.toContain('SECRET_TOKEN');
  });

  it('restaurant.status_changed addresses the owner (in-app + email)', async () => {
    h.directory.add({ id: OWNER, email: 'owner@example.com', notificationPrefs: { orderEmail: true } as never });
    const env = await publish('restaurant.status_changed', { restaurantId: oid(), ownerUserId: OWNER, name: 'Dosa Corner', from: 'APPROVAL_PENDING', to: 'APPROVED', location: { type: 'Point', coordinates: [77, 12] } }, 'marketplace');
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: env.id })) === 2);
    const docs = await h.models.Notification.find({ sourceEventId: env.id }).lean();
    expect(docs.every((d) => d.userId === OWNER && d.template === 'restaurant_status_changed')).toBe(true);
  });

  it('refund.succeeded resolves the customer through the orders lookup', async () => {
    const childOrderId = oid();
    orders.map.set(childOrderId, CUSTOMER);
    const env = await publish('refund.succeeded', { refundId: oid(), childOrderId, checkoutGroupId: oid(), amountPaise: 12345, reason: 'RESTAURANT_REJECTED', status: 'SUCCEEDED' }, 'payments');
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: env.id, userId: CUSTOMER })) >= 1);
    const inApp = await h.models.Notification.findOne({ sourceEventId: env.id, channel: 'IN_APP' }).lean();
    expect(inApp!.template).toBe('refund_succeeded');
    expect(inApp!.body).toContain('123.45');
  });

  it('delivery.exception creates an admin in-app notification and pushes it to the admin channel', async () => {
    const env = await publish('delivery.exception', { jobId: oid(), childOrderId: oid(), reason: 'No partner accepted' }, 'delivery');
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: env.id })) === 1);
    const doc = await h.models.Notification.findOne({ sourceEventId: env.id }).lean();
    expect(doc).toMatchObject({ channel: 'IN_APP', audience: 'ADMIN', template: 'delivery_exception_admin' });
    expect(doc!.userId ?? null).toBeNull();
    await h.dispatcher.dispatchDue();
    await waitFor(() => realtime.some((r) => r.channel === 'admin' && r.event === 'notification'));
  });

  it('membership.activated and partner.status_changed notify the user', async () => {
    const m = await publish('membership.activated', { membershipId: oid(), userId: CUSTOMER, planId: oid(), endsAt: new Date().toISOString() }, 'marketplace');
    const p = await publish('partner.status_changed', { partnerId: oid(), userId: CUSTOMER, from: 'APPROVAL_PENDING', to: 'APPROVED' }, 'delivery');
    await waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId: { $in: [m.id, p.id] } })) >= 2);
    expect((await h.models.Notification.findOne({ sourceEventId: m.id }).lean())!.template).toBe('membership_activated');
    expect((await h.models.Notification.findOne({ sourceEventId: p.id }).lean())!.template).toBe('partner_status_changed');
  });
});
