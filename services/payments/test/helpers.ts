/**
 * Shared test harness for the payments service: real Mongo replica set + Redis (unique DB / prefixes per
 * file), injected test JWKS, a controllable fake payment provider and a fake marketplace client.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Types } from 'mongoose';
import { vi } from 'vitest';
import type { EventEnvelope, EventType, EventPayloads } from '@thali/contracts';
import { createAuthVerifier, createLogger, createEnvelope, signServiceToken } from '@thali/service-kit';
import {
  createTestDb,
  createTestRedis,
  generateTestKeys,
  TEST_INTERNAL_SERVICE_SECRET,
  type TestKeys,
} from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { loadPaymentsConfig, type PaymentsConfig } from '../src/config.js';
import { createContext, initPayments, type PaymentsContext } from '../src/context.js';
import type { MarketplaceClient, RestaurantInfo } from '../src/clients.js';
import {
  parseRazorpayWebhook,
  verifyHexHmac,
  type NormalizedEvent,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
} from '../src/providers/payment-provider.js';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const KEY_SECRET = 'test-key-secret-0123456789';

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Controllable provider double: real HMAC verification + Razorpay payload parsing, stubbed I/O. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  readonly keyId = 'rzp_test_key';
  payments = new Map<string, ProviderPayment[]>();
  refunds = new Map<string, ProviderRefund>();
  orderSeq = 0;
  createOrder = vi.fn(async (_i: { amountPaise: number; currency: 'INR'; receipt: string; notes: Record<string, string> }) => ({
    providerOrderId: `order_test_${++this.orderSeq}_${randomBytes(3).toString('hex')}`,
  }));
  fetchOrderPayments = vi.fn(async (orderId: string) => this.payments.get(orderId) ?? []);
  capture = vi.fn(async (paymentId: string, amountPaise: number): Promise<ProviderPayment> => {
    for (const list of this.payments.values()) {
      const p = list.find((x) => x.id === paymentId);
      if (p) {
        p.status = 'captured';
        p.captured = true;
        return { ...p, amountPaise };
      }
    }
    throw new Error('unknown payment');
  });
  refundImpl: (i: { paymentId: string; amountPaise: number; idempotencyKey: string; notes: Record<string, string> }) => Promise<{
    providerRefundId: string;
    status: 'pending' | 'processed' | 'failed';
  }> = async (i) => {
    const id = `rfnd_${randomBytes(4).toString('hex')}`;
    this.refunds.set(id, { id, paymentId: i.paymentId, amountPaise: i.amountPaise, status: 'pending', notes: i.notes });
    return { providerRefundId: id, status: 'pending' };
  };
  refund = vi.fn((i: { paymentId: string; amountPaise: number; idempotencyKey: string; notes: Record<string, string> }) => this.refundImpl(i));
  fetchRefund = vi.fn(async (id: string) => {
    const r = this.refunds.get(id);
    if (!r) throw new Error('unknown refund');
    return r;
  });
  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    return verifyHexHmac(WEBHOOK_SECRET, rawBody, signature);
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return verifyHexHmac(KEY_SECRET, `${orderId}|${paymentId}`, signature);
  }
  parseWebhook(json: unknown): NormalizedEvent | null {
    return parseRazorpayWebhook(json);
  }
  /** Seed a provider-side payment for an order. */
  addPayment(orderId: string, p: Partial<ProviderPayment> & { status: ProviderPayment['status'] }): ProviderPayment {
    const payment: ProviderPayment = {
      id: p.id ?? `pay_${randomBytes(4).toString('hex')}`,
      orderId,
      amountPaise: p.amountPaise ?? 0,
      currency: p.currency ?? 'INR',
      status: p.status,
      captured: p.captured ?? (p.status === 'captured' || p.status === 'refunded'),
      createdAt: p.createdAt ?? new Date(),
      ...(p.errorDescription ? { errorDescription: p.errorDescription } : {}),
    };
    this.payments.set(orderId, [...(this.payments.get(orderId) ?? []), payment]);
    return payment;
  }
}

export class FakeMarketplace implements MarketplaceClient {
  restaurants = new Map<string, RestaurantInfo>();
  calls: string[] = [];
  add(id: string, ownerUserId: string): void {
    this.restaurants.set(id, {
      id,
      ownerUserId,
      name: `R ${id.slice(-4)}`,
      status: 'APPROVED',
      location: { lat: 12.97, lng: 77.59 },
      address: { line1: 'x', city: 'Bengaluru', pincode: '560001' },
      phone: '+919876543210',
      commissionBps: 1800,
      packagingFeePaise: 0,
      avgPrepMinutes: 20,
    });
  }
  async getRestaurant(id: string): Promise<RestaurantInfo | null> {
    this.calls.push(id);
    return this.restaurants.get(id) ?? null;
  }
}

export interface Harness {
  ctx: PaymentsContext;
  app: ReturnType<typeof buildApp>;
  provider: PaymentProvider;
  fake: FakeProvider;
  marketplace: FakeMarketplace;
  keys: TestKeys;
  config: PaymentsConfig;
  logs: Record<string, unknown>[];
  clock: { now: Date; advance(ms: number): void };
  cleanup(): Promise<void>;
}

export interface SetupOptions {
  env?: Record<string, string>;
  /** Use a provider built by the context (e.g. the real mock provider) instead of FakeProvider. */
  realProvider?: boolean;
}

export async function setup(name: string, opts: SetupOptions = {}): Promise<Harness> {
  const db = await createTestDb(`payments_${name}`);
  const tr = await createTestRedis();
  const keys = await generateTestKeys();
  const config = loadPaymentsConfig({
    SERVICE_NAME: 'payments',
    MONGO_URI: db.uri,
    REDIS_URL: tr.url,
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    LOG_LEVEL: 'silent',
    REDIS_KEY_PREFIX: tr.prefix,
    EVENT_STREAM_PREFIX: tr.prefix,
    PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...opts.env,
  });
  const logs: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n')) if (line.trim()) logs.push(JSON.parse(line) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger('payments', { level: 'info', destination });
  const fake = new FakeProvider();
  const marketplace = new FakeMarketplace();
  const clock = {
    now: new Date(),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const ctx = createContext({
    config,
    logger,
    conn: db.conn,
    redis: tr.redis,
    ...(opts.realProvider ? {} : { provider: fake }),
    marketplace,
    now: () => clock.now,
  });
  await initPayments(ctx);
  const app = buildApp({ ctx, auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }) });
  return {
    ctx,
    app,
    provider: ctx.provider,
    fake,
    marketplace,
    keys,
    config,
    logs,
    clock,
    async cleanup() {
      await tr.cleanup();
      await db.drop();
    },
  };
}

export function oid(): string {
  return new Types.ObjectId().toHexString();
}

export async function internalToken(from: 'orders' | 'marketplace' | 'identity' = 'orders'): Promise<string> {
  return signServiceToken(from, 'payments', TEST_INTERNAL_SERVICE_SECRET);
}

export async function adminToken(keys: TestKeys, opts: { adm?: string[]; mfa?: boolean; sub?: string } = {}): Promise<string> {
  return keys.sign({
    sub: opts.sub ?? oid(),
    roles: ['CONSUMER', 'ADMIN'],
    amr: opts.mfa === false ? ['pwd'] : ['pwd', 'mfa'],
    adm: opts.adm ?? ['FINANCE'],
  } as never);
}

export function envelope<T extends EventType>(type: T, payload: EventPayloads[T], aggregateId = 'agg'): EventEnvelope<T> {
  return createEnvelope(type, payload, { producer: 'orders', aggregateId, correlationId: randomUUID() });
}

/** Razorpay-shaped payment webhook body. */
export function paymentWebhook(
  event: 'payment.authorized' | 'payment.captured' | 'payment.failed',
  p: { orderId: string; paymentId: string; amount: number; currency?: string; notes?: Record<string, string> },
): Record<string, unknown> {
  const status = event === 'payment.authorized' ? 'authorized' : event === 'payment.captured' ? 'captured' : 'failed';
  return {
    entity: 'event',
    account_id: 'acc_test',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: p.paymentId,
          entity: 'payment',
          amount: p.amount,
          currency: p.currency ?? 'INR',
          status,
          order_id: p.orderId,
          captured: status === 'captured',
          notes: p.notes ?? [],
          error_description: status === 'failed' ? 'Payment declined by bank' : null,
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function refundWebhook(
  event: 'refund.processed' | 'refund.failed',
  r: { refundId: string; paymentId: string; amount: number; notes?: Record<string, string> },
): Record<string, unknown> {
  return {
    entity: 'event',
    account_id: 'acc_test',
    event,
    contains: ['refund', 'payment'],
    payload: {
      refund: {
        entity: {
          id: r.refundId,
          entity: 'refund',
          amount: r.amount,
          currency: 'INR',
          payment_id: r.paymentId,
          notes: r.notes ?? {},
          receipt: null,
          status: event === 'refund.processed' ? 'processed' : 'failed',
          created_at: Math.floor(Date.now() / 1000),
        },
      },
      payment: { entity: { id: r.paymentId, entity: 'payment', amount: r.amount, currency: 'INR', status: 'refunded' } },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}
