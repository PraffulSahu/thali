import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signServiceToken, toOpenApiPath } from '@thali/service-kit';
import { TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('openapi');
});
afterAll(async () => {
  await h?.close();
});

describe('OpenAPI coverage', () => {
  it('every mounted route is documented in /openapi.json', async () => {
    const doc = await request(h.app).get('/openapi.json');
    expect(doc.status).toBe(200);
    const token = await signServiceToken('gateway', 'identity', TEST_INTERNAL_SERVICE_SECRET);
    const routes = await request(h.app).get('/internal/routes').set('authorization', `Bearer ${token}`);
    expect(routes.status).toBe(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    const missing = (routes.body as { method: string; path: string }[]).filter((r) => !paths[toOpenApiPath(r.path)]?.[r.method.toLowerCase()]);
    expect(missing).toEqual([]);
    for (const p of ['/api/v1/auth/admin/password/forgot', '/api/v1/auth/admin/password/reset', '/api/v1/me/uploads']) {
      expect(paths[p]?.post, p).toBeDefined();
    }
  });
});
