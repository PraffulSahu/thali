/**
 * Shared test harness for marketplace integration tests: isolated Mongo DB + Redis prefix per file,
 * test JWKS, fake identity client, demo geo provider, real MinIO storage (only touched by uploads tests).
 */
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type { Role } from '@thali/contracts';
import { createAuthVerifier, createDemoGeo, createStorageProvider, outboxModel, type StorageProvider } from '@thali/service-kit';
import {
  createTestDb,
  createTestRedis,
  generateTestKeys,
  testLogger,
  TEST_INTERNAL_SERVICE_SECRET,
  type TestDb,
  type TestKeys,
  type TestRedis,
} from '@thali/service-kit/testing';
import { buildApp, createContext } from '../src/app.js';
import type { AppContext, MarketplaceDeps } from '../src/context.js';
import { fakeOrders, fakePayments, type FakeOrders, type FakePayments } from './fakes.js';
import { loadMarketplaceConfig, type MarketplaceConfig } from '../src/config.js';
import type { IdentityClient } from '../src/clients/identity.js';
import { getModels, ensureMarketplaceIndexes, type Models } from '../src/models/index.js';

export interface FakeIdentity extends IdentityClient {
  calls: { userId: string; role: string }[];
  fail: boolean;
}

export function fakeIdentity(): FakeIdentity {
  const f: FakeIdentity = {
    calls: [],
    fail: false,
    async grantRole(userId, role) {
      if (f.fail) {
        const { DomainError } = await import('@thali/contracts');
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'identity down');
      }
      f.calls.push({ userId, role });
      return { userId, roles: ['CONSUMER', role] as Role[] };
    },
  };
  return f;
}

export interface Harness {
  app: Express;
  db: TestDb;
  tr: TestRedis;
  keys: TestKeys;
  config: MarketplaceConfig;
  identity: FakeIdentity;
  orders: FakeOrders;
  payments: FakePayments;
  /** Same deps as `app` (domain functions, consumers, sweepers in tests). */
  ctx: AppContext;
  storage: StorageProvider;
  models: Models;
  clock: { now: Date | null };
  ownerToken(userId?: string): Promise<string>;
  consumerToken(userId?: string): Promise<string>;
  adminToken(opts?: { mfa?: boolean; userId?: string }): Promise<string>;
  internalToken(from?: 'orders' | 'payments' | 'delivery' | 'identity'): Promise<string>;
  events(type?: string): Promise<{ type: string; payload: Record<string, unknown>; aggregateId: string }[]>;
  close(): Promise<void>;
}

export const newId = () => randomBytes(12).toString('hex');

export async function createHarness(name: string, env: Record<string, string> = {}): Promise<Harness> {
  const db = await createTestDb(`mkt_${name}`);
  const tr = await createTestRedis();
  const keys = await generateTestKeys();
  const config = loadMarketplaceConfig({
    SERVICE_NAME: 'marketplace',
    MONGO_URI: db.uri,
    REDIS_URL: tr.url,
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    LOG_LEVEL: 'silent',
    EVENT_STREAM_PREFIX: tr.prefix,
    REDIS_KEY_PREFIX: tr.prefix,
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_WEB_URL: 'http://web.test',
    PUBLIC_API_URL: 'http://api.test',
    GEO_PROVIDER: 'demo',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'thali',
    S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'thali-dev-secret',
    S3_PUBLIC_BASE_URL: 'http://localhost:9000/thali-public',
    REQUIRED_DOCUMENT_TYPES: '',
    ...env,
  });
  await ensureMarketplaceIndexes(db.conn);
  const identity = fakeIdentity();
  const storage = createStorageProvider(config);
  const clock: { now: Date | null } = { now: null };
  const orders = fakeOrders();
  const payments = fakePayments();
  const deps: MarketplaceDeps = {
    config,
    logger: testLogger('marketplace'),
    conn: db.conn,
    redis: tr.redis,
    auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }),
    geo: createDemoGeo(),
    storage,
    identity,
    orders,
    payments,
    now: () => clock.now ?? new Date(),
  };
  const app = buildApp(deps);
  const { signServiceToken } = await import('@thali/service-kit');
  return {
    app,
    db,
    tr,
    keys,
    config,
    identity,
    orders,
    payments,
    ctx: createContext(deps),
    storage,
    models: getModels(db.conn),
    clock,
    ownerToken: (userId = newId()) => keys.sign({ sub: userId, roles: ['CONSUMER', 'RESTAURANT_OWNER'] }),
    consumerToken: (userId = newId()) => keys.sign({ sub: userId, roles: ['CONSUMER'] }),
    adminToken: ({ mfa = true, userId = newId() } = {}) =>
      keys.sign({ sub: userId, roles: ['CONSUMER', 'ADMIN'], amr: mfa ? ['pwd', 'mfa'] : ['pwd'], adm: ['OPS'] }),
    internalToken: (from = 'orders') => signServiceToken(from, 'marketplace', TEST_INTERNAL_SERVICE_SECRET),
    async events(type?: string) {
      const rows = await outboxModel(db.conn)
        .find(type ? { 'envelope.type': type } : {})
        .sort({ createdAt: 1 })
        .lean();
      return rows.map((r) => r.envelope as unknown as { type: string; payload: Record<string, unknown>; aggregateId: string });
    },
    async close() {
      await tr.cleanup();
      await db.drop();
    },
  };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** A complete owner-editable profile (Bengaluru, Indiranagar). */
export function fullProfile(overrides: Record<string, unknown> = {}) {
  return {
    businessName: 'Spice Route Foods Pvt Ltd',
    name: 'Spice Route',
    description: 'North Indian thalis and curries',
    cuisines: ['north-indian', 'thali'],
    phone: '+91 98765 43210',
    businessEmail: 'owner@spiceroute.test',
    address: { line1: '12 100 Feet Road', city: 'Bengaluru', pincode: '560038' },
    location: { lat: 12.9716, lng: 77.6412 },
    hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '00:00' })),
    ...overrides,
  };
}

export const settlementBody = { accountHolder: 'Spice Route Foods', accountNumber: '123456789012', ifsc: 'HDFC0001234' };

/** Insert a restaurant directly (bypassing onboarding). Returns the id. */
export async function seedRestaurant(models: Models, fields: Record<string, unknown> = {}): Promise<string> {
  const { location, ...rest } = fields as { location?: { lat: number; lng: number } };
  const loc = location ?? { lat: 12.9716, lng: 77.6412 };
  const id = newId();
  await models.Restaurant.create({
    _id: id,
    ownerUserId: newId(),
    businessName: 'Seed Biz',
    name: `Seed ${id.slice(-4)}`,
    slug: `seed-${id}`,
    description: 'seeded',
    cuisines: ['north-indian'],
    phone: '+919876543210',
    businessEmail: `${id}@seed.test`,
    emailVerifiedAt: new Date(),
    address: { line1: 'Somewhere', city: 'Bengaluru', pincode: '560001' },
    location: { type: 'Point', coordinates: [loc.lng, loc.lat] },
    deliveryRadiusKm: 6,
    hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '00:00' })),
    timezone: 'Asia/Kolkata',
    status: 'APPROVED',
    packagingFeePaise: 0,
    avgPrepMinutes: 20,
    commissionBps: 1800,
    ratingSum: 0,
    ratingCount: 0,
    isDemo: false,
    ...rest,
  });
  return id;
}

/** Square service area around central Bengaluru (≈ 12.90–13.05 N, 77.55–77.70 E). */
export async function seedServiceArea(models: Models, fields: Record<string, unknown> = {}): Promise<string> {
  const doc = await models.ServiceArea.create({
    name: 'Bengaluru Central',
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [77.55, 12.9],
          [77.7, 12.9],
          [77.7, 13.05],
          [77.55, 13.05],
          [77.55, 12.9],
        ],
      ],
    },
    active: true,
    deliveryFee: { basePaise: 2000, baseKm: 2, perKmPaise: 500, maxPaise: 8000 },
    minOrderPaise: 10000,
    ...fields,
  });
  return String(doc._id);
}

/** Point `km` kilometres north of (lat,lng) (straight line). */
export function northOf(p: { lat: number; lng: number }, km: number) {
  return { lat: p.lat + km / 111.195, lng: p.lng };
}
