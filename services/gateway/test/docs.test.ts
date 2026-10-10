import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { testLogger } from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { deadUrl, SERVICES, startUpstream, testGatewayConfig, type Upstream } from './helpers.js';

const upstreams: Upstream[] = [];
let urls: Record<string, string>;

beforeAll(async () => {
  for (const s of SERVICES) {
    upstreams.push(
      await startUpstream(s, (req, res) => {
        if (req.url === '/openapi.json') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              openapi: '3.1.0',
              info: { title: `Thali ${s} API`, version: '1.0.0' },
              paths: {
                [`/api/v1/${s}-thing`]: { get: { responses: { '200': { description: 'ok' } } } },
                '/internal/secret': { get: { responses: { '200': { description: 'internal' } } } },
                '/health/live': { get: { responses: { '200': { description: 'live' } } } },
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end();
      }),
    );
  }
  urls = Object.fromEntries(upstreams.map((u) => [u.name, u.url]));
});
afterAll(async () => {
  await Promise.all(upstreams.map((u) => u.close()));
});

const appWith = (docs: boolean, overrides: Record<string, string> = {}) =>
  buildApp({ config: testGatewayConfig(urls, { DOCS_ENABLED: String(docs), ...overrides }), logger: testLogger('gateway') });

describe('/api/docs', () => {
  it('disabled (default) -> 404 for the UI and the specs', async () => {
    const app = appWith(false);
    expect((await request(app).get('/api/docs')).status).toBe(404);
    expect((await request(app).get('/api/docs/')).status).toBe(404);
    const spec = await request(app).get('/api/docs/specs/identity.json');
    expect(spec.status).toBe(404);
    expect(spec.body.error.code).toBe('NOT_FOUND');
  });

  it('enabled -> HTML that lists all 6 service spec URLs (+ gateway)', async () => {
    const app = appWith(true);
    const redirect = await request(app).get('/api/docs');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe('/api/docs/');
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    for (const s of SERVICES) expect(res.text).toContain(`/api/docs/specs/${s}.json`);
    expect(res.text).toContain('/api/docs/specs/gateway.json');
    // the Swagger UI bootstrap script carries the same list as the explorer `urls`
    const init = await request(app).get('/api/docs/swagger-ui-init.js');
    expect(init.status).toBe(200);
    for (const s of SERVICES) expect(init.text).toContain(`/api/docs/specs/${s}.json`);
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('proxies each service /openapi.json, dropping internal/health paths', async () => {
    const app = appWith(true);
    for (const s of SERVICES) {
      const res = await request(app).get(`/api/docs/specs/${s}.json`);
      expect(res.status, s).toBe(200);
      expect(res.body.info.title).toBe(`Thali ${s} API`);
      expect(Object.keys(res.body.paths)).toEqual([`/api/v1/${s}-thing`]);
    }
  });

  it('serves the gateway own spec', async () => {
    const res = await request(appWith(true)).get('/api/docs/specs/gateway.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/api/v1/meta', '/api/v1/admin/health']));
  });

  it('unknown service -> 404, unreachable service -> 502 envelope', async () => {
    const app = appWith(true);
    expect((await request(app).get('/api/docs/specs/nope.json')).status).toBe(404);
    const down = buildApp({
      config: testGatewayConfig({ ...urls, payments: await deadUrl() }, { DOCS_ENABLED: 'true' }),
      logger: testLogger('gateway'),
    });
    const res = await request(down).get('/api/docs/specs/payments.json');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
