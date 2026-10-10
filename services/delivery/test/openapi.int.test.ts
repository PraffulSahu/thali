import request from 'supertest';
import { listRoutes, toOpenApiPath } from '@thali/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Harness } from './helpers.js';

describe('OpenAPI coverage', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('openapi');
  });
  afterAll(async () => h.cleanup());

  it('every mounted route is documented in /openapi.json', async () => {
    const doc = (await request(h.app).get('/openapi.json')).body as { paths: Record<string, Record<string, unknown>> };
    const missing = listRoutes(h.app)
      .filter((r) => !r.path.startsWith('/docs'))
      .filter((r) => !doc.paths[toOpenApiPath(r.path)]?.[r.method.toLowerCase()])
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    expect(Object.keys(doc.paths)).toContain('/api/v1/deliveries/offers/{offerId}/accept');
  });
});
