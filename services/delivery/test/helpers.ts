/**
 * Shared integration-test harness for the delivery service: real Mongo replica set + Redis
 * (unique DB / key prefix per call), test JWKS, controllable clock, faked identity + storage.
 */
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { createAuthVerifier, createDemoGeo, createEnvelope, initEventCollections, outboxModel, withTransaction } from '@thali/service-kit';
import { createTestDb, createTestRedis, generateTestKeys, testLogger, TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';
import { toGeoJsonPoint, type EventEnvelope, type EventPayloads, type EventType, type Role } from '@thali/contracts';
import { buildApp } from '../src/app.js';
import { parseDeliveryConfig, type DeliveryConfig } from '../src/config.js';
import { createContext, type DeliveryContext, type IdentityClient, type IdentityUser, type MarketplaceClient, type MarketplaceRestaurant, type OrdersChild, type OrdersClient } from '../src/context.js';
import { createEventHandlers } from '../src/events/handlers.js';
import { initDeliveryModels } from '../src/models/index.js';
import { offsetKm, type LatLng } from '../src/domain/geo.js';
import type { StorageProvider } from '@thali/service-kit';

export const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };
export const at = (north: number, east: number, from: LatLng = ORIGIN) => offsetKm(from, north, east);
export const oid = () => new Types.ObjectId().toHexString();

export function makeClock(start = Date.now()) {
  let t = start;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

export function fakeIdentity() {
  const users = new Map<string, IdentityUser>();
  const grants: { userId: string; role: string }[] = [];
  const client: IdentityClient = {
    async getUser(id) {
      return users.get(id) ?? null;
    },
    async grantRole(id, role) {
      grants.push({ userId: id, role });
      const u = users.get(id);
      if (u && !u.roles.includes(role)) u.roles.push(role);
      return { userId: id, roles: u?.roles ?? ['CONSUMER', role] };
    },
  };
  return {
    client,
    grants,
    addUser(u: Partial<IdentityUser> & { id: string }) {
      users.set(u.id, {
        phone: '+919876543210',
        email: null,
        name: 'Ravi Kumar',
        roles: ['CONSUMER'],
        status: 'ACTIVE',
        notificationPrefs: { orderSms: true, orderEmail: true, marketingSms: false, marketingEmail: false },
        ...u,
      });
    },
  };
}

/** Fake marketplace: restaurants by id; `fail` makes every call throw (upstream down). */
export function fakeMarketplace() {
  const restaurants = new Map<string, MarketplaceRestaurant>();
  const state = { calls: 0, fail: null as Error | null };
  const client: MarketplaceClient = {
    async getRestaurant(id) {
      state.calls++;
      if (state.fail) throw state.fail;
      return restaurants.get(id) ?? null;
    },
  };
  return { client, restaurants, state };
}

/** Fake orders: child orders by id; `fail` makes every call throw (orders unavailable). */
export function fakeOrders() {
  const children = new Map<string, OrdersChild>();
  const state = { calls: 0, fail: null as Error | null };
  const client: OrdersClient = {
    async getChild(id) {
      state.calls++;
      if (state.fail) throw state.fail;
      return children.get(id) ?? null;
    },
  };
  return { client, children, state };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f10000000049454e44ae426082', 'hex');

export function fakeStorage() {
  const objects = new Map<string, { contentType: string; size: number }>();
  const calls: { presignPut: unknown[]; presignGet: unknown[] } = { presignPut: [], presignGet: [] };
  const storage: StorageProvider = {
    async presignPut(input) {
      calls.presignPut.push(input);
      return { url: `http://storage.test/${input.bucket}/${input.key}`, method: 'PUT', headers: { 'content-type': input.contentType }, expiresAt: new Date(Date.now() + 300_000).toISOString(), maxBytes: input.maxBytes } as never;
    },
    async presignGet(input) {
      calls.presignGet.push(input);
      return { url: `http://storage.test/${input.bucket}/${input.key}?sig=1`, expiresAt: new Date(Date.now() + 300_000).toISOString() } as never;
    },
    async head(_bucket, key) {
      return objects.get(key) ?? null;
    },
    async readHead() {
      return PNG;
    },
    publicUrl(key) {
      return `http://storage.test/public/${key}`;
    },
    async delete(_bucket, key) {
      objects.delete(key);
    },
  } as StorageProvider;
  return {
    storage,
    calls,
    /** Simulate the browser PUT of a small PNG. */
    put(key: string) {
      objects.set(key, { contentType: 'image/png', size: PNG.length });
    },
  };
}

export interface Harness {
  ctx: DeliveryContext;
  app: Express;
  config: DeliveryConfig;
  clock: ReturnType<typeof makeClock>;
  identity: ReturnType<typeof fakeIdentity>;
  marketplace: ReturnType<typeof fakeMarketplace>;
  orders: ReturnType<typeof fakeOrders>;
  storage: ReturnType<typeof fakeStorage>;
  token(userId: string, roles?: Role[]): Promise<string>;
  adminToken(opts?: { mfa?: boolean; adminRoles?: string[] }): Promise<string>;
  cleanup(): Promise<void>;
}

export async function setup(name: string, env: Record<string, string> = {}): Promise<Harness> {
  const db = await createTestDb(`delivery_${name}`);
  const tr = await createTestRedis();
  const keys = await generateTestKeys();
  const clock = makeClock();
  const identity = fakeIdentity();
  const marketplace = fakeMarketplace();
  const orders = fakeOrders();
  const storage = fakeStorage();
  const config = parseDeliveryConfig({
    SERVICE_NAME: 'delivery',
    APP_MODE: 'demo',
    MONGO_URI: db.uri,
    REDIS_URL: 'redis://localhost:6379',
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    LOG_LEVEL: 'silent',
    REDIS_KEY_PREFIX: tr.prefix,
    EVENT_STREAM_PREFIX: tr.prefix,
    ...env,
  });
  await initEventCollections(db.conn);
  await initDeliveryModels(db.conn);
  const ctx = createContext({
    config,
    logger: testLogger('delivery'),
    conn: db.conn,
    redis: tr.redis,
    geo: createDemoGeo({}),
    storage: storage.storage,
    identity: identity.client,
    marketplace: marketplace.client,
    orders: orders.client,
    clock: clock.now,
  });
  const app = buildApp({ ...ctx, auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }) });
  return {
    ctx,
    app,
    config,
    clock,
    identity,
    marketplace,
    orders,
    storage,
    token: (userId, roles = ['CONSUMER']) => keys.sign({ sub: userId, roles }),
    adminToken: (opts = {}) =>
      keys.sign({
        sub: oid(),
        roles: ['CONSUMER', 'ADMIN'],
        amr: opts.mfa === false ? ['pwd'] : ['pwd', 'mfa'],
        adm: opts.adminRoles ?? ['OPS'],
      } as never),
    async cleanup() {
      await ctx.simulator.stopAll();
      await tr.cleanup();
      await db.drop();
    },
  };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Insert a partner directly (bypasses onboarding). */
export async function createPartner(
  h: Harness,
  opts: {
    userId?: string;
    status?: string;
    online?: boolean;
    location?: LatLng;
    lastLocationAt?: Date;
    maxActive?: number;
    name?: string;
  } = {},
) {
  const { Partner } = h.ctx.models;
  const loc = opts.location ?? ORIGIN;
  const [p] = await Partner.create([
    {
      userId: opts.userId ?? oid(),
      name: opts.name ?? 'Suresh Rao',
      phone: '+919800000001',
      vehicle: { type: 'BIKE', registrationNumber: 'KA01AB1234' },
      status: opts.status ?? 'APPROVED',
      online: opts.online ?? true,
      lastLocation: toGeoJsonPoint(loc),
      lastLocationAt: opts.lastLocationAt ?? h.clock.now(),
      activeJobIds: [],
      maxActive: opts.maxActive ?? h.config.MAX_ACTIVE_DELIVERIES,
      documents: [],
      isDemo: false,
    },
  ]);
  return p!;
}

export function acceptedPayload(overrides: Partial<EventPayloads['order.accepted']> & { pickupAt?: LatLng; dropAt?: LatLng } = {}): EventPayloads['order.accepted'] {
  const { pickupAt, dropAt, ...rest } = overrides;
  return {
    childOrderId: oid(),
    checkoutId: oid(),
    userId: oid(),
    restaurantId: oid(),
    prepMinutes: 15,
    pickup: { name: 'Meghana Foods', address: '12 Residency Rd, Bengaluru', location: toGeoJsonPoint(pickupAt ?? ORIGIN) },
    drop: { name: 'Asha', address: '44 MG Rd, Bengaluru', location: toGeoJsonPoint(dropAt ?? at(0, 3)), phoneMasked: '+91•••••43210' },
    pickupCode: '1234',
    deliveryCode: '5678',
    ...rest,
  };
}

export function envelope<T extends EventType>(type: T, payload: EventPayloads[T], aggregateId: string): EventEnvelope<T> {
  return createEnvelope(type, payload, { producer: 'orders', aggregateId, correlationId: randomUUID() });
}

/** Run an event handler the way the consumer does (inside one transaction). */
export async function deliverEvent<T extends EventType>(h: Harness, env: EventEnvelope<T>) {
  const handlers = createEventHandlers(h.ctx) as Record<string, (e: EventEnvelope<T>, s: unknown) => Promise<void>>;
  const fn = handlers[env.type];
  if (!fn) throw new Error(`no handler for ${env.type}`);
  await withTransaction(h.ctx.conn, (session) => fn(env, session));
}

/** Create a job via `order.accepted` and return it. */
export async function createJob(h: Harness, overrides: Parameters<typeof acceptedPayload>[0] = {}) {
  const payload = acceptedPayload(overrides);
  await deliverEvent(h, envelope('order.accepted', payload, payload.childOrderId));
  const job = await h.ctx.models.Job.findOne({ childOrderId: payload.childOrderId });
  if (!job) throw new Error('job not created');
  return { job, payload };
}

export async function outboxEvents(h: Harness, type: string, filter: Record<string, unknown> = {}) {
  const q: Record<string, unknown> = { 'envelope.type': type };
  for (const [k, v] of Object.entries(filter)) q[`envelope.payload.${k}`] = v;
  return outboxModel(h.ctx.conn).find(q).lean();
}
