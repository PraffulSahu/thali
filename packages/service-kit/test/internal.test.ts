import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeJwt, SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import {
  createApp,
  internalClient,
  requireInternal,
  signServiceToken,
  UpstreamError,
  verifyServiceToken,
} from '@thali/service-kit';
import { createTestConfig, generateTestKeys, testLogger } from '@thali/service-kit/testing';

const cfg = createTestConfig({ SERVICE_NAME: 'payments' });
const secret = cfg.INTERNAL_SERVICE_SECRET;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

let flakyCalls = 0;
let postCalls = 0;

const payments = createApp({
  config: cfg,
  logger: testLogger(),
  routes(app) {
    app.post('/internal/ping', requireInternal(['orders']), (req, res) => res.json({ caller: req.caller }));
    app.get('/internal/any', requireInternal(), (req, res) => res.json({ caller: req.caller }));
    app.get('/internal/echo', requireInternal(), (req, res) =>
      res.json({ requestId: req.header('x-request-id'), caller: req.caller, q: req.query }),
    );
    app.get('/internal/slow', requireInternal(), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 400));
      res.json({ late: true });
    });
    app.get('/internal/fail', requireInternal(), () => {
      throw new DomainError('OUT_OF_STOCK', 'Item 7 out of stock', undefined, { itemId: '7' });
    });
    app.get('/internal/flaky', requireInternal(), (_req, res) => {
      flakyCalls += 1;
      if (flakyCalls === 1) throw new DomainError('SERVICE_UNAVAILABLE', 'warming up');
      res.json({ calls: flakyCalls });
    });
    app.post('/internal/post-fail', requireInternal(), () => {
      postCalls += 1;
      throw new DomainError('SERVICE_UNAVAILABLE', 'down');
    });
    app.post('/internal/created', requireInternal(), (req, res) => res.status(201).json({ got: req.body }));
    app.delete('/internal/nothing', requireInternal(), (_req, res) => res.status(204).end());
    app.get('/internal/delivery-only', requireInternal(['delivery']), (_req, res) => res.json({}));
    app.get('/internal/partner', requireInternal(), () => {
      throw new DomainError('PARTNER_NOT_APPROVED', 'Partner not approved');
    });
    app.get('/internal/html', requireInternal(), (_req, res) => res.status(500).send('<html>oops</html>'));
  },
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = payments.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('service tokens + requireInternal', () => {
  it('signServiceToken: HS256, iss=caller, aud=callee, 60 s', async () => {
    const t = await signServiceToken('orders', 'payments', secret);
    const claims = decodeJwt(t);
    expect(claims.iss).toBe('orders');
    expect(claims.aud).toBe('payments');
    expect(claims.exp! - claims.iat!).toBe(60);
    await expect(verifyServiceToken(t, { secret, audience: 'payments' })).resolves.toEqual({ service: 'orders' });
  });

  it('orders → payments token is accepted by requireInternal([orders])', async () => {
    const res = await request(payments)
      .post('/internal/ping')
      .set(bearer(await signServiceToken('orders', 'payments', secret)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ caller: { service: 'orders' } });
  });

  it('wrong audience → 401', async () => {
    const res = await request(payments)
      .post('/internal/ping')
      .set(bearer(await signServiceToken('orders', 'marketplace', secret)));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('expired (issued 61 s ago) → 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('orders')
      .setAudience('payments')
      .setIssuedAt(now - 61)
      .setExpirationTime(now - 1)
      .sign(new TextEncoder().encode(secret));
    const res = await request(payments).post('/internal/ping').set(bearer(t));
    expect(res.status).toBe(401);
  });

  it('a token with a lifetime over 60 s → 401', async () => {
    const res = await request(payments)
      .post('/internal/ping')
      .set(bearer(await signServiceToken('orders', 'payments', secret, { ttlSec: 3600 })));
    expect(res.status).toBe(401);
  });

  it('caller not in allow-list → 403 FORBIDDEN', async () => {
    const res = await request(payments)
      .post('/internal/ping')
      .set(bearer(await signServiceToken('delivery', 'payments', secret)));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('wrong secret, unknown issuer, user token or no token → 401', async () => {
    const keys = await generateTestKeys();
    const now = Math.floor(Date.now() / 1000);
    const unknownIss = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('evil')
      .setAudience('payments')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(secret));
    const tokens = [
      await signServiceToken('orders', 'payments', 'x'.repeat(40)),
      unknownIss,
      await keys.sign({ roles: ['ADMIN'] }),
    ];
    for (const t of tokens) {
      const res = await request(payments).post('/internal/ping').set(bearer(t));
      expect(res.status).toBe(401);
    }
    expect((await request(payments).post('/internal/ping')).status).toBe(401);
  });

  it('requireInternal() without a list accepts any service', async () => {
    const res = await request(payments)
      .get('/internal/any')
      .set(bearer(await signServiceToken('notifications', 'payments', secret)));
    expect(res.body).toEqual({ caller: { service: 'notifications' } });
  });
});

describe('internalClient', () => {
  const client = () => internalClient('payments', baseUrl, { from: 'orders', secret, timeoutMs: 150 });

  it('signs a service token and sets x-request-id', async () => {
    const out = await client().get<{ requestId: string; caller: unknown; q: unknown }>('/internal/echo', {
      requestId: 'req-123',
      query: { a: '1', b: 2 },
    });
    expect(out).toEqual({ requestId: 'req-123', caller: { service: 'orders' }, q: { a: '1', b: '2' } });

    const gen = await client().get<{ requestId: string }>('/internal/echo');
    expect(gen.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates the inbound request id automatically inside a request', async () => {
    const orders = createApp({
      config: createTestConfig({ SERVICE_NAME: 'orders' }),
      logger: testLogger(),
      routes(app) {
        app.get('/relay', async (_req, res) => {
          await new Promise((r) => setTimeout(r, 5));
          res.json(await client().get('/internal/echo'));
        });
      },
    });
    const res = await request(orders).get('/relay').set('x-request-id', 'inbound-77');
    expect(res.body.requestId).toBe('inbound-77');
  });

  it('validates the response with an optional zod schema', async () => {
    const out = await client().post('/internal/created', { n: 1 }, { schema: z.object({ got: z.object({ n: z.number() }) }) });
    expect(out.got.n).toBe(1);
    await expect(client().post('/internal/created', { n: 1 }, { schema: z.object({ nope: z.string() }) })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('returns undefined for 204', async () => {
    await expect(client().delete('/internal/nothing')).resolves.toBeUndefined();
  });

  it('aborts after the timeout with DomainError UPSTREAM_TIMEOUT (504)', async () => {
    const started = Date.now();
    const err = await client()
      .get('/internal/slow', { retries: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'UPSTREAM_TIMEOUT', httpStatus: 504 });
    expect(Date.now() - started).toBeLessThan(380);
  });

  it('maps an upstream error envelope into a DomainError preserving code, status and details', async () => {
    const err = (await client()
      .get('/internal/fail')
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.code).toBe('OUT_OF_STOCK');
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe('Item 7 out of stock');
    expect(err.details).toEqual({ itemId: '7' });
    expect(err.target).toBe('payments');
    expect(err.upstreamStatus).toBe(409);
  });

  it('retries GET on 503 but never retries POST', async () => {
    flakyCalls = 0;
    await expect(client().get('/internal/flaky')).resolves.toEqual({ calls: 2 });
    postCalls = 0;
    await expect(client().post('/internal/post-fail', {})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(postCalls).toBe(1);
  });

  it('non-envelope upstream errors → UPSTREAM_ERROR 502', async () => {
    await expect(client().get('/internal/html', { retries: 0 })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      httpStatus: 502,
    });
  });

  it('connection refused → UPSTREAM_UNAVAILABLE 502', async () => {
    const dead = internalClient('payments', 'http://127.0.0.1:1', { from: 'orders', secret, timeoutMs: 500 });
    await expect(dead.get('/internal/echo', { retries: 0 })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      httpStatus: 502,
    });
  });

  it('upstream 401/403 auth failures (bad service token, caller not allowed) → 502 UPSTREAM_ERROR', async () => {
    const forbidden = await client()
      .get('/internal/delivery-only')
      .catch((e: unknown) => e);
    expect(forbidden).toMatchObject({ code: 'UPSTREAM_ERROR', httpStatus: 502, upstreamStatus: 403 });
    expect((forbidden as UpstreamError).details).toMatchObject({ target: 'payments', upstreamCode: 'FORBIDDEN' });

    const wrongSecret = internalClient('payments', baseUrl, { from: 'orders', secret: 'w'.repeat(40) });
    await expect(wrongSecret.get('/internal/echo')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      httpStatus: 502,
      upstreamStatus: 401,
    });
  });

  it('business 403 codes from upstream are preserved', async () => {
    await expect(client().get('/internal/partner')).rejects.toMatchObject({ code: 'PARTNER_NOT_APPROVED', httpStatus: 403 });
  });
});
