/**
 * Shared orders test harness: isolated Mongo DB + Redis prefix per test file, injected test JWKS,
 * fake marketplace / payments / identity clients.
 */
import request from 'supertest';
import { Types } from 'mongoose';
import { createAuthVerifier, createEnvelope, signServiceToken, streamKey, type Redis } from '@thali/service-kit';
import {
  createTestConfig,
  createTestDb,
  createTestRedis,
  generateTestKeys,
  testLogger,
  TEST_INTERNAL_SERVICE_SECRET,
} from '@thali/service-kit/testing';
import type { EventPayloads, EventType, ServiceName } from '@thali/contracts';
import { buildApp } from '../src/app.js';
import { ORDERS_CONFIG_DEFAULTS, type OrdersConfig } from '../src/config.js';
import { createOrdersContext, type AppDeps } from '../src/context.js';
import { initOrdersDb } from '../src/models/index.js';
import { FakeMarketplace } from './fakes/marketplace.js';
import { FakePayments } from './fakes/payments.js';
import { FakeIdentity } from './fakes/identity.js';

export const oid = () => new Types.ObjectId().toHexString();

export const DROP_ADDRESS = {
  label: 'Home',
  line1: '42 Residency Rd',
  city: 'Bengaluru',
  pincode: '560025',
  location: { lat: 12.9716, lng: 77.5946 },
};

export async function setup(name: string, overrides: Partial<OrdersConfig> = {}) {
  const db = await createTestDb(`orders_${name}`);
  const tr = await createTestRedis();
  const keys = await generateTestKeys();
  const config = createTestConfig({
    ...ORDERS_CONFIG_DEFAULTS,
    SERVICE_NAME: 'orders' as const,
    REDIS_KEY_PREFIX: tr.prefix,
    EVENT_STREAM_PREFIX: tr.prefix,
    ...overrides,
  }) as OrdersConfig;
  const marketplace = new FakeMarketplace();
  const payments = new FakePayments();
  const identity = new FakeIdentity();
  const deps: AppDeps = {
    config,
    logger: testLogger('orders'),
    conn: db.conn,
    redis: tr.redis,
    auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }),
    clients: { marketplace, payments, identity },
  };
  await initOrdersDb(db.conn);
  const app = buildApp(deps);
  const ctx = createOrdersContext(deps);

  const userToken = (userId: string) => keys.sign({ sub: userId, roles: ['CONSUMER'] });
  const internalToken = (from: ServiceName) => signServiceToken(from, 'orders', TEST_INTERNAL_SERVICE_SECRET);

  return {
    db,
    tr,
    keys,
    config,
    deps,
    app,
    ctx,
    marketplace,
    payments,
    identity,
    userToken,
    internalToken,
    async cleanup() {
      await tr.cleanup();
      await db.drop();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

/** Authenticated user agent helpers. */
export async function asUser(h: Harness, userId = oid()) {
  const token = await h.userToken(userId);
  const auth = { authorization: `Bearer ${token}` };
  return {
    userId,
    token,
    get: (path: string) => request(h.app).get(path).set(auth),
    post: (path: string, body?: object) => request(h.app).post(path).set(auth).send(body ?? {}),
    put: (path: string, body?: object) => request(h.app).put(path).set(auth).send(body ?? {}),
    patch: (path: string, body?: object) => request(h.app).patch(path).set(auth).send(body ?? {}),
    del: (path: string) => request(h.app).delete(path).set(auth),
  };
}

/** Event envelopes in the outbox (optionally filtered by type), oldest first. */
export async function outboxEvents<T extends EventType>(h: Harness, type?: T) {
  const rows = await h.db.conn
    .collection('outbox')
    .find(type ? { 'envelope.type': type } : {})
    .sort({ createdAt: 1 })
    .toArray();
  return rows.map((r) => r.envelope as { id: string; type: T; aggregateId: string; payload: EventPayloads[T] });
}

/** XADD an event onto `<prefix>events.<producer>` exactly like the relay does. */
export async function publishEvent<T extends EventType>(
  redis: Redis,
  prefix: string,
  producer: ServiceName,
  type: T,
  payload: EventPayloads[T],
  opts: { id?: string; aggregateId?: string } = {},
) {
  const env = createEnvelope(type, payload, { producer, aggregateId: opts.aggregateId ?? 'agg' });
  const envelope = opts.id ? { ...env, id: opts.id } : env;
  await redis.xadd(streamKey(prefix, `events.${producer}`), '*', 'data', JSON.stringify(envelope));
  return envelope;
}

/** Fill a user's cart with 1 paneer (Large + Cheese) from A and 2 dosas from B. */
export async function fillTwoRestaurantCart(h: Harness, u: Awaited<ReturnType<typeof asUser>>) {
  const s = h.marketplace.seedTwo();
  const r1 = await u.post('/api/v1/cart/items', {
    restaurantId: s.a.id,
    itemId: s.paneer.id,
    quantity: 1,
    selections: [
      { groupId: s.size.id, optionIds: [s.size.options[1]!.id] },
      { groupId: s.extras.id, optionIds: [s.extras.options[0]!.id] },
    ],
  });
  if (r1.status !== 201) throw new Error(`add paneer failed ${r1.status} ${r1.text}`);
  const r2 = await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 2 });
  if (r2.status !== 201) throw new Error(`add dosa failed ${r2.status} ${r2.text}`);
  return s;
}

let keyCounter = 0;
export const idemKey = () => `test-key-${Date.now()}-${++keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
