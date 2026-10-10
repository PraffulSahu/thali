import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toOpenApiPath } from '@thali/service-kit';
import { internalToken, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('openapi', { realProvider: true, env: { PAYMENT_PROVIDER: 'mock', MOCK_WEBHOOK_SECRET: 'mock-webhook-secret-for-tests-01' } });
});
afterAll(async () => {
  await h.cleanup();
});

describe('OpenAPI coverage', () => {
  it('every mounted route is documented in /openapi.json', async () => {
    const doc = await request(h.app).get('/openapi.json');
    expect(doc.status).toBe(200);
    const routes = await request(h.app).get('/internal/routes').set('authorization', `Bearer ${await internalToken('orders')}`);
    expect(routes.status).toBe(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    const missing = (routes.body as { method: string; path: string }[]).filter((r) => !paths[toOpenApiPath(r.path)]?.[r.method.toLowerCase()]);
    expect(missing).toEqual([]);
  });

  it('health endpoints respond', async () => {
    expect((await request(h.app).get('/health/live')).status).toBe(200);
    expect((await request(h.app).get('/health/ready')).body.checks).toEqual({ mongo: 'up', redis: 'up' });
    const details = await request(h.app).get('/internal/health/details').set('authorization', `Bearer ${await internalToken('orders')}`);
    expect(details.status).toBe(200);
    expect(details.body.service).toBe('payments');
  });
});
