import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope, createLogger, startConsumer, subscribeRealtime, withTransaction, type ConsumerHandle, type RealtimeSubscription } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import type { EventEnvelope, EventPayloads, EventType } from '@thali/contracts';
import { createEventHandlers } from '../src/events/handlers.js';
import { createHarness, oid, type Harness } from './helpers.js';

let h: Harness;
let consumer: ConsumerHandle;
let rt: RealtimeSubscription;
const realtime: { channel: string; event: string; data: any }[] = [];

const CUSTOMER = oid();
const OWNER = oid();
const silent = createLogger('t', { level: 'silent' });
const handlersFor = () => createEventHandlers({ dispatcher: h.dispatcher, logger: silent });

beforeAll(async () => {
  h = await createHarness('handlers');
  rt = await subscribeRealtime(h.redis, ['user:*', 'owner:*', 'partner:*', 'admin'], (channel, m) => realtime.push({ channel, event: m.event, data: m.data }));
  consumer = startConsumer({
    conn: h.conn, redis: h.redis, logger: silent, service: 'notifications',
    streamPrefix: h.config.EVENT_STREAM_PREFIX,
    streams: ['events.orders', 'events.marketplace', 'events.delivery', 'events.payments', 'events.identity'],
    handlers: handlersFor(),
    backoffBaseMs: 20, maxBackoffMs: 100, blockMs: 100,
  });
  await consumer.ready;
});
afterAll(async () => {
  await consumer.stop();
  await rt.close();
  await h.close();
});
beforeEach(async () => {
  await h.models.Notification.deleteMany({}); // dispatchDue() is global: every test starts from an empty queue
  realtime.length = 0;
  h.directory.users.clear();
  h.directory.down = false;
  h.directory.lookups = 0;
  h.orders.down = false;
  h.orders.lookups = 0;
  h.orders.map.clear();
  h.sms.calls = [];
  h.email.calls = [];
  h.directory.add({ id: CUSTOMER, phone: '+919876543210', email: 'asha@example.com' });
  h.directory.add({ id: OWNER, phone: '+919811122233', email: 'owner@example.com', roles: ['CONSUMER', 'RESTAURANT_OWNER'] });
});

const stream = (producer: string) => `${h.config.EVENT_STREAM_PREFIX}events.${producer}`;
async function xadd(env: EventEnvelope, producer: string) {
  await h.redis.xadd(stream(producer), '*', 'data', JSON.stringify(env));
}
async function publish<T extends EventType>(type: T, payload: EventPayloads[T], producer: 'orders' | 'marketplace' | 'delivery' | 'payments' | 'identity' = 'orders') {
  const env = createEnvelope(type, payload, { producer, aggregateId: oid() });
  await xadd(env, producer);
  return env;
}
/** The consumer group has read AND acknowledged everything on the stream (no sleeping). */
async function drained(producer: string) {
  const groups = (await h.redis.xinfo('GROUPS', stream(producer))) as unknown[][];
  const g = Object.fromEntries(Array.from({ length: groups[0]!.length / 2 }, (_, i) => [groups[0]![i * 2] as string, groups[0]![i * 2 + 1]]));
  return g.lag === 0 && g.pending === 0;
}
const rowsOf = (sourceEventId: string) => h.models.Notification.find({ sourceEventId }).sort({ _id: 1 }).lean();
const waitRows = (sourceEventId: string, n: number) => waitFor(async () => (await h.models.Notification.countDocuments({ sourceEventId })) === n, { message: `${n} rows for ${sourceEventId}` });
const statusByChannel = async (sourceEventId: string, userId?: string) =>
  Object.fromEntries((await h.models.Notification.find({ sourceEventId, ...(userId ? { userId } : {}) }).lean()).map((n) => [n.channel, n.status]));
const advance = (sec: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + sec * 1000);
};

const deliveredPayload = (): EventPayloads['order.delivered'] => ({
  childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), restaurantOwnerId: OWNER,
  breakdown: {} as never, commissionBps: 1500, deliveryJobId: oid(), partnerUserId: oid(), deliveryDistanceKm: 3.2,
});

describe('order.rejected', () => {
  const payload = (): EventPayloads['order.rejected'] => ({
    childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), reason: 'Out of paneer', refundPaise: 25000,
  });

  it('delivered twice (duplicate stream entries) -> one in-app + one SMS, email skipped (opted out), realtime once', async () => {
    const env = createEnvelope('order.rejected', payload(), { producer: 'orders', aggregateId: oid() });
    await xadd(env, 'orders');
    await xadd(env, 'orders');
    await waitRows(env.id, 3);
    await waitFor(() => drained('orders'), { message: 'consumer drained the stream incl. the duplicate' });
    expect(h.directory.lookups).toBe(0); // the handler never calls identity
    await h.dispatcher.dispatchDue();

    const rows = await rowsOf(env.id);
    expect(rows).toHaveLength(3);
    const inApp = rows.filter((n) => n.channel === 'IN_APP');
    const sms = rows.filter((n) => n.channel === 'SMS');
    const mail = rows.filter((n) => n.channel === 'EMAIL');
    expect([inApp.length, sms.length, mail.length]).toEqual([1, 1, 1]);
    expect(inApp[0]!.dedupeKey).toBe(`${env.id}:order_rejected:IN_APP:${CUSTOMER}`);
    expect(sms[0]!.dedupeKey).toBe(`${env.id}:order_rejected:SMS:${CUSTOMER}`);
    expect(inApp[0]).toMatchObject({ template: 'order_rejected', status: 'SENT', userId: CUSTOMER });
    expect(sms[0]).toMatchObject({ status: 'SENT', template: 'order_rejected' }); // transactional SMS: always allowed
    expect(mail[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'OPTED_OUT' });

    expect(h.sms.calls).toHaveLength(1);
    expect(h.sms.calls[0]!.to).toBe('+919876543210');
    expect(h.sms.calls[0]!.body).toContain('250.00');
    expect(h.sms.calls[0]!.body.toLowerCase()).toContain('other restaurants');
    expect(h.email.calls).toHaveLength(0);

    await waitFor(() => realtime.some((r) => r.event === 'notification'));
    const notes = realtime.filter((r) => r.channel === `user:${CUSTOMER}` && r.event === 'notification');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ id: String(inApp[0]!._id), title: expect.any(String), body: expect.stringContaining('250.00') });
    // the recipient was resolved at dispatch time and stored masked + encrypted
    expect((await h.models.Notification.findById(sms[0]!._id).lean())!).toMatchObject({ to: '+91******3210', toEnc: expect.stringMatching(/^v1:/) });
  });

  it('the handler itself is idempotent when invoked twice with the same envelope (dedupeKey, no inbox)', async () => {
    const handlers = handlersFor();
    const env = createEnvelope('order.rejected', payload(), { producer: 'orders', aggregateId: oid() });
    for (let i = 0; i < 2; i++) await withTransaction(h.conn, (s) => handlers['order.rejected']!(env as never, s));
    expect(await h.models.Notification.countDocuments({ sourceEventId: env.id, channel: 'IN_APP' })).toBe(1);
    expect(await h.models.Notification.countDocuments({ sourceEventId: env.id, channel: 'SMS' })).toBe(1);
    expect(await h.models.Notification.countDocuments({ sourceEventId: env.id })).toBe(3);
  });
});

describe('identity outages never block or dead-letter events', () => {
  it('identity down while the handler runs -> notifications are still enqueued; SMS retries with backoff and is delivered after recovery', async () => {
    h.directory.down = true;
    const env = await publish('order.rejected', { childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), reason: 'x', refundPaise: 100 });
    await waitRows(env.id, 3);
    await waitFor(() => drained('orders'));
    expect(await h.conn.collection('dead_letters').countDocuments()).toBe(0);

    await h.dispatcher.dispatchDue();
    let st = await statusByChannel(env.id);
    expect(st).toMatchObject({ IN_APP: 'SENT', SMS: 'FAILED', EMAIL: 'FAILED' }); // in-app needs no identity
    const sms = (await h.models.Notification.findOne({ sourceEventId: env.id, channel: 'SMS' }).lean())!;
    expect(sms.attempts).toBe(1);
    expect(sms.nextAttemptAt!.getTime() - h.clock.now.getTime()).toBe(30_000);
    expect(sms.lastError).toContain('identity unavailable');
    expect(h.sms.calls).toHaveLength(0);

    h.directory.down = false;
    advance(30);
    await h.dispatcher.dispatchDue();
    st = await statusByChannel(env.id);
    expect(st).toMatchObject({ IN_APP: 'SENT', SMS: 'SENT', EMAIL: 'SKIPPED' });
    expect(h.sms.calls).toHaveLength(1);
  });

  it('identity down for good -> the notification is DEAD after the attempts, the event is never dead-lettered', async () => {
    h.directory.down = true;
    const env = await publish('order.rejected', { childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), reason: 'x', refundPaise: 100 });
    await waitRows(env.id, 3);
    for (let i = 0; i < h.config.NOTIF_MAX_ATTEMPTS; i++) {
      await h.dispatcher.dispatchDue();
      advance(1000);
    }
    expect(await statusByChannel(env.id)).toMatchObject({ SMS: 'DEAD', EMAIL: 'DEAD' });
    expect(await h.conn.collection('dead_letters').countDocuments()).toBe(0);
  });

  it('handler invoked directly with identity AND orders down still enqueues (no network calls at all)', async () => {
    h.directory.down = true;
    h.orders.down = true;
    const handlers = handlersFor();
    const rej = createEnvelope('order.rejected', { childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), reason: 'x', refundPaise: 1 }, { producer: 'orders', aggregateId: oid() });
    const refund = createEnvelope('refund.succeeded', { refundId: oid(), childOrderId: oid(), checkoutGroupId: oid(), amountPaise: 5, reason: 'ADMIN', status: 'SUCCEEDED' }, { producer: 'payments', aggregateId: oid() });
    await withTransaction(h.conn, (s) => handlers['order.rejected']!(rej as never, s));
    await withTransaction(h.conn, (s) => handlers['refund.succeeded']!(refund as never, s));
    expect(await h.models.Notification.countDocuments({ sourceEventId: { $in: [rej.id, refund.id] } })).toBe(6);
    expect(h.directory.lookups + h.orders.lookups).toBe(0);
  });
});

describe('preferences are applied at dispatch time', () => {
  it('order.placed: customer in-app + transactional SMS even with prefs off, email only if opted in; owner in-app + SMS', async () => {
    h.directory.add({ id: CUSTOMER, email: 'asha@example.com', notificationPrefs: { orderEmail: true } as never });
    const env = await publish('order.placed', { childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), restaurantOwnerId: OWNER, code: 'TH-ABCD1234', totalPaise: 45000, acceptBy: new Date().toISOString() });
    await waitRows(env.id, 6);
    await h.dispatcher.dispatchDue();
    expect(await statusByChannel(env.id, CUSTOMER)).toEqual({ IN_APP: 'SENT', SMS: 'SENT', EMAIL: 'SENT' });
    expect(await statusByChannel(env.id, OWNER)).toEqual({ IN_APP: 'SENT', SMS: 'SENT', EMAIL: 'SKIPPED' });
    const templates = (await h.models.Notification.find({ sourceEventId: env.id }).lean()).map((n) => `${n.userId === CUSTOMER ? 'c' : 'o'}:${n.template}`);
    expect(new Set(templates)).toEqual(new Set(['c:order_placed_customer', 'o:order_placed_restaurant']));
  });

  it('customer order notifications carry checkoutId + childOrderId (web inbox deep links); codes stay out', async () => {
    const checkoutId = oid();
    const childOrderId = oid();
    const placed = await publish('order.placed', { childOrderId, checkoutId, userId: CUSTOMER, restaurantId: oid(), restaurantOwnerId: OWNER, code: 'TH-LINK0001', totalPaise: 100, acceptBy: new Date().toISOString() });
    await waitRows(placed.id, 6);
    const customer = await h.models.Notification.findOne({ sourceEventId: placed.id, userId: CUSTOMER, channel: 'IN_APP' }).lean();
    expect(customer!.data).toMatchObject({ checkoutId, childOrderId, code: 'TH-LINK0001' });
    const owner = await h.models.Notification.findOne({ sourceEventId: placed.id, userId: OWNER, channel: 'IN_APP' }).lean();
    expect(owner!.data).toMatchObject({ childOrderId });
    expect(owner!.data.checkoutId).toBeUndefined(); // the owner never opens the customer's checkout

    const refund = await publish('refund.succeeded', { refundId: oid(), childOrderId, checkoutGroupId: checkoutId, amountPaise: 5, reason: 'RESTAURANT_REJECTED', status: 'SUCCEEDED' }, 'payments');
    await waitRows(refund.id, 3);
    const r = await h.models.Notification.findOne({ sourceEventId: refund.id, channel: 'IN_APP' }).lean();
    expect(r!.data).toMatchObject({ checkoutId, childOrderId });

    const accepted = await publish('order.accepted', {
      childOrderId, checkoutId, userId: CUSTOMER, restaurantId: oid(), prepMinutes: 15,
      pickup: { name: 'R', address: 'a', location: { type: 'Point', coordinates: [77.6, 12.9] } },
      drop: { name: 'C', address: 'b', location: { type: 'Point', coordinates: [77.61, 12.91] }, phoneMasked: '' },
      pickupCode: '1111', deliveryCode: '2222',
    } as EventPayloads['order.accepted']);
    await waitFor(async () => !!(await h.models.Notification.exists({ sourceEventId: accepted.id, channel: 'IN_APP' })));
    const a = await h.models.Notification.findOne({ sourceEventId: accepted.id, channel: 'IN_APP' }).lean();
    expect(a!.data).toEqual({ prepMinutes: 15, checkoutId, childOrderId });
  });

  it('a user who is both the customer and the restaurant owner gets BOTH notifications (dedupeKey includes the template)', async () => {
    const env = await publish('order.placed', { childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), restaurantOwnerId: CUSTOMER, code: 'TH-SELF0001', totalPaise: 100, acceptBy: new Date().toISOString() });
    await waitRows(env.id, 6);
    const inApp = await h.models.Notification.find({ sourceEventId: env.id, channel: 'IN_APP' }).lean();
    expect(inApp.map((n) => n.template).sort()).toEqual(['order_placed_customer', 'order_placed_restaurant']);
    expect(new Set(inApp.map((n) => n.dedupeKey)).size).toBe(2);
  });

  it('order.accepted: SMS only when orderSms=true, email only when orderEmail=true; codes are never stored', async () => {
    const payload = (): EventPayloads['order.accepted'] => ({
      childOrderId: oid(), checkoutId: oid(), userId: CUSTOMER, restaurantId: oid(), prepMinutes: 20,
      pickup: { name: 'R', address: 'A', location: { type: 'Point', coordinates: [77, 12] } },
      drop: { name: 'D', address: 'B', location: { type: 'Point', coordinates: [77, 12] }, phoneMasked: '+91*****3210' },
      pickupCode: '1111', deliveryCode: '2222',
    });
    const a = await publish('order.accepted', payload());
    await waitRows(a.id, 3);
    await h.dispatcher.dispatchDue();
    expect(await statusByChannel(a.id)).toEqual({ IN_APP: 'SENT', SMS: 'SKIPPED', EMAIL: 'SKIPPED' });
    expect(JSON.stringify(await h.models.Notification.find({ sourceEventId: a.id }).lean())).not.toMatch(/1111|2222/);

    h.directory.add({ id: CUSTOMER, notificationPrefs: { orderSms: true, orderEmail: true } as never });
    const b = await publish('order.accepted', payload());
    await waitRows(b.id, 3);
    await h.dispatcher.dispatchDue();
    expect(await statusByChannel(b.id)).toEqual({ IN_APP: 'SENT', SMS: 'SENT', EMAIL: 'SENT' });
  });

  it('no phone/email -> NO_PHONE / NO_EMAIL; blocked -> USER_BLOCKED (in-app still delivered)', async () => {
    h.directory.add({ id: CUSTOMER, phone: null, email: null, notificationPrefs: { orderSms: true, orderEmail: true } as never });
    const a = await publish('order.delivered', deliveredPayload());
    await waitRows(a.id, 3);
    await h.dispatcher.dispatchDue();
    const rows = await h.models.Notification.find({ sourceEventId: a.id }).lean();
    expect(Object.fromEntries(rows.map((n) => [n.channel, n.skipReason ?? n.status]))).toEqual({ IN_APP: 'SENT', SMS: 'NO_PHONE', EMAIL: 'NO_EMAIL' });

    h.directory.add({ id: CUSTOMER, status: 'BLOCKED', notificationPrefs: { orderSms: true, orderEmail: true } as never });
    const b = await publish('order.delivered', deliveredPayload());
    await waitRows(b.id, 3);
    await h.dispatcher.dispatchDue();
    const rowsB = await h.models.Notification.find({ sourceEventId: b.id }).lean();
    expect(Object.fromEntries(rowsB.map((n) => [n.channel, n.skipReason ?? n.status]))).toEqual({ IN_APP: 'SENT', SMS: 'USER_BLOCKED', EMAIL: 'USER_BLOCKED' });
  });

  it('unknown user (identity 404): SMS/email SKIPPED RECIPIENT_NOT_FOUND, not retried', async () => {
    const ghost = await publish('order.delivered', { ...deliveredPayload(), userId: oid() });
    await waitRows(ghost.id, 3);
    await h.dispatcher.dispatchDue();
    const rows = await h.models.Notification.find({ sourceEventId: ghost.id }).lean();
    expect(rows.filter((n) => n.channel !== 'IN_APP').every((n) => n.status === 'SKIPPED' && n.skipReason === 'RECIPIENT_NOT_FOUND')).toBe(true);
    expect(h.sms.calls).toHaveLength(0);
  });
});

describe('other events', () => {
  it('restaurant.email_verification_requested emails the payload address, never stores or logs verifyUrl', async () => {
    const verifyUrl = 'https://thali.test/api/v1/restaurants/verify-email?token=SECRET_TOKEN_abc123';
    const env = await publish('restaurant.email_verification_requested', { restaurantId: oid(), email: 'Owner@Resto.example', verifyUrl }, 'marketplace');
    await waitRows(env.id, 1);
    const doc = await h.models.Notification.findOne({ sourceEventId: env.id }).lean();
    expect(doc).toMatchObject({ channel: 'EMAIL', template: 'restaurant_email_verification', status: 'QUEUED' });
    expect(doc!.dedupeKey).toMatch(new RegExp(`^${env.id}:restaurant_email_verification:EMAIL:h:`));
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
    expect(h.directory.lookups).toBe(0); // payload-provided recipient: no identity lookup
    expect(h.logs.text).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(await h.models.Notification.findById(doc!._id).lean())).not.toContain('SECRET_TOKEN');
  });

  it('restaurant.status_changed addresses the owner (in-app + email, email is transactional)', async () => {
    const env = await publish('restaurant.status_changed', { restaurantId: oid(), ownerUserId: OWNER, name: 'Dosa Corner', from: 'APPROVAL_PENDING', to: 'APPROVED', location: { type: 'Point', coordinates: [77, 12] } }, 'marketplace');
    await waitRows(env.id, 2);
    await h.dispatcher.dispatchDue();
    const docs = await h.models.Notification.find({ sourceEventId: env.id }).lean();
    expect(docs.every((d) => d.userId === OWNER && d.template === 'restaurant_status_changed')).toBe(true);
    expect(docs.map((d) => d.status)).toEqual(['SENT', 'SENT']);
  });

  it('refund.succeeded: the user is resolved from the child order at dispatch time', async () => {
    const childOrderId = oid();
    h.orders.map.set(childOrderId, CUSTOMER);
    const env = await publish('refund.succeeded', { refundId: oid(), childOrderId, checkoutGroupId: oid(), amountPaise: 12345, reason: 'RESTAURANT_REJECTED', status: 'SUCCEEDED' }, 'payments');
    await waitRows(env.id, 3);
    expect(h.orders.lookups).toBe(0);
    const before = await h.models.Notification.findOne({ sourceEventId: env.id, channel: 'IN_APP' }).lean();
    expect(before!.userId ?? null).toBeNull();
    expect(before!.recipientChildOrderId).toBe(childOrderId);
    await h.dispatcher.dispatchDue();
    const inApp = await h.models.Notification.findOne({ sourceEventId: env.id, channel: 'IN_APP' }).lean();
    expect(inApp).toMatchObject({ template: 'refund_succeeded', userId: CUSTOMER, status: 'SENT' });
    expect(inApp!.body).toContain('123.45');
    expect(await statusByChannel(env.id)).toMatchObject({ SMS: 'SKIPPED', EMAIL: 'SKIPPED' }); // opted out
  });

  it('refund.succeeded: orders unavailable -> retried; unknown order -> SKIPPED; refund without child order -> nothing', async () => {
    const childOrderId = oid();
    h.orders.map.set(childOrderId, CUSTOMER);
    h.orders.down = true;
    const env = await publish('refund.succeeded', { refundId: oid(), childOrderId, checkoutGroupId: oid(), amountPaise: 5, reason: 'ADMIN', status: 'SUCCEEDED' }, 'payments');
    await waitRows(env.id, 3);
    await h.dispatcher.dispatchDue();
    expect(await statusByChannel(env.id)).toEqual({ IN_APP: 'FAILED', SMS: 'FAILED', EMAIL: 'FAILED' });
    h.orders.down = false;
  h.orders.lookups = 0;
    advance(30);
    await h.dispatcher.dispatchDue();
    expect((await statusByChannel(env.id)).IN_APP).toBe('SENT');

    const unknown = await publish('refund.succeeded', { refundId: oid(), childOrderId: oid(), checkoutGroupId: oid(), amountPaise: 5, reason: 'ADMIN', status: 'SUCCEEDED' }, 'payments');
    await waitRows(unknown.id, 3);
    await h.dispatcher.dispatchDue();
    expect(Object.values(await statusByChannel(unknown.id))).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);

    const none = await publish('refund.succeeded', { refundId: oid(), checkoutGroupId: oid(), amountPaise: 5, reason: 'LATE_PAYMENT', status: 'SUCCEEDED' }, 'payments');
    await waitFor(() => drained('payments'));
    expect(await h.models.Notification.countDocuments({ sourceEventId: none.id })).toBe(0);
  });

  it('delivery.exception creates an admin in-app notification and pushes it to the admin channel', async () => {
    const env = await publish('delivery.exception', { jobId: oid(), childOrderId: oid(), reason: 'No partner accepted' }, 'delivery');
    await waitRows(env.id, 1);
    const doc = await h.models.Notification.findOne({ sourceEventId: env.id }).lean();
    expect(doc).toMatchObject({ channel: 'IN_APP', audience: 'ADMIN', template: 'delivery_exception_admin' });
    expect(doc!.userId ?? null).toBeNull();
    await h.dispatcher.dispatchDue();
    await waitFor(() => realtime.some((r) => r.channel === 'admin' && r.event === 'notification'));
  });

  it('membership.activated and partner.status_changed notify the user', async () => {
    const m = await publish('membership.activated', { membershipId: oid(), userId: CUSTOMER, planId: oid(), endsAt: new Date().toISOString() }, 'marketplace');
    const p = await publish('partner.status_changed', { partnerId: oid(), userId: CUSTOMER, from: 'APPROVAL_PENDING', to: 'APPROVED' }, 'delivery');
    await waitRows(m.id, 2);
    await waitRows(p.id, 2);
    expect((await h.models.Notification.findOne({ sourceEventId: m.id }).lean())!.template).toBe('membership_activated');
    expect((await h.models.Notification.findOne({ sourceEventId: p.id }).lean())!.template).toBe('partner_status_changed');
  });
});
