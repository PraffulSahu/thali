/**
 * Timeout budget: marketplace -> payments must outlast payments' own provider timeout (PAYMENT_PROVIDER_TIMEOUT_MS,
 * default 8000): PAYMENTS_HTTP_TIMEOUT_MS (default 12000) is separate from INTERNAL_HTTP_TIMEOUT_MS (3000).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';
import { createPaymentsClient } from '../src/clients/payments.js';
import { loadMarketplaceConfig } from '../src/config.js';

const baseEnv = { SERVICE_NAME: 'marketplace', INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET, MONGO_URI: 'mongodb://localhost:27017/x', REDIS_URL: 'redis://localhost:6379', FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no intent', requestId: 'r' } }));
    }, 300);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('marketplace -> payments timeout budget', () => {
  it('PAYMENTS_HTTP_TIMEOUT_MS defaults to 12000 (> payments provider default 8000 + margin) and is configurable', () => {
    const c = loadMarketplaceConfig(baseEnv);
    expect(c.PAYMENTS_HTTP_TIMEOUT_MS).toBe(12_000);
    expect(c.PAYMENTS_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000 + 2_000);
    expect(c.INTERNAL_HTTP_TIMEOUT_MS).toBe(3_000);
    expect(loadMarketplaceConfig({ ...baseEnv, PAYMENTS_HTTP_TIMEOUT_MS: '20000' }).PAYMENTS_HTTP_TIMEOUT_MS).toBe(20_000);
  });

  it('the payments client honours its timeout (slow payments within budget succeeds; beyond it → UPSTREAM_TIMEOUT)', async () => {
    const ok = createPaymentsClient({ baseUrl: url, secret: TEST_INTERNAL_SERVICE_SECRET, timeoutMs: 3_000 });
    await expect(ok.getByReference('MEMBERSHIP', 'm1')).resolves.toBeNull();
    const tight = createPaymentsClient({ baseUrl: url, secret: TEST_INTERNAL_SERVICE_SECRET, timeoutMs: 100 });
    await expect(tight.getByReference('MEMBERSHIP', 'm1')).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
});
