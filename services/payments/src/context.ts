/**
 * Service context shared by routes, event handlers and jobs (dependency-injected for tests).
 */
import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import { initEventCollections, recordProviderError, type Redis } from '@thali/service-kit';
import { createMarketplaceClient, createOrdersClient, type MarketplaceClient, type OrdersClient } from './clients.js';
import type { PaymentsConfig } from './config.js';
import { ledgerEntryModel } from './models/ledger-entry.js';
import { paymentEventModel } from './models/payment-event.js';
import { paymentIntentModel } from './models/payment-intent.js';
import { accountLockModel, payoutModel } from './models/payout.js';
import { refundModel } from './models/refund.js';
import { createMockProvider } from './providers/mock-provider.js';
import type { PaymentProvider } from './providers/payment-provider.js';
import { createRazorpayProvider } from './providers/razorpay.js';

export function createModels(conn: Connection) {
  return {
    PaymentIntent: paymentIntentModel(conn),
    PaymentEvent: paymentEventModel(conn),
    Refund: refundModel(conn),
    LedgerEntry: ledgerEntryModel(conn),
    Payout: payoutModel(conn),
    AccountLock: accountLockModel(conn),
  };
}
export type Models = ReturnType<typeof createModels>;

export interface PaymentsContext {
  config: PaymentsConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  provider: PaymentProvider;
  marketplace: MarketplaceClient;
  orders: OrdersClient;
  models: Models;
  /** Service clock (injectable for tests). */
  now: () => Date;
}

export interface CreateContextDeps {
  config: PaymentsConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  provider?: PaymentProvider;
  marketplace?: MarketplaceClient;
  orders?: OrdersClient;
  now?: () => Date;
}

export function createProvider(config: PaymentsConfig, conn: Connection, redis: Redis): PaymentProvider {
  if (config.PAYMENT_PROVIDER === 'mock') {
    return createMockProvider({ conn, webhookSecret: config.MOCK_WEBHOOK_SECRET! });
  }
  return createRazorpayProvider({
    keyId: config.RAZORPAY_KEY_ID!,
    keySecret: config.RAZORPAY_KEY_SECRET!,
    webhookSecret: config.RAZORPAY_WEBHOOK_SECRET!,
    timeoutMs: config.PAYMENT_PROVIDER_TIMEOUT_MS,
    onError: () => {
      void recordProviderError(redis, 'payments', 'razorpay').catch(() => undefined);
    },
  });
}

export function createContext(deps: CreateContextDeps): PaymentsContext {
  return {
    config: deps.config,
    logger: deps.logger,
    conn: deps.conn,
    redis: deps.redis,
    provider: deps.provider ?? createProvider(deps.config, deps.conn, deps.redis),
    marketplace:
      deps.marketplace ??
      createMarketplaceClient({ baseUrl: deps.config.MARKETPLACE_URL, secret: deps.config.INTERNAL_SERVICE_SECRET, timeoutMs: deps.config.INTERNAL_HTTP_TIMEOUT_MS }),
    orders:
      deps.orders ??
      createOrdersClient({ baseUrl: deps.config.ORDERS_URL, secret: deps.config.INTERNAL_SERVICE_SECRET, timeoutMs: deps.config.INTERNAL_HTTP_TIMEOUT_MS }),
    models: createModels(deps.conn),
    now: deps.now ?? (() => new Date()),
  };
}

/** Create collections + indexes before serving (transactions must not race collection creation). */
export async function initPayments(ctx: PaymentsContext): Promise<void> {
  await initEventCollections(ctx.conn);
  const models = [...Object.values(ctx.models), ...['MockProviderPayment', 'MockProviderRefund'].flatMap((n) => (ctx.conn.models[n] ? [ctx.conn.models[n]] : []))];
  for (const m of models) {
    await m.createCollection().catch((err: { codeName?: string }) => {
      if (err?.codeName !== 'NamespaceExists') throw err;
    });
    await m.createIndexes();
  }
}
