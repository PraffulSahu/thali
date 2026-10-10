/**
 * Shared test harness: real Mongo + Redis (unique DB / key prefix per file), fake providers, fake
 * identity directory, real hub, real app. Never calls the network.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Connection } from 'mongoose';
import {
  createAuthVerifier,
  createLogger,
  signServiceToken,
  type AuthVerifier,
  type Redis,
} from '@thali/service-kit';
import {
  createTestDb,
  createTestRedis,
  generateTestKeys,
  TEST_INTERNAL_SERVICE_SECRET,
  TEST_MONGO_URI,
  TEST_REDIS_URL,
  type TestDb,
  type TestKeys,
  type TestRedis,
} from '@thali/service-kit/testing';
import type { ServiceName } from '@thali/contracts';
import { buildApp } from '../src/app.js';
import { loadNotificationsConfig, type NotificationsConfig } from '../src/config.js';
import { createDispatcher, type Dispatcher } from '../src/domain/dispatcher.js';
import type { IdentityUser, OrdersLookup, RecipientDirectory } from '../src/domain/recipients.js';
import { ENC_KEY, LogCapture, RESEND_SECRET, TWILIO_TOKEN, TWILIO_URL, oid, svixHeaders, twilioSign } from './fixtures.js';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.js';
import { createRealtimePublisher } from '../src/realtime/publish.js';
import { notificationModel, type NotificationModel } from '../src/models/notification.js';
import { providerCallbackModel, type ProviderCallbackModel } from '../src/models/provider-callback.js';
import { ProviderSendError } from '../src/providers/errors.js';
import type { SmsMessage, SmsProvider } from '../src/providers/sms.js';
import type { EmailMessage, EmailProvider } from '../src/providers/email.js';
import { createFailMode, type FailMode } from '../src/providers/fail-mode.js';
import type { DeadLetterSource } from '../src/routes/admin.js';

export { ENC_KEY, TWILIO_URL, TWILIO_TOKEN, RESEND_SECRET, LogCapture, oid, twilioSign, svixHeaders };

export class FakeSms implements SmsProvider {
  readonly name = 'twilio' as const;
  calls: SmsMessage[] = [];
  failWith: Error | null = null;
  private n = 0;
  async send(msg: SmsMessage) {
    this.calls.push(msg);
    if (this.failWith) throw this.failWith;
    return { providerMessageId: `SM${String(++this.n).padStart(6, '0')}` };
  }
}

export class FakeEmail implements EmailProvider {
  readonly name = 'resend' as const;
  calls: EmailMessage[] = [];
  failWith: Error | null = null;
  private n = 0;
  async send(msg: EmailMessage) {
    this.calls.push(msg);
    if (this.failWith) throw this.failWith;
    return { providerMessageId: `email-${++this.n}` };
  }
}

export const unavailable = () => new ProviderSendError('twilio', 'provider down (503)', { retryable: true, status: 503 });
export const invalidNumber = () => new ProviderSendError('twilio', 'invalid number (21211)', { retryable: false, status: 400, code: '21211' });

export class FakeDirectory implements RecipientDirectory {
  users = new Map<string, IdentityUser>();
  down = false;
  lookups = 0;
  async getUser(id: string) {
    this.lookups++;
    if (this.down) throw new Error('identity unavailable');
    return this.users.get(id) ?? null;
  }
  add(partial: Partial<IdentityUser> & { id: string }): IdentityUser {
    const u: IdentityUser = {
      phone: '+919876543210',
      email: 'asha@example.com',
      name: 'Asha',
      roles: ['CONSUMER'],
      status: 'ACTIVE',
      ...partial,
      notificationPrefs: { orderSms: false, orderEmail: false, marketingSms: false, marketingEmail: false, ...(partial.notificationPrefs ?? {}) },
    };
    this.users.set(u.id, u);
    return u;
  }
}

export class FakeOrders implements OrdersLookup {
  map = new Map<string, string>();
  down = false;
  lookups = 0;
  async getChildOrder(id: string) {
    this.lookups++;
    if (this.down) throw new Error('orders unavailable');
    const userId = this.map.get(id);
    return userId ? { id, userId } : null;
  }
}

export interface HarnessOptions {
  env?: Record<string, string>;
  heartbeatMs?: number;
  autoKick?: boolean;
  appMode?: 'demo' | 'sandbox' | 'production';
  deadLetterSources?: DeadLetterSource[];
  onProviderError?: (provider: string, message?: string) => void;
}

export interface Harness {
  config: NotificationsConfig;
  db: TestDb;
  conn: Connection;
  tr: TestRedis;
  redis: Redis;
  keys: TestKeys;
  auth: AuthVerifier;
  models: { Notification: NotificationModel; ProviderCallback: ProviderCallbackModel };
  sms: FakeSms;
  email: FakeEmail;
  directory: FakeDirectory;
  orders: FakeOrders;
  failMode: FailMode;
  clock: { now: Date };
  logs: LogCapture;
  dispatcher: Dispatcher;
  hub: RealtimeHub;
  app: Express;
  userToken(userId: string, claims?: Record<string, unknown>): Promise<string>;
  adminToken(userId?: string, opts?: { mfa?: boolean }): Promise<string>;
  serviceToken(from: ServiceName): Promise<string>;
  listen(): Promise<{ server: Server; baseUrl: string }>;
  close(): Promise<void>;
}

export async function createHarness(name: string, opts: HarnessOptions = {}): Promise<Harness> {
  const tr = await createTestRedis();
  const db = await createTestDb(`notif_${name}`);
  const keys = await generateTestKeys();
  const logs = new LogCapture();
  const logger = createLogger('notifications', { level: 'debug', destination: logs });
  const config = loadNotificationsConfig({
    SERVICE_NAME: 'notifications',
    PORT: '4006',
    APP_MODE: opts.appMode ?? 'demo',
    MONGO_URI: TEST_MONGO_URI,
    REDIS_URL: TEST_REDIS_URL,
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    LOG_LEVEL: 'silent',
    EVENT_STREAM_PREFIX: tr.prefix,
    REDIS_KEY_PREFIX: tr.prefix,
    SMS_PROVIDER: 'mock',
    EMAIL_PROVIDER: 'mock',
    FIELD_ENCRYPTION_KEY: ENC_KEY,
    TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
    TWILIO_STATUS_CALLBACK_URL: TWILIO_URL,
    RESEND_WEBHOOK_SECRET: RESEND_SECRET,
    SSE_HEARTBEAT_MS: String(opts.heartbeatMs ?? 100),
    ...opts.env,
  });
  const models = { Notification: notificationModel(db.conn), ProviderCallback: providerCallbackModel(db.conn) };
  await Promise.all([models.Notification.init(), models.ProviderCallback.init()]);
  const sms = new FakeSms();
  const email = new FakeEmail();
  const directory = new FakeDirectory();
  const orders = new FakeOrders();
  const failMode = createFailMode(tr.redis);
  const clock = { now: new Date('2026-10-10T10:00:00.000Z') };
  const realtime = createRealtimePublisher(tr.redis, logger);
  const dispatcher = createDispatcher({
    models,
    sms,
    email,
    realtime,
    directory,
    orders,
    encryptionKey: config.FIELD_ENCRYPTION_KEY,
    maxAttempts: config.NOTIF_MAX_ATTEMPTS,
    retryBaseSec: config.NOTIF_RETRY_BASE_SEC,
    retryMaxSec: config.NOTIF_RETRY_MAX_SEC,
    sendingTimeoutSec: config.NOTIF_SENDING_TIMEOUT_SEC,
    statusCallbackUrl: config.TWILIO_STATUS_CALLBACK_URL,
    logger,
    now: () => new Date(clock.now),
    autoKick: opts.autoKick ?? false,
    ...(opts.onProviderError ? { onProviderError: opts.onProviderError } : {}),
  });
  const hub = await createRealtimeHub({ redis: tr.redis, logger, heartbeatMs: config.SSE_HEARTBEAT_MS, maxAgeMs: config.SSE_MAX_AGE_SEC * 1000, maxPerUser: config.SSE_MAX_STREAMS_PER_USER });
  const auth = createAuthVerifier({ jwks: keys.jwks, redis: tr.redis });
  const app = buildApp({
    config,
    logger,
    conn: db.conn,
    redis: tr.redis,
    models,
    dispatcher,
    directory,
    hub,
    failMode,
    auth,
    deadLetterSources: opts.deadLetterSources ?? [],
    now: () => new Date(clock.now),
  });
  const servers: Server[] = [];
  return {
    config, db, conn: db.conn, tr, redis: tr.redis, keys, auth, models, sms, email, directory, orders, failMode, clock, logs, dispatcher, hub, app,
    userToken: (userId, claims = {}) => keys.sign({ sub: userId, roles: ['CONSUMER'], ...claims }),
    adminToken: (userId = 'a'.repeat(24), o = {}) =>
      keys.sign({ sub: userId, roles: ['CONSUMER', 'ADMIN'], adm: ['OPS'], amr: o.mfa === false ? ['pwd'] : ['pwd', 'mfa'] }),
    serviceToken: (from) => signServiceToken(from, 'notifications', TEST_INTERNAL_SERVICE_SECRET),
    async listen() {
      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      servers.push(server);
      return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    },
    async close() {
      await hub.close();
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      await tr.cleanup();
      await db.drop();
    },
  };
}

