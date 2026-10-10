/**
 * Shared harness for identity integration tests: isolated Mongo DB + Redis prefix per test file,
 * fake notifications/orders clients, helpers for OTP login / CSRF headers / cookies.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request, { type Response, type Test } from 'supertest';
import type { Express } from 'express';
import { decodeJwt } from 'jose';
import { tryNormalizePhone, DomainError, type AdminRole, type Role } from '@thali/contracts';
import { redisKey } from '@thali/service-kit';
import {
  createTestDb,
  createTestRedis,
  testLogger,
  TEST_INTERNAL_SERVICE_SECRET,
  TEST_MONGO_URI,
  TEST_REDIS_URL,
  type TestDb,
  type TestRedis,
} from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { loadIdentityConfig, type IdentityConfig } from '../src/config.js';
import { initIdentityDb } from '../src/db.js';
import { loadSigningKeys, type KeyStore } from '../src/domain/tokens.js';
import type { NotificationsClient } from '../src/clients/notifications.js';
import type { OrdersClient } from '../src/clients/orders.js';

export const ORIGIN = 'http://localhost:5173';
export const FIELD_KEY = Buffer.alloc(32, 7).toString('base64');

export class FakeNotifications implements NotificationsClient {
  sent: { phone: string; code: string }[] = [];
  fail = false;
  async sendOtp(phone: string, code: string): Promise<void> {
    if (this.fail) throw new DomainError('OTP_DELIVERY_FAILED', 'SMS provider down');
    this.sent.push({ phone, code });
  }
  lastCode(phone: string): string {
    const hit = [...this.sent].reverse().find((s) => s.phone === phone);
    if (!hit) throw new Error(`no OTP sent to ${phone}`);
    return hit.code;
  }
}

export class FakeOrders implements OrdersClient {
  calls: { userId: string; guestToken: string }[] = [];
  fail = false;
  async mergeCart(userId: string, guestToken: string) {
    this.calls.push({ userId, guestToken });
    if (this.fail) throw new DomainError('UPSTREAM_UNAVAILABLE', 'orders down');
    return { merged: true, lineCount: 2 };
  }
}

export function baseEnv(prefix: string): Record<string, string> {
  return {
    SERVICE_NAME: 'identity',
    APP_MODE: 'demo',
    MONGO_URI: TEST_MONGO_URI,
    REDIS_URL: TEST_REDIS_URL,
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: ORIGIN,
    REDIS_KEY_PREFIX: prefix,
    EVENT_STREAM_PREFIX: prefix,
    OTP_PEPPER: 'test-otp-pepper-0123456789abcdef',
    FIELD_ENCRYPTION_KEY: FIELD_KEY,
    OTP_MAX_PER_IP_PER_HOUR: '1000',
    NOTIFICATIONS_URL: 'http://127.0.0.1:1',
    ORDERS_URL: 'http://127.0.0.1:1',
  };
}

export interface Harness {
  db: TestDb;
  tr: TestRedis;
  config: IdentityConfig;
  keys: KeyStore;
  notifications: FakeNotifications;
  orders: FakeOrders;
  app: Express;
  /** Another app sharing the same DB/Redis/keys/fakes with env overrides. */
  appWith(env: Record<string, string>): Express;
  close(): Promise<void>;
}

export async function createHarness(name: string, env: Record<string, string> = {}): Promise<Harness> {
  const db = await createTestDb(`identity_${name}`);
  const tr = await createTestRedis();
  const config = loadIdentityConfig({ ...baseEnv(tr.prefix), ...env });
  await initIdentityDb(db.conn);
  const keys = await loadSigningKeys(db.conn, config);
  const notifications = new FakeNotifications();
  const orders = new FakeOrders();
  const make = (cfg: IdentityConfig) =>
    buildApp({ config: cfg, logger: testLogger('identity'), conn: db.conn, redis: tr.redis, keys, notifications, orders });
  return {
    db,
    tr,
    config,
    keys,
    notifications,
    orders,
    app: make(config),
    appWith: (over) => make(loadIdentityConfig({ ...baseEnv(tr.prefix), ...env, ...over })),
    async close() {
      await tr.cleanup();
      await db.drop();
    },
  };
}

/** A random valid Indian mobile number in E.164. */
export function randomPhone(): string {
  for (;;) {
    const candidate = `+9198${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    const n = tryNormalizePhone(candidate);
    if (n) return n;
  }
}

export const withCsrf = (t: Test, origin = ORIGIN) => t.set('X-Requested-With', 'thali-web').set('Origin', origin);

/** `thali_rt=<value>` from a response's Set-Cookie, or null. */
export function refreshCookie(res: Response): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((h) => h.startsWith('thali_rt='));
  if (!c) return null;
  const pair = c.split(';')[0]!;
  return pair === 'thali_rt=' ? null : pair;
}

export function rawSetCookie(res: Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((h) => h.startsWith('thali_rt='));
}

export interface LoginResult {
  accessToken: string;
  cookie: string;
  userId: string;
  sid: string;
  body: Record<string, unknown>;
}

export async function loginWithOtp(app: Express, h: Harness, phone: string, extra: Record<string, unknown> = {}): Promise<LoginResult> {
  const r1 = await request(app).post('/api/v1/auth/otp/request').send({ phone });
  if (r1.status !== 200) throw new Error(`otp request failed ${r1.status} ${JSON.stringify(r1.body)}`);
  const normalized = tryNormalizePhone(phone)!;
  const code = r1.body.demoOtp ? '123456' : h.notifications.lastCode(normalized);
  const r2 = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code, ...extra });
  if (r2.status !== 200) throw new Error(`otp verify failed ${r2.status} ${JSON.stringify(r2.body)}`);
  const claims = decodeJwt(r2.body.accessToken);
  return {
    accessToken: r2.body.accessToken,
    cookie: refreshCookie(r2)!,
    userId: String(claims.sub),
    sid: String(claims.sid),
    body: r2.body,
  };
}

/** Mint an access token directly (bypasses login) — for admin/consumer route tests. */
export async function mintToken(
  h: Harness,
  opts: { userId: string; roles?: Role[]; adminRoles?: AdminRole[]; amr?: string[]; sid?: string },
): Promise<string> {
  return h.keys.signAccessToken({
    sub: opts.userId,
    roles: opts.roles ?? ['CONSUMER'],
    adm: opts.adminRoles,
    sid: opts.sid ?? randomUUID(),
    amr: opts.amr ?? ['otp'],
  });
}

export async function isRevoked(h: Harness, sid: string): Promise<boolean> {
  return (await h.tr.redis.exists(redisKey(h.tr.redis, `revoked:sid:${sid}`))) === 1;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
