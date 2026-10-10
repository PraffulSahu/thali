import { Writable } from 'node:stream';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import {
  createApp,
  createLogger,
  createOpenApi,
  signServiceToken,
  validate,
  type CreateAppOptions,
} from '@thali/service-kit';
import { createTestConfig, testLogger } from '@thali/service-kit/testing';

const itemParams = z.object({ id: z.string().min(2) });
const qtyBody = z.object({ qty: z.number().int().positive() });
const vQty = validate({ body: qtyBody });

function build(overrides: Partial<CreateAppOptions> = {}, configOverrides: Record<string, unknown> = {}) {
  const config = createTestConfig({ SERVICE_NAME: 'orders', ...configOverrides });
  return createApp({
    config,
    logger: testLogger(),
    routes(app) {
      app.get('/boom/domain', () => {
        throw new DomainError('OUT_OF_STOCK', 'Item is out of stock', undefined, { itemId: 'i1' });
      });
      app.get('/boom/async', async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw new DomainError('NOT_FOUND', 'Order not found');
      });
      app.get('/boom/plain', () => {
        throw new Error('secret db detail at mongo://user:pw@host');
      });
      app.get('/boom/domain5xx', () => {
        throw new DomainError('SERVICE_UNAVAILABLE', 'redis at 10.0.0.5:6379 refused', undefined, { host: '10.0.0.5' });
      });
      app.get('/boom/version', () => {
        throw new mongoose.Error.VersionError({ _doc: { _id: 'x' } } as never, 1, ['status']);
      });
      app.get('/boom/zod', () => {
        qtyBody.parse({ qty: 'x' });
      });
      app.post('/qty', vQty, (req, res) => {
        const { body } = vQty.get(req);
        res.json({ doubled: body.qty * 2, valid: req.valid.body });
      });
      app.post('/raw', (req, res) => {
        res.json({ raw: req.rawBody?.toString('utf8') ?? null });
      });
      const r = express.Router();
      r.get('/items/:id', validate({ params: itemParams }), (req, res) => res.json(req.valid.params));
      r.post('/items', (_req, res) => res.status(201).json({}));
      app.use('/api/v1/things', r);
    },
    ...overrides,
  });
}

describe('createApp: health', () => {
  it('GET /health/live → 200 {status:ok}', async () => {
    const res = await request(build()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready → 503 when a check fails', async () => {
    const app = build({
      healthChecks: {
        mongo: async () => {
          throw new Error('no primary');
        },
        redis: async () => 'PONG',
      },
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { mongo: 'down', redis: 'up' } });
  });

  it('GET /health/ready → 200 when all checks pass (and treats a hanging check as down)', async () => {
    const ok = await request(build({ healthChecks: { mongo: async () => true } })).get('/health/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ok', checks: { mongo: 'up' } });

    const hang = build({ healthChecks: { mongo: () => new Promise(() => {}) }, healthCheckTimeoutMs: 50 });
    const res = await request(hang).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ mongo: 'down' });
  });
});

describe('createApp: error envelope', () => {
  it('DomainError → status + envelope with requestId equal to x-request-id', async () => {
    const res = await request(build()).get('/boom/domain');
    expect(res.status).toBe(409);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body).toEqual({
      error: {
        code: 'OUT_OF_STOCK',
        message: 'Item is out of stock',
        details: { itemId: 'i1' },
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('async handler rejection reaches the error handler', async () => {
    const res = await request(build()).get('/boom/async');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('ZodError → 400 VALIDATION_FAILED with details.issues', async () => {
    const res = await request(build()).get('/boom/zod');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues).toEqual([expect.objectContaining({ path: 'qty', code: 'invalid_type' })]);
  });

  it('validate() rejects bad bodies and exposes typed parsed values', async () => {
    const app = build();
    const bad = await request(app).post('/qty').send({ qty: -1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.issues[0].path).toBe('body.qty');

    const ok = await request(app).post('/qty').send({ qty: 4, extra: 'stripped' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ doubled: 8, valid: { qty: 4 } });

    const params = await request(app).get('/api/v1/things/items/a');
    expect(params.status).toBe(400);
    expect(params.body.error.details.issues[0].path).toBe('params.id');
  });

  it('unknown route → 404 NOT_FOUND envelope', async () => {
    const res = await request(build()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: res.headers['x-request-id'] });
  });

  it('preserves a valid inbound x-request-id and replaces an invalid one', async () => {
    const app = build();
    const res = await request(app).get('/boom/domain').set('x-request-id', 'gw-abc_123.4');
    expect(res.headers['x-request-id']).toBe('gw-abc_123.4');
    expect(res.body.error.requestId).toBe('gw-abc_123.4');

    const bad = await request(app).get('/health/live').set('x-request-id', 'has spaces <script>');
    expect(bad.headers['x-request-id']).not.toBe('has spaces <script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('body > 1 MB → 413 PAYLOAD_TOO_LARGE envelope', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) });
    const res = await request(build()).post('/qty').set('content-type', 'application/json').send(big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('malformed JSON → 400 VALIDATION_FAILED', async () => {
    const res = await request(build()).post('/qty').set('content-type', 'application/json').send('{"qty":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('mongoose VersionError → 409 CONCURRENT_MODIFICATION', async () => {
    const res = await request(build()).get('/boom/version');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_MODIFICATION');
  });

  it('NODE_ENV=production: unknown 5xx → generic message, no stack, no internals', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await request(build()).get('/boom/plain');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: res.headers['x-request-id'],
    });
    expect(res.text).not.toMatch(/stack|secret db detail|mongo:\/\/|at .*\.ts/);
  });

  it('APP_MODE=production hides internals even when NODE_ENV=test', async () => {
    const res = await request(build({}, { APP_MODE: 'production' })).get('/boom/plain');
    expect(res.body.error.message).toBe('Internal server error');
    expect(res.text).not.toMatch(/secret db detail/);
  });

  it('NODE_ENV=production: DomainError 5xx uses the generic message for its code and drops details', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await request(build()).get('/boom/domain5xx');
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable',
      requestId: res.headers['x-request-id'],
    });
  });

  it('NODE_ENV=test (dev/test, non-production mode): 500 shows the message but still no stack', async () => {
    const res = await request(build()).get('/boom/plain');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toMatch(/secret db detail/);
    expect(res.text).not.toMatch(/"stack"|app\.test\.ts/);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createApp: middleware', () => {
  it('uses config.TRUST_PROXY (default loopback)', () => {
    expect(build().get('trust proxy')).toBe('loopback');
    expect(build({}, { TRUST_PROXY: 1 }).get('trust proxy')).toBe(1);
  });

  it('captures the exact raw JSON body bytes on req.rawBody (webhook signatures)', async () => {
    const raw = '{ "a" :  1,\n  "b": [1, 2] }';
    const res = await request(build()).post('/raw').set('content-type', 'application/json').send(raw);
    expect(res.body.raw).toBe(raw);
  });

  it('bodyParser:false leaves the request stream untouched (gateway passthrough)', async () => {
    const app = createApp({
      config: createTestConfig(),
      logger: testLogger(),
      bodyParser: false,
      routes(a) {
        a.post('/stream', async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          res.json({ body: req.body ?? null, raw: Buffer.concat(chunks).toString('utf8') });
        });
      },
    });
    const raw = '{ "x" : 1 }';
    const res = await request(app).post('/stream').set('content-type', 'application/json').send(raw);
    expect(res.body).toEqual({ body: null, raw });
  });

  it('applies helmet headers and hides x-powered-by', async () => {
    const res = await request(build()).get('/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS allows configured origins with credentials only', async () => {
    const app = build({}, { CORS_ORIGINS: ['http://localhost:5173'] });
    const ok = await request(app).get('/health/live').set('origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const no = await request(app).get('/health/live').set('origin', 'http://evil.example');
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('createApp: openapi, docs, route introspection', () => {
  function withOpenApi(docs: boolean) {
    const openapi = createOpenApi('orders');
    openapi.route({
      method: 'get',
      path: '/api/v1/things/items/:id',
      summary: 'Get item',
      request: { params: itemParams },
      responses: { 200: { description: 'Item', content: { 'application/json': { schema: itemParams } } } },
    });
    return build({ openapi }, { DOCS_ENABLED: docs });
  }

  it('serves /openapi.json including kit and registered routes', async () => {
    const res = await request(withOpenApi(false)).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toMatch(/orders/);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready', '/api/v1/things/items/{id}']),
    );
  });

  it('mounts Swagger UI at /docs only when DOCS_ENABLED', async () => {
    const on = await request(withOpenApi(true)).get('/docs/');
    expect(on.status).toBe(200);
    expect(on.text).toMatch(/swagger-ui/i);
    const off = await request(withOpenApi(false)).get('/docs/');
    expect(off.status).toBe(404);
  });

  it('GET /internal/routes requires a service token and lists every route', async () => {
    const app = build();
    const anon = await request(app).get('/internal/routes');
    expect(anon.status).toBe(401);

    const cfg = createTestConfig();
    const token = await signServiceToken('gateway', 'orders', cfg.INTERNAL_SERVICE_SECRET);
    const res = await request(app).get('/internal/routes').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/health/live' },
        { method: 'GET', path: '/health/ready' },
        { method: 'GET', path: '/openapi.json' },
        { method: 'GET', path: '/internal/routes' },
        { method: 'POST', path: '/qty' },
        { method: 'GET', path: '/api/v1/things/items/:id' },
        { method: 'POST', path: '/api/v1/things/items' },
      ]),
    );
  });
});

describe('createLogger', () => {
  it('redacts LLD 5.5 paths', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger('orders', { level: 'info', destination: sink });
    logger.info(
      {
        req: { headers: { authorization: 'Bearer SECRET_A', cookie: 'thali_rt=SECRET_B' } },
        res: { headers: { 'set-cookie': 'thali_rt=SECRET_C' } },
        body: {
          password: 'SECRET_D',
          code: 'SECRET_E',
          otp: 'SECRET_F',
          token: 'SECRET_G',
          refreshToken: 'SECRET_H',
          accountNumber: 'SECRET_I',
          totpSecret: 'SECRET_J',
        },
      },
      'hello',
    );
    const out = lines.join('');
    expect(out).toMatch(/"service":"orders"/);
    expect(out).toMatch(/\[Redacted\]/);
    expect(out).not.toMatch(/SECRET_/);
  });
});
