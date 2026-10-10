import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toOpenApiPath } from '@thali/service-kit';
import { setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('openapi');
});
afterAll(async () => {
  await h.cleanup();
});

describe('OpenAPI coverage', () => {
  it('every mounted route is documented in /openapi.json', async () => {
    const doc = await request(h.app).get('/openapi.json');
    expect(doc.status).toBe(200);
    const routes = await request(h.app)
      .get('/internal/routes')
      .set('authorization', `Bearer ${await h.internalToken('gateway')}`);
    expect(routes.status).toBe(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    const missing = (routes.body as { method: string; path: string }[])
      .filter((r) => !paths[toOpenApiPath(r.path)]?.[r.method.toLowerCase()])
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    expect(paths['/api/v1/checkouts']!.post).toBeDefined();
    expect(doc.body.components.schemas.Checkout).toBeDefined();
  });

  it('ops routes require a service token', async () => {
    expect((await request(h.app).get('/internal/health/details')).status).toBe(401);
    const ok = await request(h.app)
      .get('/internal/health/details')
      .set('authorization', `Bearer ${await h.internalToken('gateway')}`);
    expect(ok.status).toBe(200);
    expect(ok.body.service).toBe('orders');
  });
});
