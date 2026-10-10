import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toOpenApiPath } from '@thali/service-kit';
import { bearer, createHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('openapi');
});
afterAll(async () => h?.close());

describe('OpenAPI coverage', () => {
  it('every Express route is documented in /openapi.json', async () => {
    const doc = await request(h.app).get('/openapi.json');
    expect(doc.status).toBe(200);
    const routes = await request(h.app).get('/internal/routes').set(bearer(await h.internalToken('orders')));
    expect(routes.status).toBe(200);
    const missing = (routes.body as { method: string; path: string }[])
      .filter((r) => !r.path.startsWith('/docs'))
      .filter((r) => !doc.body.paths[toOpenApiPath(r.path)]?.[r.method.toLowerCase()])
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    expect(doc.body.paths['/internal/restaurants/{id}'].get.tags).toEqual(['internal']);
  });
});
