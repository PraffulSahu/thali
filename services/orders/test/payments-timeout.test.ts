/**
 * Timeout budget: orders -> payments must outlast payments' own provider timeout (PAYMENT_PROVIDER_TIMEOUT_MS,
 * default 8000), so the payments client uses PAYMENTS_HTTP_TIMEOUT_MS (default 12000), not INTERNAL_HTTP_TIMEOUT_MS.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestConfig, TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';
import { createPaymentsClient } from '../src/clients/payments.js';
import { loadOrdersConfig, ORDERS_CONFIG_DEFAULTS, type OrdersConfig } from '../src/config.js';

let server: Server;
let url: string;
beforeAll(async () => {
  // A payments double that answers reconcile after 300 ms (as if waiting on the provider).
  server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ paymentIntentId: 'pi1', status: 'CAPTURED', capturedPaise: 100, refundedPaise: 0, refundReservedPaise: 0 }));
    }, 300);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const config = (over: Partial<OrdersConfig>): OrdersConfig =>
  ({ ...createTestConfig({ SERVICE_NAME: 'orders', INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET }), ...ORDERS_CONFIG_DEFAULTS, PAYMENTS_URL: url, ...over }) as OrdersConfig;

describe('orders -> payments timeout budget', () => {
  it('defaults: payments budget 12000 ms exceeds the payments provider default (8000) + margin; other services 5000', () => {
    expect(ORDERS_CONFIG_DEFAULTS.PAYMENTS_HTTP_TIMEOUT_MS).toBe(12_000);
    expect(ORDERS_CONFIG_DEFAULTS.PAYMENTS_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000 + 2_000);
    expect(ORDERS_CONFIG_DEFAULTS.INTERNAL_HTTP_TIMEOUT_MS).toBe(5_000);
    expect(loadOrdersConfig({ SERVICE_NAME: 'orders', INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET, MONGO_URI: 'mongodb://localhost:27017/x', REDIS_URL: 'redis://localhost:6379', PAYMENTS_HTTP_TIMEOUT_MS: '20000' }).PAYMENTS_HTTP_TIMEOUT_MS).toBe(20_000);
  });

  it('the payments client uses PAYMENTS_HTTP_TIMEOUT_MS, not INTERNAL_HTTP_TIMEOUT_MS', async () => {
    const ok = createPaymentsClient(config({ INTERNAL_HTTP_TIMEOUT_MS: 100, PAYMENTS_HTTP_TIMEOUT_MS: 3_000 }));
    await expect(ok.reconcile('pi1')).resolves.toMatchObject({ status: 'CAPTURED', capturedPaise: 100 });
    const tight = createPaymentsClient(config({ INTERNAL_HTTP_TIMEOUT_MS: 3_000, PAYMENTS_HTTP_TIMEOUT_MS: 100 }));
    await expect(tight.reconcile('pi1')).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
});
